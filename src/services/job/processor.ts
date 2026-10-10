import { JobState, SubmissionStatus, IndexStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { inspectUrlInGoogle } from '../google/urlInspection';
import { publishUrlIndexing } from '../google/indexing';
import { debitCredits, refundCredits } from '../credit/wallet';
import { logger } from '../../lib/logger';
import { UrlJobPayload } from './queue';

export async function processUrlJob(payload: UrlJobPayload): Promise<void> {
  const { jobId, workspaceId, urlId, propertyId, jobType } = payload;

  const urlJob = await prisma.urlJob.findUnique({
    where: { id: jobId },
    include: { url: true, property: true },
  });

  if (!urlJob || urlJob.state === JobState.CANCELLED || urlJob.state === JobState.INDEXED) {
    return;
  }

  // Update job state to running
  await prisma.urlJob.update({
    where: { id: jobId },
    data: {
      state: jobType === 'SUBMIT' ? JobState.SUBMITTING : JobState.CHECKING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });

  try {
    if (jobType === 'SUBMIT') {
      let submissionMethod = 'SEARCH_CONSOLE_SITEMAP';

      // If property has Indexing API enabled and content type is eligible
      if (
        urlJob.property?.indexingApiEnabled &&
        (urlJob.url.contentType === 'JOB_POSTING' || urlJob.url.contentType === 'BROADCAST_EVENT')
      ) {
        try {
          await publishUrlIndexing(propertyId, urlJob.url.rawUrl, 'URL_UPDATED');
          submissionMethod = 'GOOGLE_INDEXING_API';
        } catch (err) {
          logger.warn({ url: urlJob.url.rawUrl, err }, 'Indexing API fallback to sitemap submission');
        }
      }

      // Update URL submission status
      await prisma.url.update({
        where: { id: urlId },
        data: {
          submissionStatus: SubmissionStatus.SUBMITTED,
          submittedAt: new Date(),
          submissionMethod,
          jobCount: { increment: 1 },
        },
      });

      // Debit credits
      if (urlJob.creditsReserved > 0) {
        await debitCredits(
          workspaceId,
          urlJob.creditsReserved,
          `debit:job:${jobId}`,
          `Successfully submitted URL: ${urlJob.url.rawUrl}`,
          { jobId, batchId: urlJob.batchId ?? undefined },
        );
      }

      // Complete job
      await prisma.urlJob.update({
        where: { id: jobId },
        data: {
          state: JobState.SUBMITTED,
          finishedAt: new Date(),
          creditsConsumed: urlJob.creditsReserved,
          creditsReserved: 0,
        },
      });
    } else if (jobType === 'STATUS_CHECK') {
      const inspection = await inspectUrlInGoogle(propertyId, urlJob.url.rawUrl);

      // Update URL index status
      await prisma.url.update({
        where: { id: urlId },
        data: {
          indexStatus: inspection.indexStatus,
          indexVerdict: inspection.indexVerdict,
          coverageState: inspection.coverageState,
          lastCheckedAt: new Date(),
          lastCrawledAt: inspection.lastCrawledAt,
          googleCanonical: inspection.googleCanonical,
          userCanonical: inspection.userCanonical,
          robotsTxtState: inspection.robotsTxtState,
          indexingState: inspection.indexingState,
          pageFetchState: inspection.pageFetchState,
          mobileUsability: inspection.mobileUsability,
          richResultsVerdict: inspection.richResultsVerdict,
          jobCount: { increment: 1 },
        },
      });

      // Debit credits
      if (urlJob.creditsReserved > 0) {
        await debitCredits(
          workspaceId,
          urlJob.creditsReserved,
          `debit:job:${jobId}`,
          `Inspected URL index status: ${urlJob.url.rawUrl}`,
          { jobId, batchId: urlJob.batchId ?? undefined },
        );
      }

      // Complete job
      await prisma.urlJob.update({
        where: { id: jobId },
        data: {
          state: inspection.indexStatus === IndexStatus.INDEXED ? JobState.INDEXED : JobState.NOT_INDEXED,
          finishedAt: new Date(),
          creditsConsumed: urlJob.creditsReserved,
          creditsReserved: 0,
          providerResponse: inspection.rawResponse as object,
        },
      });
    }

    // Update batch counters if part of a batch
    if (urlJob.batchId) {
      await prisma.urlBatch.update({
        where: { id: urlJob.batchId },
        data: {
          processedJobs: { increment: 1 },
          successJobs: { increment: 1 },
          consumedCredits: { increment: urlJob.creditsReserved },
          reservedCredits: { decrement: urlJob.creditsReserved },
        },
      });
    }
  } catch (error: any) {
    logger.error({ jobId, err: error?.message }, 'URL job execution failed');

    // Refund reserved credits
    if (urlJob.creditsReserved > 0) {
      await refundCredits(
        workspaceId,
        urlJob.creditsReserved,
        `refund:job:${jobId}`,
        `Job failed: ${error?.message}`,
        { jobId, batchId: urlJob.batchId ?? undefined },
      );
    }

    await prisma.urlJob.update({
      where: { id: jobId },
      data: {
        state: JobState.ERROR,
        errorMessage: error?.message?.slice(0, 999),
        finishedAt: new Date(),
        creditsReserved: 0,
        creditsRefunded: urlJob.creditsReserved,
      },
    });

    if (urlJob.batchId) {
      await prisma.urlBatch.update({
        where: { id: urlJob.batchId },
        data: {
          processedJobs: { increment: 1 },
          failedJobs: { increment: 1 },
          refundedCredits: { increment: urlJob.creditsReserved },
          reservedCredits: { decrement: urlJob.creditsReserved },
        },
      });
    }

    throw error;
  }
}
