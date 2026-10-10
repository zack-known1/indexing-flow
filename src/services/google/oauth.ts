import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';
import { encrypt, decrypt, tryDecrypt } from '../../lib/crypto';
import { prisma } from '../../lib/prisma';
import { GoogleAuthRevokedError, UpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { ConnectionStatus } from '@prisma/client';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
];

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthorizationUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string) {
  const client = createOAuthClient();
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();

    return {
      tokens,
      googleEmail: userInfo.data.email ?? '',
      providerAccountId: userInfo.data.id ?? userInfo.data.email ?? '',
    };
  } catch (error) {
    logger.error({ err: error }, 'Google OAuth token exchange failed');
    throw new UpstreamError('Google OAuth', { cause: error });
  }
}

export async function getAuthenticatedClient(connectionId: string): Promise<OAuth2Client> {
  const connection = await prisma.oAuthConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection || connection.status !== ConnectionStatus.ACTIVE) {
    throw new GoogleAuthRevokedError(connectionId, 'OAuth Connection is not active');
  }

  const client = createOAuthClient();
  const refreshToken = decrypt(connection.refreshTokenEnc);
  const cachedAccessToken = tryDecrypt(connection.accessTokenEnc);

  client.setCredentials({
    refresh_token: refreshToken,
    access_token: cachedAccessToken ?? undefined,
  });

  // Check if access token is expired or missing
  const isExpired =
    !connection.accessTokenExpiresAt ||
    connection.accessTokenExpiresAt.getTime() <= Date.now() + 60_000;

  if (isExpired || !cachedAccessToken) {
    try {
      const response = await client.refreshAccessToken();
      const newTokens = response.credentials;

      if (newTokens.access_token) {
        await prisma.oAuthConnection.update({
          where: { id: connectionId },
          data: {
            accessTokenEnc: encrypt(newTokens.access_token),
            accessTokenExpiresAt: newTokens.expiry_date
              ? new Date(newTokens.expiry_date)
              : new Date(Date.now() + 3500 * 1000),
            lastRefreshedAt: new Date(),
            consecutiveFailures: 0,
          },
        });
      }
    } catch (error: any) {
      logger.error({ connectionId, err: error?.message }, 'Failed to refresh Google access token');
      if (
        error?.message?.includes('invalid_grant') ||
        error?.response?.data?.error === 'invalid_grant'
      ) {
        await prisma.oAuthConnection.update({
          where: { id: connectionId },
          data: {
            status: ConnectionStatus.EXPIRED,
            statusDetail: 'Invalid or revoked grant. Please reconnect Google account.',
          },
        });
        throw new GoogleAuthRevokedError(connectionId, 'Google grant expired or revoked');
      }
      throw new UpstreamError('Google Auth Refresh', { cause: error });
    }
  }

  return client;
}
