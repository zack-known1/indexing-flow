import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { resolveWorkspace } from '../middleware/tenant';
import { getWalletBalance } from '../services/credit/wallet';
import { env } from '../config/env';
import { IndexStatus } from '@prisma/client';

const router = Router();
router.use(requireAuth, resolveWorkspace);

router.get('/', async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;

    const [
      totalUrls,
      indexedUrls,
      discoveredUrls,
      excludedUrls,
      recentUrls,
      properties,
      walletBalance,
      recentBatches,
    ] = await Promise.all([
      prisma.url.count({ where: { workspaceId } }),
      prisma.url.count({ where: { workspaceId, indexStatus: IndexStatus.INDEXED } }),
      prisma.url.count({
        where: {
          workspaceId,
          indexStatus: { in: [IndexStatus.DISCOVERED_NOT_INDEXED, IndexStatus.CRAWLED_NOT_INDEXED] },
        },
      }),
      prisma.url.count({
        where: {
          workspaceId,
          indexStatus: {
            in: [
              IndexStatus.EXCLUDED_BY_NOINDEX,
              IndexStatus.EXCLUDED_BY_ROBOTS,
              IndexStatus.BLOCKED_BY_CANONICAL,
              IndexStatus.NOT_INDEXED,
            ],
          },
        },
      }),
      prisma.url.findMany({
        where: { workspaceId },
        include: { property: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.searchConsoleProperty.findMany({
        where: { workspaceId, isActive: true },
      }),
      getWalletBalance(workspaceId),
      prisma.urlBatch.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    res.render('dashboard/index', {
      title: 'Dashboard',
      user: req.user,
      workspace: req.workspace,
      stats: {
        totalUrls,
        indexedUrls,
        discoveredUrls,
        excludedUrls,
        propertiesCount: properties.length,
      },
      recentUrls,
      properties,
      walletBalance,
      recentBatches,
      googleConfigured: env.features.google,
      appName: env.APP_NAME,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
