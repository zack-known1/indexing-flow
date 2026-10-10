import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth';
import { prisma } from '../../lib/prisma';
import { IndexStatus } from '@prisma/client';
import { UpstreamError, QuotaLimitedError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export interface InspectionResult {
  indexStatus: IndexStatus;
  indexVerdict: string;
  coverageState: string;
  lastCrawledAt: Date | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  robotsTxtState: string;
  indexingState: string;
  pageFetchState: string;
  mobileUsability: string;
  richResultsVerdict: string;
  rawResponse: unknown;
}

export async function inspectUrlInGoogle(
  propertyId: string,
  urlToInspect: string,
): Promise<InspectionResult> {
  const property = await prisma.searchConsoleProperty.findUnique({
    where: { id: propertyId },
    include: { connection: true },
  });

  if (!property) throw new Error('Property not found');

  const authClient = await getAuthenticatedClient(property.connectionId);
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  let res;
  try {
    res = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl: urlToInspect,
        siteUrl: property.siteUrl,
        languageCode: 'en-US',
      },
    });
  } catch (error: any) {
    const status = error?.status || error?.response?.status;
    const message = error?.message || '';

    if (status === 429 || /quota|resource_exhausted/i.test(message)) {
      throw new QuotaLimitedError('Search Console URL Inspection API', new Date(Date.now() + 3600 * 1000));
    }

    logger.error({ propertyId, urlToInspect, err: error }, 'URL Inspection API call failed');
    throw new UpstreamError('Google URL Inspection API', { cause: error });
  }

  const inspectionResult = res.data.inspectionResult;
  if (!inspectionResult) {
    return {
      indexStatus: IndexStatus.UNKNOWN,
      indexVerdict: 'UNKNOWN',
      coverageState: 'NO_DATA',
      lastCrawledAt: null,
      googleCanonical: null,
      userCanonical: null,
      robotsTxtState: 'UNKNOWN',
      indexingState: 'UNKNOWN',
      pageFetchState: 'UNKNOWN',
      mobileUsability: 'UNKNOWN',
      richResultsVerdict: 'UNKNOWN',
      rawResponse: res.data,
    };
  }

  const indexStatusResult = inspectionResult.indexStatusResult;
  const coverageState = indexStatusResult?.coverageState ?? 'UNKNOWN';
  const verdict = indexStatusResult?.verdict ?? 'VERDICT_UNSPECIFIED';
  const lastCrawlTime = indexStatusResult?.lastCrawlTime;

  let indexStatus: IndexStatus = IndexStatus.UNKNOWN;

  if (verdict === 'PASS') {
    indexStatus = IndexStatus.INDEXED;
  } else if (verdict === 'NEUTRAL') {
    if (coverageState.includes('CRAWLED_NOT_INDEXED')) {
      indexStatus = IndexStatus.CRAWLED_NOT_INDEXED;
    } else if (coverageState.includes('DISCOVERED_NOT_INDEXED')) {
      indexStatus = IndexStatus.DISCOVERED_NOT_INDEXED;
    } else {
      indexStatus = IndexStatus.NEUTRAL;
    }
  } else if (verdict === 'FAIL') {
    if (coverageState.includes('ROBOTS') || coverageState.includes('BLOCKED')) {
      indexStatus = IndexStatus.EXCLUDED_BY_ROBOTS;
    } else if (coverageState.includes('NOINDEX')) {
      indexStatus = IndexStatus.EXCLUDED_BY_NOINDEX;
    } else if (coverageState.includes('CANONICAL')) {
      indexStatus = IndexStatus.BLOCKED_BY_CANONICAL;
    } else {
      indexStatus = IndexStatus.NOT_INDEXED;
    }
  }

  return {
    indexStatus,
    indexVerdict: verdict,
    coverageState,
    lastCrawledAt: lastCrawlTime ? new Date(lastCrawlTime) : null,
    googleCanonical: indexStatusResult?.googleCanonical ?? null,
    userCanonical: indexStatusResult?.userCanonical ?? null,
    robotsTxtState: indexStatusResult?.robotsTxtState ?? 'UNKNOWN',
    indexingState: indexStatusResult?.indexingState ?? 'UNKNOWN',
    pageFetchState: indexStatusResult?.pageFetchState ?? 'UNKNOWN',
    mobileUsability: inspectionResult.mobileUsabilityResult?.verdict ?? 'UNKNOWN',
    richResultsVerdict: inspectionResult.richResultsResult?.verdict ?? 'UNKNOWN',
    rawResponse: res.data,
  };
}
