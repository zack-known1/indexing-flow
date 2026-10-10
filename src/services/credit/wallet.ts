import { CreditTxnType, Prisma } from '@prisma/client';
import { prisma, runSerializable } from '../../lib/prisma';
import { InsufficientCreditsError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export interface WalletBalance {
  available: number;
  reserved: number;
  total: number;
}

export async function getWalletBalance(workspaceId: string): Promise<WalletBalance> {
  const wallet = await prisma.creditWallet.findUnique({
    where: { workspaceId },
  });

  if (!wallet) {
    return { available: 0, reserved: 0, total: 0 };
  }

  return {
    available: wallet.availableCredits,
    reserved: wallet.reservedCredits,
    total: wallet.availableCredits + wallet.reservedCredits,
  };
}

/**
 * Reserve credits for an in-flight job (available -> reserved).
 */
export async function reserveCredits(
  workspaceId: string,
  amount: number,
  idempotencyKey: string,
  reason: string,
  meta?: { jobId?: string; batchId?: string; userId?: string },
): Promise<void> {
  if (amount <= 0) return;

  await runSerializable(
    async (tx) => {
      // Check existing ledger entry for idempotency
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      });
      if (existing) return;

      const wallet = await tx.creditWallet.findUnique({
        where: { workspaceId },
      });

      if (!wallet || wallet.availableCredits < amount) {
        throw new InsufficientCreditsError(amount, wallet?.availableCredits ?? 0, {
          workspaceId,
        });
      }

      const availableBefore = wallet.availableCredits;
      const reservedBefore = wallet.reservedCredits;
      const availableAfter = availableBefore - amount;
      const reservedAfter = reservedBefore + amount;

      await tx.creditWallet.update({
        where: { workspaceId },
        data: {
          availableCredits: availableAfter,
          reservedCredits: reservedAfter,
          version: { increment: 1 },
        },
      });

      await tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          type: CreditTxnType.RESERVE,
          amount: -amount,
          reservedDelta: amount,
          availableBefore,
          availableAfter,
          reservedBefore,
          reservedAfter,
          reason,
          idempotencyKey,
          jobId: meta?.jobId,
          batchId: meta?.batchId,
          userId: meta?.userId,
        },
      });
    },
    { label: 'reserveCredits' },
  );
}

/**
 * Debit reserved credits on successful completion (reserved -> consumed).
 */
export async function debitCredits(
  workspaceId: string,
  amount: number,
  idempotencyKey: string,
  reason: string,
  meta?: { jobId?: string; batchId?: string; userId?: string },
): Promise<void> {
  if (amount <= 0) return;

  await runSerializable(
    async (tx) => {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      });
      if (existing) return;

      const wallet = await tx.creditWallet.findUnique({
        where: { workspaceId },
      });

      if (!wallet) return;

      const availableBefore = wallet.availableCredits;
      const reservedBefore = wallet.reservedCredits;
      const availableAfter = availableBefore;
      const reservedAfter = Math.max(0, reservedBefore - amount);

      await tx.creditWallet.update({
        where: { workspaceId },
        data: {
          reservedCredits: reservedAfter,
          lifetimeConsumed: { increment: amount },
          version: { increment: 1 },
        },
      });

      await tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          type: CreditTxnType.DEBIT,
          amount: 0,
          reservedDelta: -amount,
          availableBefore,
          availableAfter,
          reservedBefore,
          reservedAfter,
          reason,
          idempotencyKey,
          jobId: meta?.jobId,
          batchId: meta?.batchId,
          userId: meta?.userId,
        },
      });
    },
    { label: 'debitCredits' },
  );
}

/**
 * Refund reserved credits if a job fails (reserved -> available).
 */
export async function refundCredits(
  workspaceId: string,
  amount: number,
  idempotencyKey: string,
  reason: string,
  meta?: { jobId?: string; batchId?: string; userId?: string },
): Promise<void> {
  if (amount <= 0) return;

  await runSerializable(
    async (tx) => {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      });
      if (existing) return;

      const wallet = await tx.creditWallet.findUnique({
        where: { workspaceId },
      });

      if (!wallet) return;

      const availableBefore = wallet.availableCredits;
      const reservedBefore = wallet.reservedCredits;
      const availableAfter = availableBefore + amount;
      const reservedAfter = Math.max(0, reservedBefore - amount);

      await tx.creditWallet.update({
        where: { workspaceId },
        data: {
          availableCredits: availableAfter,
          reservedCredits: reservedAfter,
          lifetimeRefunded: { increment: amount },
          version: { increment: 1 },
        },
      });

      await tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          type: CreditTxnType.REFUND,
          amount,
          reservedDelta: -amount,
          availableBefore,
          availableAfter,
          reservedBefore,
          reservedAfter,
          reason,
          idempotencyKey,
          jobId: meta?.jobId,
          batchId: meta?.batchId,
          userId: meta?.userId,
        },
      });
    },
    { label: 'refundCredits' },
  );
}

/**
 * Add credits from purchase or promo bonus.
 */
export async function addCredits(
  workspaceId: string,
  amount: number,
  type: CreditTxnType,
  idempotencyKey: string,
  reason: string,
  meta?: { paymentId?: string; userId?: string },
): Promise<void> {
  if (amount <= 0) return;

  await runSerializable(
    async (tx) => {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      });
      if (existing) return;

      let wallet = await tx.creditWallet.findUnique({
        where: { workspaceId },
      });

      if (!wallet) {
        wallet = await tx.creditWallet.create({
          data: {
            workspaceId,
            availableCredits: 0,
            reservedCredits: 0,
          },
        });
      }

      const availableBefore = wallet.availableCredits;
      const reservedBefore = wallet.reservedCredits;
      const availableAfter = availableBefore + amount;
      const reservedAfter = reservedBefore;

      const updateData: Prisma.CreditWalletUpdateInput = {
        availableCredits: availableAfter,
        version: { increment: 1 },
      };

      if (type === CreditTxnType.PURCHASE) {
        updateData.lifetimePurchased = { increment: amount };
      } else if (type === CreditTxnType.BONUS) {
        updateData.lifetimeBonus = { increment: amount };
      }

      await tx.creditWallet.update({
        where: { workspaceId },
        data: updateData,
      });

      await tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          type,
          amount,
          reservedDelta: 0,
          availableBefore,
          availableAfter,
          reservedBefore,
          reservedAfter,
          reason,
          idempotencyKey,
          paymentId: meta?.paymentId,
          userId: meta?.userId,
        },
      });
    },
    { label: 'addCredits' },
  );
}
