-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'SUPPORT_ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'INVALID_GRANT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('DOMAIN', 'URL_PREFIX');

-- CreateEnum
CREATE TYPE "PropertyPermission" AS ENUM ('SITE_OWNER', 'SITE_FULL_USER', 'SITE_RESTRICTED_USER', 'SITE_UNVERIFIED_USER', 'PERMISSION_UNSPECIFIED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('GENERIC', 'JOB_POSTING', 'BROADCAST_EVENT');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('PRECHECK', 'SUBMIT', 'STATUS_CHECK');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'CHECKING', 'INDEXED', 'NOT_INDEXED', 'ERROR', 'QUOTA_LIMITED', 'RETRY_WAIT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'SUBMITTED', 'NOT_ELIGIBLE', 'FAILED');

-- CreateEnum
CREATE TYPE "IndexStatus" AS ENUM ('UNKNOWN', 'INDEXED', 'NOT_INDEXED', 'CRAWLED_NOT_INDEXED', 'DISCOVERED_NOT_INDEXED', 'EXCLUDED_BY_NOINDEX', 'EXCLUDED_BY_ROBOTS', 'BLOCKED_BY_CANONICAL', 'FETCH_ERROR', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "CreditTxnType" AS ENUM ('PURCHASE', 'BONUS', 'RESERVE', 'DEBIT', 'REFUND', 'RESERVE_RELEASE', 'ADMIN_ADJUSTMENT', 'EXPIRATION');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'INVALID_SIGNATURE', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'PAUSED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ROTATING');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'WORKSPACE_INVITE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('WELCOME', 'EMAIL_VERIFICATION', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'CREDITS_LOW', 'CREDITS_EXHAUSTED', 'BATCH_COMPLETED', 'BATCH_FAILED', 'PROPERTY_DISCONNECTED', 'QUOTA_LIMITED', 'SECURITY_ALERT');

-- CreateEnum
CREATE TYPE "BatchSource" AS ENUM ('MANUAL', 'BULK_PASTE', 'CSV_UPLOAD', 'TXT_UPLOAD', 'SITEMAP', 'API');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'IMPORTING', 'READY', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_normalized" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(512),
    "name" VARCHAR(160),
    "avatar_url" VARCHAR(1024),
    "email_verified_at" TIMESTAMP(3),
    "platform_role" "PlatformRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "session_epoch" INTEGER NOT NULL DEFAULT 1,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" VARCHAR(64),
    "notify_payment_events" BOOLEAN NOT NULL DEFAULT true,
    "notify_credit_alerts" BOOLEAN NOT NULL DEFAULT true,
    "notify_batch_events" BOOLEAN NOT NULL DEFAULT true,
    "notify_product_updates" BOOLEAN NOT NULL DEFAULT false,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "theme" VARCHAR(16) NOT NULL DEFAULT 'system',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "request_ip" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "owner_id" UUID NOT NULL,
    "logo_url" VARCHAR(1024),
    "website" VARCHAR(512),
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" VARCHAR(500),
    "max_bulk_urls" INTEGER,
    "max_daily_urls" INTEGER,
    "max_concurrent_jobs" INTEGER,
    "data_retention_days" INTEGER,
    "low_credit_threshold" INTEGER NOT NULL DEFAULT 100,
    "low_credit_notified_at" TIMESTAMP(3),
    "billing_email" VARCHAR(320),
    "billing_name" VARCHAR(200),
    "billing_address" TEXT,
    "tax_id" VARCHAR(64),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "invited_by_id" UUID,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "token_hash" VARCHAR(64) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL DEFAULT 'GOOGLE',
    "provider_account_id" VARCHAR(255) NOT NULL,
    "google_email" VARCHAR(320) NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_detail" VARCHAR(500),
    "last_verified_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_console_properties" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "site_url" VARCHAR(512) NOT NULL,
    "hostname" VARCHAR(255) NOT NULL,
    "type" "PropertyType" NOT NULL,
    "permission_level" "PropertyPermission" NOT NULL,
    "display_name" VARCHAR(200),
    "content_type" "ContentType" NOT NULL DEFAULT 'GENERIC',
    "indexing_api_enabled" BOOLEAN NOT NULL DEFAULT false,
    "indexing_api_confirmed_at" TIMESTAMP(3),
    "sitemap_url" VARCHAR(1024),
    "sitemap_last_submitted_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "robots_txt_fetched_at" TIMESTAMP(3),
    "robots_txt_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_console_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_quota_usage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "api_name" VARCHAR(64) NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "quota_error_count" INTEGER NOT NULL DEFAULT 0,
    "other_error_count" INTEGER NOT NULL DEFAULT 0,
    "last_quota_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_quota_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "urls" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "property_id" UUID,
    "batch_id" UUID,
    "raw_url" VARCHAR(2048) NOT NULL,
    "normalized_url" VARCHAR(2048) NOT NULL,
    "hostname" VARCHAR(255) NOT NULL,
    "pathname" VARCHAR(1024) NOT NULL,
    "content_type" "ContentType" NOT NULL DEFAULT 'GENERIC',
    "submission_status" "SubmissionStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "submitted_at" TIMESTAMP(3),
    "submission_method" VARCHAR(64),
    "index_status" "IndexStatus" NOT NULL DEFAULT 'UNKNOWN',
    "index_verdict" VARCHAR(64),
    "coverage_state" VARCHAR(255),
    "last_checked_at" TIMESTAMP(3),
    "last_crawled_at" TIMESTAMP(3),
    "google_canonical" VARCHAR(2048),
    "user_canonical" VARCHAR(2048),
    "robots_txt_state" VARCHAR(64),
    "indexing_state" VARCHAR(64),
    "page_fetch_state" VARCHAR(64),
    "mobile_usability" VARCHAR(64),
    "rich_results_verdict" VARCHAR(64),
    "prechecked_at" TIMESTAMP(3),
    "http_status" INTEGER,
    "final_url" VARCHAR(2048),
    "redirect_count" INTEGER,
    "is_https" BOOLEAN,
    "robots_allowed" BOOLEAN,
    "meta_robots" VARCHAR(255),
    "x_robots_tag" VARCHAR(255),
    "content_type_header" VARCHAR(128),
    "precheck_warnings" JSONB,
    "last_error" VARCHAR(1000),
    "last_error_code" VARCHAR(64),
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "job_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_batches" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "property_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "source" "BatchSource" NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "job_type" "JobType" NOT NULL DEFAULT 'SUBMIT',
    "submitted_count" INTEGER NOT NULL DEFAULT 0,
    "valid_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "total_jobs" INTEGER NOT NULL DEFAULT 0,
    "processed_jobs" INTEGER NOT NULL DEFAULT 0,
    "success_jobs" INTEGER NOT NULL DEFAULT 0,
    "failed_jobs" INTEGER NOT NULL DEFAULT 0,
    "estimated_credits" INTEGER NOT NULL DEFAULT 0,
    "reserved_credits" INTEGER NOT NULL DEFAULT 0,
    "consumed_credits" INTEGER NOT NULL DEFAULT 0,
    "refunded_credits" INTEGER NOT NULL DEFAULT 0,
    "source_filename" VARCHAR(255),
    "source_sitemap" VARCHAR(1024),
    "rejection_sample" JSONB,
    "error_message" VARCHAR(1000),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "url_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "url_id" UUID NOT NULL,
    "property_id" UUID,
    "batch_id" UUID,
    "jobType" "JobType" NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "credits_reserved" INTEGER NOT NULL DEFAULT 0,
    "credits_consumed" INTEGER NOT NULL DEFAULT 0,
    "credits_refunded" INTEGER NOT NULL DEFAULT 0,
    "locked_by" VARCHAR(128),
    "locked_until" TIMESTAMP(3),
    "queue_job_id" VARCHAR(128),
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(1000),
    "dead_lettered" BOOLEAN NOT NULL DEFAULT false,
    "dead_lettered_at" TIMESTAMP(3),
    "provider_response" JSONB,
    "created_by_id" UUID,
    "api_key_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "url_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "outcome" VARCHAR(32) NOT NULL,
    "http_status" INTEGER,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(1000),
    "worker_id" VARCHAR(128),

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_wallets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "available_credits" INTEGER NOT NULL DEFAULT 0,
    "reserved_credits" INTEGER NOT NULL DEFAULT 0,
    "lifetime_purchased" INTEGER NOT NULL DEFAULT 0,
    "lifetime_bonus" INTEGER NOT NULL DEFAULT 0,
    "lifetime_consumed" INTEGER NOT NULL DEFAULT 0,
    "lifetime_refunded" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" "CreditTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL DEFAULT 0,
    "available_before" INTEGER NOT NULL,
    "available_after" INTEGER NOT NULL,
    "reserved_before" INTEGER NOT NULL,
    "reserved_after" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "job_id" UUID,
    "batch_id" UUID,
    "payment_id" UUID,
    "user_id" UUID,
    "api_key_id" UUID,
    "admin_user_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_packages" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "credits" INTEGER NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "compare_at_minor" INTEGER,
    "bonus_credits" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "validity_days" INTEGER,
    "features" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "package_id" UUID,
    "reference" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(40) NOT NULL DEFAULT 'razorpay',
    "provider_order_id" VARCHAR(128) NOT NULL,
    "provider_payment_id" VARCHAR(128),
    "provider_signature" VARCHAR(256),
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amount_minor" INTEGER NOT NULL,
    "tax_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL,
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "credits_purchased" INTEGER NOT NULL,
    "credits_granted" BOOLEAN NOT NULL DEFAULT false,
    "credits_granted_at" TIMESTAMP(3),
    "method" VARCHAR(40),
    "failure_code" VARCHAR(64),
    "failure_reason" VARCHAR(500),
    "provider_meta" JSONB,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_ip" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhooks" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "event_id" VARCHAR(191) NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "signature_valid" BOOLEAN NOT NULL DEFAULT false,
    "payload_hash" VARCHAR(64) NOT NULL,
    "payload" JSONB,
    "related_payment_id" UUID,
    "workspace_id" UUID,
    "processed_at" TIMESTAMP(3),
    "processing_ms" INTEGER,
    "error_message" VARCHAR(1000),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_ip" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL DEFAULT 'razorpay',
    "provider_subscription_id" VARCHAR(128),
    "provider_plan_id" VARCHAR(128),
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "credits_per_cycle" INTEGER NOT NULL,
    "interval_unit" VARCHAR(16) NOT NULL DEFAULT 'month',
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "last_granted_cycle_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_id" VARCHAR(64) NOT NULL,
    "secret_hash" VARCHAR(64) NOT NULL,
    "secret_hint" VARCHAR(32) NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rate_limit_per_minute" INTEGER,
    "daily_request_limit" INTEGER,
    "daily_credit_limit" INTEGER,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" VARCHAR(64),
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "rotated_from_id" UUID,
    "grace_revoke_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_key_id" UUID,
    "method" VARCHAR(10) NOT NULL,
    "endpoint" VARCHAR(200) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "credits_spent" INTEGER NOT NULL DEFAULT 0,
    "request_id" VARCHAR(64),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(60),
    "target_id" VARCHAR(64),
    "summary" VARCHAR(500) NOT NULL,
    "changes" JSONB,
    "metadata" JSONB,
    "actor_is_admin" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "user_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "link_path" VARCHAR(300),
    "severity" VARCHAR(16) NOT NULL DEFAULT 'info',
    "read_at" TIMESTAMP(3),
    "email_sent_at" TIMESTAMP(3),
    "email_error" VARCHAR(500),
    "dedupe_key" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "category" VARCHAR(40) NOT NULL DEFAULT 'general',
    "description" VARCHAR(500),
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_platform_role_idx" ON "users"("platform_role");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- CreateIndex
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");

-- CreateIndex
CREATE INDEX "workspaces_created_at_idx" ON "workspaces"("created_at");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_role_idx" ON "workspace_members"("workspace_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_token_hash_key" ON "workspace_invites"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invites_expires_at_idx" ON "workspace_invites"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_workspace_id_email_key" ON "workspace_invites"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "oauth_connections_workspace_id_status_idx" ON "oauth_connections"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_connections_workspace_id_provider_provider_account_id_key" ON "oauth_connections"("workspace_id", "provider", "provider_account_id");

-- CreateIndex
CREATE INDEX "search_console_properties_workspace_id_is_active_idx" ON "search_console_properties"("workspace_id", "is_active");

-- CreateIndex
CREATE INDEX "search_console_properties_connection_id_idx" ON "search_console_properties"("connection_id");

-- CreateIndex
CREATE INDEX "search_console_properties_hostname_idx" ON "search_console_properties"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "search_console_properties_workspace_id_site_url_key" ON "search_console_properties"("workspace_id", "site_url");

-- CreateIndex
CREATE INDEX "google_quota_usage_workspace_id_usage_date_idx" ON "google_quota_usage"("workspace_id", "usage_date");

-- CreateIndex
CREATE UNIQUE INDEX "google_quota_usage_property_id_usage_date_api_name_key" ON "google_quota_usage"("property_id", "usage_date", "api_name");

-- CreateIndex
CREATE INDEX "urls_workspace_id_index_status_idx" ON "urls"("workspace_id", "index_status");

-- CreateIndex
CREATE INDEX "urls_workspace_id_submission_status_idx" ON "urls"("workspace_id", "submission_status");

-- CreateIndex
CREATE INDEX "urls_workspace_id_hostname_idx" ON "urls"("workspace_id", "hostname");

-- CreateIndex
CREATE INDEX "urls_workspace_id_created_at_idx" ON "urls"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "urls_property_id_index_status_idx" ON "urls"("property_id", "index_status");

-- CreateIndex
CREATE INDEX "urls_batch_id_idx" ON "urls"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "urls_workspace_id_normalized_url_key" ON "urls"("workspace_id", "normalized_url");

-- CreateIndex
CREATE INDEX "url_batches_workspace_id_status_idx" ON "url_batches"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "url_batches_workspace_id_created_at_idx" ON "url_batches"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "url_jobs_workspace_id_state_idx" ON "url_jobs"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "url_jobs_workspace_id_created_at_idx" ON "url_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "url_jobs_state_scheduled_for_idx" ON "url_jobs"("state", "scheduled_for");

-- CreateIndex
CREATE INDEX "url_jobs_url_id_idx" ON "url_jobs"("url_id");

-- CreateIndex
CREATE INDEX "url_jobs_batch_id_state_idx" ON "url_jobs"("batch_id", "state");

-- CreateIndex
CREATE INDEX "url_jobs_dead_lettered_idx" ON "url_jobs"("dead_lettered");

-- CreateIndex
CREATE UNIQUE INDEX "url_jobs_workspace_id_idempotency_key_key" ON "url_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_attempts_job_id_idx" ON "job_attempts"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_attempts_job_id_attempt_number_key" ON "job_attempts"("job_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_wallets_workspace_id_key" ON "credit_wallets"("workspace_id");

-- CreateIndex
CREATE INDEX "credit_ledger_workspace_id_created_at_idx" ON "credit_ledger"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_ledger_workspace_id_type_idx" ON "credit_ledger"("workspace_id", "type");

-- CreateIndex
CREATE INDEX "credit_ledger_job_id_idx" ON "credit_ledger"("job_id");

-- CreateIndex
CREATE INDEX "credit_ledger_payment_id_idx" ON "credit_ledger"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_workspace_id_idempotency_key_key" ON "credit_ledger"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_packages_code_key" ON "credit_packages"("code");

-- CreateIndex
CREATE INDEX "credit_packages_is_active_sort_order_idx" ON "credit_packages"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_workspace_id_status_idx" ON "payments"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "payments_workspace_id_created_at_idx" ON "payments"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_webhooks_status_created_at_idx" ON "payment_webhooks"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_webhooks_related_payment_id_idx" ON "payment_webhooks"("related_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhooks_provider_event_id_key" ON "payment_webhooks"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_workspace_id_status_idx" ON "subscriptions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_id_key" ON "api_keys"("key_id");

-- CreateIndex
CREATE INDEX "api_keys_workspace_id_status_idx" ON "api_keys"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "api_usage_workspace_id_created_at_idx" ON "api_usage"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "api_usage_api_key_id_created_at_idx" ON "api_usage"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "api_usage_created_at_idx" ON "api_usage"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_workspace_id_created_at_idx" ON "notifications"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_properties" ADD CONSTRAINT "search_console_properties_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_properties" ADD CONSTRAINT "search_console_properties_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_quota_usage" ADD CONSTRAINT "google_quota_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_quota_usage" ADD CONSTRAINT "google_quota_usage_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "search_console_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "search_console_properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "url_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_batches" ADD CONSTRAINT "url_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_batches" ADD CONSTRAINT "url_batches_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "search_console_properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_batches" ADD CONSTRAINT "url_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "search_console_properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "url_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_jobs" ADD CONSTRAINT "url_jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "url_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "url_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "credit_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "credit_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
