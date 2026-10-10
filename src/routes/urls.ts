import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { resolveWorkspace, requirePermission } from '../middleware/tenant';
import { normalizeUrl, urlMatchesProperty } from '../services/url/normalize';
import { generateToken } from '../lib/crypto';
import { getWalletBalance, reserveCredits } from '../services/credit/wallet';
import { enqueueUrlJob } from '../services/job/queue';
import { ValidationError, InsufficientCreditsError } from '../lib/errors';
import { BatchSource, JobType, SubmissionStatus, IndexStatus } from '@prisma/client';
import { env } from '../config/env';

const router = Router();
router.use(requireAuth, resolveWorkspace);

router.get('/', requirePermission('urls:read'), async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 25;
    const skip = (page - 1) * limit;

    const statusFilter = req.query.status as string;
    const searchFilter = req.query.search as string;
    const propertyFilter = req.query.propertyId as string;

    const where: any = { workspaceId };
    if (statusFilter && statusFilter !== 'ALL') {
      where.indexStatus = statusFilter;
    }
    if (propertyFilter) {
      where.propertyId = propertyFilter;
    }
    if (searchFilter) {
      where.rawUrl = { contains: searchFilter, mode: 'insensitive' };
    }

    const [urls, totalCount, properties, walletBalance] = await Promise.all([
      prisma.url.findMany({
        where,
        include: { property: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.url.count({ where }),
      prisma.searchConsoleProperty.findMany({
        where: { workspaceId, isActive: true },
      }),
      getWalletBalance(workspaceId),
    ]);

    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('urls/index', {
      title: 'Indexed URLs',
      user: req.user,
      workspace: req.workspace,
      urls,
      properties,
      walletBalance,
      pagination: { page, totalPages, totalCount },
      filters: { status: statusFilter || 'ALL', search: searchFilter || '', propertyId: propertyFilter || '' },
      appName: env.APP_NAME,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/submit', requirePermission('urls:write'), async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;
    const [properties, walletBalance] = await Promise.all([
      prisma.searchConsoleProperty.findMany({
        where: { workspaceId, isActive: true },
      }),
      getWalletBalance(workspaceId),
    ]);

    res.render('urls/submit', {
      title: 'Submit URLs for Indexing',
      user: req.user,
      workspace: req.workspace,
      properties,
      walletBalance,
      costPerUrl: env.CREDIT_COST_SUBMIT,
      appName: env.APP_NAME,
      error: req.query.error,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/submit', requirePermission('urls:write'), async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;
    const { urlsText, propertyId, batchName } = req.body;

    if (!urlsText || typeof urlsText !== 'string') {
      throw new ValidationError('Please enter at least one URL to submit.');
    }

    const rawLines = urlsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    if (rawLines.length === 0) {
      throw new ValidationError('No valid URLs found in submission.');
    }

    if (rawLines.length > env.MAX_BULK_URLS) {
      throw new ValidationError(`Submission exceeds maximum bulk limit of ${env.MAX_BULK_URLS.toLocaleString()} URLs.`);
    }

    const property = await prisma.searchConsoleProperty.findUnique({
      where: { id: propertyId },
    });

    if (!property || property.workspaceId !== workspaceId) {
      throw new ValidationError('Selected Google Search Console property is invalid.');
    }

    // Normalize and filter URLs matching property
    const validUrls: { rawUrl: string; normalizedUrl: string; hostname: string; pathname: string }[] = [];
    let duplicateCount = 0;
    let invalidCount = 0;

    const seen = new Set<string>();

    for (const raw of rawLines) {
      try {
        const norm = normalizeUrl(raw);
        if (!urlMatchesProperty(norm.normalizedUrl, property.siteUrl)) {
          invalidCount++;
          continue;
        }
        if (seen.has(norm.normalizedUrl)) {
          duplicateCount++;
          continue;
        }
        seen.add(norm.normalizedUrl);
        validUrls.push(norm);
      } catch {
        invalidCount++;
      }
    }

    if (validUrls.length === 0) {
      throw new ValidationError('None of the submitted URLs match the selected Search Console property.');
    }

    const requiredCredits = validUrls.length * env.CREDIT_COST_SUBMIT;
    const wallet = await getWalletBalance(workspaceId);

    if (wallet.available < requiredCredits) {
      throw new InsufficientCreditsError(requiredCredits, wallet.available, { workspaceId });
    }

    const batchId = generateToken(12);
    const idempotencyKeyBatch = `batch:reserve:${batchId}`;

    // Reserve credits
    await reserveCredits(
      workspaceId,
      requiredCredits,
      idempotencyKeyBatch,
      `Reserved credits for submitting batch of ${validUrls.length} URLs`,
      { batchId, userId },
    );

    // Create batch record
    const batch = await prisma.urlBatch.create({
      data: {
        id: batchId,
        workspaceId,
        propertyId: property.id,
        name: batchName ? String(batchName).trim() : `Batch ${new Date().toISOString().slice(0, 19)}`,
        source: BatchSource.BULK_PASTE,
        status: 'PROCESSING',
        totalJobs: validUrls.length,
        estimatedCredits: requiredCredits,
        reservedCredits: requiredCredits,
        createdById: userId,
        startedAt: new Date(),
      },
    });

    // Create URL and Job records in transaction
    let submittedJobsCount = 0;
    for (const item of validUrls) {
      try {
        const urlRecord = await prisma.url.upsert({
          where: {
            workspaceId_normalizedUrl: {
              workspaceId,
              normalizedUrl: item.normalizedUrl,
            },
          },
          update: {
            propertyId: property.id,
            batchId: batch.id,
          },
          create: {
            workspaceId,
            propertyId: property.id,
            batchId: batch.id,
            rawUrl: item.rawUrl,
            normalizedUrl: item.normalizedUrl,
            hostname: item.hostname,
            pathname: item.pathname,
            createdById: userId,
          },
        });

        const jobId = generateToken(16);
        const idempotencyKeyJob = `job:submit:${urlRecord.id}:${Date.now()}`;

        const urlJob = await prisma.urlJob.create({
          data: {
            id: jobId,
            workspaceId,
            urlId: urlRecord.id,
            propertyId: property.id,
            batchId: batch.id,
            jobType: JobType.SUBMIT,
            state: 'QUEUED',
            idempotencyKey: idempotencyKeyJob,
            creditsReserved: env.CREDIT_COST_SUBMIT,
            createdById: userId,
          },
        });

        await enqueueUrlJob({
          jobId: urlJob.id,
          workspaceId,
          urlId: urlRecord.id,
          propertyId: property.id,
          jobType: 'SUBMIT',
          userId,
        });

        submittedJobsCount++;
      } catch (err) {
        // Handle individual duplicate upsert or concurrency gracefully
      }
    }

    res.redirect(`/urls?message=Successfully queued ${submittedJobsCount} URLs for submission. (${duplicateCount} duplicates skipped, ${invalidCount} invalid)`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/check', requirePermission('urls:write'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;

    const urlRecord = await prisma.url.findUnique({
      where: { id },
      include: { property: true },
    });

    if (!urlRecord || urlRecord.workspaceId !== workspaceId) {
      return res.redirect('/urls?error=URL not found');
    }

    if (!urlRecord.propertyId) {
      return res.redirect('/urls?error=URL is not associated with a SearchConsole property.');
    }

    const cost = env.CREDIT_COST_STATUS_CHECK;
    const wallet = await getWalletBalance(workspaceId);
    if (wallet.available < cost) {
      throw new InsufficientCreditsError(cost, wallet.available, { workspaceId });
    }

    const jobId = generateToken(16);
    const idempotencyKey = `job:check:${urlRecord.id}:${Date.now()}`;

    await reserveCredits(workspaceId, cost, `reserve:check:${jobId}`, `Reserved credits for URL status check`, { jobId, userId });

    const urlJob = await prisma.urlJob.create({
      data: {
        id: jobId,
        workspaceId,
        urlId: urlRecord.id,
        propertyId: urlRecord.propertyId,
        jobType: JobType.STATUS_CHECK,
        state: 'QUEUED',
        idempotencyKey,
        creditsReserved: cost,
        createdById: userId,
      },
    });

    await enqueueUrlJob({
      jobId: urlJob.id,
      workspaceId,
      urlId: urlRecord.id,
      propertyId: urlRecord.propertyId,
      jobType: 'STATUS_CHECK',
      userId,
    });

    res.redirect('/urls?message=URL index status check enqueued.');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/delete', requirePermission('urls:delete'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const workspaceId = req.workspace!.id;

    const urlRecord = await prisma.url.findUnique({
      where: { id },
    });

    if (!urlRecord || urlRecord.workspaceId !== workspaceId) {
      return res.redirect('/urls?error=URL not found');
    }

    await prisma.url.delete({ where: { id } });
    res.redirect('/urls?message=URL deleted successfully.');
  } catch (error) {
    next(error);
  }
});

export default router;
