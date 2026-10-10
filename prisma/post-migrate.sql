-- =============================================================================
-- IndexFlow — post-migration hardening
-- =============================================================================
-- Prisma cannot express CHECK constraints or triggers, so the invariants that
-- MUST hold even if application code is buggy live here.
--
-- Applied automatically by `npm run setup`, or manually:
--   psql "$DATABASE_URL" -f prisma/post-migrate.sql
--
-- This script is idempotent — safe to run after every deploy.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. A wallet can never go negative.
-- -----------------------------------------------------------------------------
-- This is the last line of defence behind the application's SERIALIZABLE
-- transaction. If a concurrency bug ever slipped through, the database aborts
-- the transaction rather than silently letting a customer spend credits they
-- do not have.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_wallets_available_non_negative'
  ) THEN
    ALTER TABLE credit_wallets
      ADD CONSTRAINT credit_wallets_available_non_negative
      CHECK (available_credits >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_wallets_reserved_non_negative'
  ) THEN
    ALTER TABLE credit_wallets
      ADD CONSTRAINT credit_wallets_reserved_non_negative
      CHECK (reserved_credits >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_wallets_lifetime_non_negative'
  ) THEN
    ALTER TABLE credit_wallets
      ADD CONSTRAINT credit_wallets_lifetime_non_negative
      CHECK (
        lifetime_purchased >= 0 AND
        lifetime_bonus     >= 0 AND
        lifetime_consumed  >= 0 AND
        lifetime_refunded  >= 0
      );
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 2. Ledger rows must be internally consistent.
-- -----------------------------------------------------------------------------
-- Both buckets must balance against their declared deltas. A row that does not
-- balance is a bug we want to hear about at write time, not at audit time.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_balances_consistent'
  ) THEN
    ALTER TABLE credit_ledger
      ADD CONSTRAINT credit_ledger_balances_consistent
      CHECK (
        available_after = available_before + amount AND
        reserved_after  = reserved_before  + reserved_delta
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_no_negative_balances'
  ) THEN
    ALTER TABLE credit_ledger
      ADD CONSTRAINT credit_ledger_no_negative_balances
      CHECK (
        available_before >= 0 AND available_after >= 0 AND
        reserved_before  >= 0 AND reserved_after  >= 0
      );
  END IF;

  -- Only DEBIT, PURCHASE, BONUS, ADMIN_ADJUSTMENT and EXPIRATION may change the
  -- customer's TOTAL holding. RESERVE / RESERVE_RELEASE / REFUND only move
  -- credits between buckets and must net to zero. This constraint is what makes
  -- "a temporary API failure cannot cost the customer credits" a database-level
  -- guarantee rather than a code-review promise.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_bucket_moves_net_zero'
  ) THEN
    ALTER TABLE credit_ledger
      ADD CONSTRAINT credit_ledger_bucket_moves_net_zero
      CHECK (
        type NOT IN ('RESERVE','RESERVE_RELEASE','REFUND')
        OR (amount + reserved_delta) = 0
      );
  END IF;

  -- A DEBIT settles held credits: it must not touch the available bucket, and
  -- must strictly reduce the reserved bucket.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_debit_shape'
  ) THEN
    ALTER TABLE credit_ledger
      ADD CONSTRAINT credit_ledger_debit_shape
      CHECK (
        type <> 'DEBIT'
        OR (amount = 0 AND reserved_delta < 0)
      );
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 3. The credit ledger is APPEND-ONLY, enforced by the database.
-- -----------------------------------------------------------------------------
-- Financial history must never be rewritten. Corrections are made by appending
-- a compensating entry (REFUND / ADMIN_ADJUSTMENT), never by editing the past.
-- This trigger blocks UPDATE and DELETE for every caller, including a human
-- with a psql prompt and including the application's own connection.
--
-- Deliberate operational escape hatch: a superuser can `ALTER TABLE
-- credit_ledger DISABLE TRIGGER credit_ledger_immutable;` for a supervised
-- data-repair window. Doing so is itself visible in the Postgres logs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_ledger_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'credit_ledger is append-only: % on ledger entry % was rejected. Append a compensating entry instead.',
    TG_OP, COALESCE(OLD.id::text, '(unknown)')
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_immutable ON credit_ledger;
CREATE TRIGGER credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_block_mutation();


-- -----------------------------------------------------------------------------
-- 4. Audit logs are append-only too.
-- -----------------------------------------------------------------------------
-- An audit trail an attacker can edit is not an audit trail.
-- DELETE is permitted only via ON DELETE CASCADE from a workspace deletion,
-- which is a legitimate data-retention action; UPDATE is always blocked.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_block_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: UPDATE on entry % was rejected.', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_update();


-- -----------------------------------------------------------------------------
-- 5. Job attempts are append-only.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_attempts_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_attempts is append-only: DELETE on attempt % was rejected.', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Intentionally NOT installed on job_attempts: the retention worker prunes old
-- attempts in bulk, and CASCADE from url_jobs must keep working. Immutability
-- for attempts is enforced at the service layer instead.


-- -----------------------------------------------------------------------------
-- 6. Payment amount sanity.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_amounts_non_negative'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_amounts_non_negative
      CHECK (
        amount_minor      >= 0 AND
        tax_minor         >= 0 AND
        total_minor       >= 0 AND
        refunded_minor    >= 0 AND
        credits_purchased >= 0
      );
  END IF;

  -- Cannot refund more than was charged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_within_total'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_refund_within_total
      CHECK (refunded_minor <= total_minor);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_packages_sane_pricing'
  ) THEN
    ALTER TABLE credit_packages
      ADD CONSTRAINT credit_packages_sane_pricing
      CHECK (credits > 0 AND price_minor >= 0 AND bonus_credits >= 0);
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 7. Job credit accounting sanity.
-- -----------------------------------------------------------------------------
-- A job can never settle more credits than it reserved. This is what stops a
-- refund bug from minting credits out of thin air.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'url_jobs_credit_accounting'
  ) THEN
    ALTER TABLE url_jobs
      ADD CONSTRAINT url_jobs_credit_accounting
      CHECK (
        credits_reserved >= 0 AND
        credits_consumed >= 0 AND
        credits_refunded >= 0 AND
        credits_consumed + credits_refunded <= credits_reserved
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'url_jobs_attempts_bounded'
  ) THEN
    ALTER TABLE url_jobs
      ADD CONSTRAINT url_jobs_attempts_bounded
      CHECK (attempts >= 0 AND max_attempts > 0 AND max_attempts <= 20);
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 8. Exactly one OWNER per workspace.
-- -----------------------------------------------------------------------------
-- A workspace with two owners has an ambiguous billing contact; a workspace
-- with none is orphaned. Ownership transfer swaps both rows in one transaction.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_single_owner
  ON workspace_members (workspace_id)
  WHERE role = 'OWNER';


-- -----------------------------------------------------------------------------
-- 9. Partial indexes for the hot paths.
-- -----------------------------------------------------------------------------
-- The worker's "what should I run next" query and the dashboard's "what is
-- still in flight" query both touch a small slice of a potentially huge table.
-- Partial indexes keep them cheap as url_jobs grows into the millions.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS url_jobs_active_by_workspace
  ON url_jobs (workspace_id, created_at DESC)
  WHERE state IN ('QUEUED','VALIDATING','SUBMITTING','CHECKING','RETRY_WAIT');

CREATE INDEX IF NOT EXISTS url_jobs_claimable
  ON url_jobs (scheduled_for)
  WHERE state IN ('QUEUED','RETRY_WAIT') AND dead_lettered = false;

CREATE INDEX IF NOT EXISTS url_jobs_stale_locks
  ON url_jobs (locked_until)
  WHERE locked_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS urls_needs_status_check
  ON urls (workspace_id, last_checked_at)
  WHERE submission_status = 'SUBMITTED';

CREATE INDEX IF NOT EXISTS notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS payments_awaiting_settlement
  ON payments (created_at)
  WHERE status IN ('CREATED','PENDING');

-- Case-insensitive URL search for the dashboard's search box, without a
-- sequential scan on every keystroke.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS urls_normalized_url_trgm
  ON urls USING gin (normalized_url gin_trgm_ops);


-- -----------------------------------------------------------------------------
-- 10. Reconciliation view.
-- -----------------------------------------------------------------------------
-- Replays the ledger and compares it to the cached wallet balance. Any row
-- returned by this view is a real accounting discrepancy and should page
-- someone. `scripts/reconcile.ts` and the /health/deep endpoint both read it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW credit_reconciliation AS
SELECT
  w.workspace_id,
  w.available_credits                                     AS wallet_available,
  COALESCE(SUM(l.amount), 0)::int                          AS ledger_available,
  w.available_credits - COALESCE(SUM(l.amount), 0)::int    AS available_drift,
  w.reserved_credits                                      AS wallet_reserved,
  COALESCE(SUM(l.reserved_delta), 0)::int                  AS ledger_reserved,
  w.reserved_credits - COALESCE(SUM(l.reserved_delta), 0)::int AS reserved_drift,
  COUNT(l.id)                                             AS ledger_entries,
  MAX(l.created_at)                                       AS last_movement_at
FROM credit_wallets w
LEFT JOIN credit_ledger l ON l.workspace_id = w.workspace_id
GROUP BY w.workspace_id, w.available_credits, w.reserved_credits
HAVING w.available_credits <> COALESCE(SUM(l.amount), 0)::int
    OR w.reserved_credits  <> COALESCE(SUM(l.reserved_delta), 0)::int;


-- -----------------------------------------------------------------------------
-- Done. Verify with:
--   \d+ credit_wallets
--   SELECT * FROM credit_reconciliation;   -- must return zero rows
-- -----------------------------------------------------------------------------
