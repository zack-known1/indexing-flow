import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { UnauthenticatedError, ForbiddenError } from '../lib/errors';
import { PlatformRole, UserStatus } from '@prisma/client';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    workspaceId?: string;
    sessionEpoch?: number;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session.userId;
    if (!userId) {
      if (req.path.startsWith('/api/')) {
        throw new UnauthenticatedError();
      }
      res.redirect('/login');
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      req.session.destroy(() => {});
      if (req.path.startsWith('/api/')) {
        throw new UnauthenticatedError('Session expired or account suspended');
      }
      res.redirect('/login');
      return;
    }

    if (user.sessionEpoch && req.session.sessionEpoch && req.session.sessionEpoch < user.sessionEpoch) {
      req.session.destroy(() => {});
      if (req.path.startsWith('/api/')) {
        throw new UnauthenticatedError('Session invalidated');
      }
      res.redirect('/login');
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.platformRole !== PlatformRole.SUPER_ADMIN) {
    throw new ForbiddenError('Super admin access required.');
  }
  next();
}
