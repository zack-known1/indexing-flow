import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { resolveWorkspace, requirePermission } from '../middleware/tenant';
import { getWalletBalance } from '../services/credit/wallet';
import { env } from '../config/env';

const router = Router();
router.use(requireAuth, resolveWorkspace);

router.get('/', requirePermission('billing:read'), async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;

    const [walletBalance, ledgerEntries, packages] = await Promise.all([
      getWalletBalance(workspaceId),
      prisma.creditLedgerEntry.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.creditPackage.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    res.render('billing/index', {
      title: 'Billing & Credits',
      user: req.user,
      workspace: req.workspace,
      walletBalance,
      ledgerEntries,
      packages,
      taxPercent: env.BILLING_TAX_PERCENT,
      currency: env.BILLING_CURRENCY,
      appName: env.APP_NAME,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
