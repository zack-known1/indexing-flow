import { google } from 'googleapis';
import { prisma } from '../../lib/prisma';
import { getAuthenticatedClient } from './oauth';
import { PropertyType, PropertyPermission } from '@prisma/client';
import { UpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export async function fetchAndSyncSearchConsoleProperties(
  workspaceId: string,
  connectionId: string,
): Promise<number> {
  const authClient = await getAuthenticatedClient(connectionId);
  const webmasters = google.webmasters({ version: 'v3', auth: authClient });

  let sitesRes;
  try {
    sitesRes = await webmasters.sites.list();
  } catch (error) {
    logger.error({ workspaceId, connectionId, err: error }, 'Failed to fetch Search Console sites');
    throw new UpstreamError('Google Search Console', { cause: error });
  }

  const siteEntries = sitesRes.data.siteEntry ?? [];
  let syncedCount = 0;

  for (const site of siteEntries) {
    const siteUrl = site.siteUrl;
    const permissionLevelStr = site.permissionLevel;

    if (!siteUrl) continue;

    const isDomainProperty = siteUrl.startsWith('sc-domain:');
    const type = isDomainProperty ? PropertyType.DOMAIN : PropertyType.URL_PREFIX;

    // Derive bare hostname
    let hostname = '';
    try {
      if (isDomainProperty) {
        hostname = siteUrl.replace('sc-domain:', '');
      } else {
        hostname = new URL(siteUrl).hostname;
      }
    } catch {
      hostname = siteUrl;
    }

    let permission: PropertyPermission = PropertyPermission.PERMISSION_UNSPECIFIED;
    switch (permissionLevelStr) {
      case 'siteOwner':
        permission = PropertyPermission.SITE_OWNER;
        break;
      case 'siteFullUser':
        permission = PropertyPermission.SITE_FULL_USER;
        break;
      case 'siteRestrictedUser':
        permission = PropertyPermission.SITE_RESTRICTED_USER;
        break;
      case 'siteUnverifiedUser':
        permission = PropertyPermission.SITE_UNVERIFIED_USER;
        break;
    }

    await prisma.searchConsoleProperty.upsert({
      where: {
        workspaceId_siteUrl: {
          workspaceId,
          siteUrl,
        },
      },
      update: {
        connectionId,
        hostname,
        type,
        permissionLevel: permission,
        isActive: true,
        lastSyncedAt: new Date(),
      },
      create: {
        workspaceId,
        connectionId,
        siteUrl,
        hostname,
        type,
        permissionLevel: permission,
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    syncedCount++;
  }

  // Update connection verified timestamp
  await prisma.oAuthConnection.update({
    where: { id: connectionId },
    data: { lastVerifiedAt: new Date(), consecutiveFailures: 0 },
  });

  return syncedCount;
}

export async function submitSitemapToGoogle(
  propertyId: string,
  sitemapUrl: string,
): Promise<void> {
  const property = await prisma.searchConsoleProperty.findUnique({
    where: { id: propertyId },
    include: { connection: true },
  });

  if (!property) throw new Error('Property not found');

  const authClient = await getAuthenticatedClient(property.connectionId);
  const webmasters = google.webmasters({ version: 'v3', auth: authClient });

  try {
    await webmasters.sitemaps.submit({
      siteUrl: property.siteUrl,
      feedpath: sitemapUrl,
    });

    await prisma.searchConsoleProperty.update({
      where: { id: propertyId },
      data: {
        sitemapUrl,
        sitemapLastSubmittedAt: new Date(),
      },
    });
  } catch (error) {
    logger.error({ propertyId, sitemapUrl, err: error }, 'Failed to submit sitemap to Google');
    throw new UpstreamError('Google Search Console Sitemap', { cause: error });
  }
}
