import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth';
import { prisma } from '../../lib/prisma';
import { UpstreamError, QuotaLimitedError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED';

export interface IndexingPublishResult {
  url: string;
  type: IndexingNotificationType;
  notifyTime: string | null;
  rawResponse: unknown;
}

export async function publishUrlIndexing(
  propertyId: string,
  urlToPublish: string,
  type: IndexingNotificationType = 'URL_UPDATED',
): Promise<IndexingPublishResult> {
  const property = await prisma.searchConsoleProperty.findUnique({
    where: { id: propertyId },
    include: { connection: true },
  });

  if (!property) throw new Error('Property not found');

  const authClient = await getAuthenticatedClient(property.connectionId);
  const indexing = google.indexing({ version: 'v3', auth: authClient });

  let res;
  try {
    res = await indexing.urlNotifications.publish({
      requestBody: {
        url: urlToPublish,
        type,
      },
    });
  } catch (error: any) {
    const status = error?.status || error?.response?.status;
    const message = error?.message || '';

    if (status === 429 || /quota|resource_exhausted/i.test(message)) {
      throw new QuotaLimitedError('Google Indexing API', new Date(Date.now() + 3600 * 1000));
    }

    logger.error({ propertyId, urlToPublish, err: error }, 'Google Indexing API call failed');
    throw new UpstreamError('Google Indexing API', { cause: error });
  }

  const notifyTime = res.data.urlNotificationMetadata?.latestUpdate?.notifyTime ?? null;

  return {
    url: urlToPublish,
    type,
    notifyTime,
    rawResponse: res.data,
  };
}
