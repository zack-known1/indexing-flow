import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { resolveWorkspace, requirePermission } from '../middleware/tenant';
import { getAuthorizationUrl, exchangeCode } from '../services/google/oauth';
import { fetchAndSyncSearchConsoleProperties, submitSitemapToGoogle } from '../services/google/searchConsole';
import { encrypt } from '../lib/crypto';
import { generateToken } from '../lib/crypto';
import { env } from '../config/env';
import { ConnectionStatus } from '@prisma/client';

const router = Router();
router.use(requireAuth, resolveWorkspace);

router.get('/', requirePermission('properties:read'), async (req, res, next) => {
  try {
    const workspaceId = req.workspace!.id;

    const connections = await prisma.oAuthConnection.findMany({
      where: { workspaceId },
      include: {
        properties: {
          orderBy: { siteUrl: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const properties = await prisma.searchConsoleProperty.findMany({
      where: { workspaceId },
      include: {
        connection: true,
        _count: {
          select: { urls: true },
        },
      },
      orderBy: { siteUrl: 'asc' },
    });

    res.render('properties/index', {
      title: 'Google Properties',
      user: req.user,
      workspace: req.workspace,
      connections,
      properties,
      googleConfigured: env.features.google,
      appName: env.APP_NAME,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/google/connect', requirePermission('properties:connect'), (req, res) => {
  if (!env.features.google) {
    return res.redirect('/properties?error=Google OAuth is not configured on this server.');
  }

  const state = generateToken(16);
  (req.session as any).oauthState = state;

  const authUrl = getAuthorizationUrl(state);
  res.redirect(authUrl);
});

router.get('/google/callback', requirePermission('properties:connect'), async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`/properties?error=Google authorization failed: ${error}`);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect('/properties?error=Missing authorization code from Google.');
    }

    const savedState = (req.session as any).oauthState;
    if (state && savedState && state !== savedState) {
      return res.redirect('/properties?error=State validation failed.');
    }

    const { tokens, googleEmail, providerAccountId } = await exchangeCode(code);

    if (!tokens.refresh_token) {
      return res.redirect(
        '/properties?error=Google did not provide a refresh token. Please remove IndexFlow from your Google permissions and connect again.',
      );
    }

    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;

    const connection = await prisma.oAuthConnection.upsert({
      where: {
        workspaceId_provider_providerAccountId: {
          workspaceId,
          provider: 'GOOGLE',
          providerAccountId,
        },
      },
      update: {
        googleEmail,
        refreshTokenEnc: encrypt(tokens.refresh_token),
        accessTokenEnc: tokens.access_token ? encrypt(tokens.access_token) : null,
        accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope ?? '',
        status: ConnectionStatus.ACTIVE,
        statusDetail: null,
        lastVerifiedAt: new Date(),
      },
      create: {
        workspaceId,
        userId,
        provider: 'GOOGLE',
        providerAccountId,
        googleEmail,
        refreshTokenEnc: encrypt(tokens.refresh_token),
        accessTokenEnc: tokens.access_token ? encrypt(tokens.access_token) : null,
        accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope ?? '',
        status: ConnectionStatus.ACTIVE,
      },
    });

    // Automatically sync properties from Search Console
    const syncedCount = await fetchAndSyncSearchConsoleProperties(workspaceId, connection.id);

    res.redirect(`/properties?message=Successfully connected Google account (${googleEmail}) and synced ${syncedCount} Search Console properties.`);
  } catch (error) {
    next(error);
  }
});

router.post('/sync/:connectionId', requirePermission('properties:connect'), async (req, res, next) => {
  try {
    const connectionId = req.params.connectionId;
    if (!connectionId) {
      return res.redirect('/properties?error=Missing connection id');
    }
    const workspaceId = req.workspace!.id;

    const count = await fetchAndSyncSearchConsoleProperties(workspaceId, connectionId);
    res.redirect(`/properties?message=Successfully synced ${count} properties.`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/toggle-indexing', requirePermission('properties:update'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const property = await prisma.searchConsoleProperty.findUnique({
      where: { id },
    });

    if (!property || property.workspaceId !== req.workspace!.id) {
      return res.redirect('/properties?error=Property not found');
    }

    await prisma.searchConsoleProperty.update({
      where: { id },
      data: {
        indexingApiEnabled: !property.indexingApiEnabled,
        indexingApiConfirmedAt: !property.indexingApiEnabled ? new Date() : null,
      },
    });

    res.redirect('/properties?message=Property indexing settings updated.');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sitemap', requirePermission('properties:update'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const { sitemapUrl } = req.body;

    if (!id || !sitemapUrl) {
      return res.redirect('/properties?error=Property ID and Sitemap URL are required');
    }

    await submitSitemapToGoogle(id, sitemapUrl.trim());
    res.redirect('/properties?message=Sitemap successfully submitted to Google Search Console.');
  } catch (error) {
    next(error);
  }
});

export default router;
