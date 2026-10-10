import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { ForbiddenError, NotFoundError } from '../lib/errors';
import { Permission, hasPermission } from '../config/permissions';
import { Workspace, WorkspaceMember, User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      workspace?: Workspace;
      workspaceMember?: WorkspaceMember;
    }
  }
}

export async function resolveWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      return next();
    }

    let workspaceId = req.session.workspaceId || req.headers['x-workspace-id'] as string;

    if (!workspaceId) {
      const membership = await prisma.workspaceMember.findFirst({
        where: { userId: req.user.id },
        include: { workspace: true },
      });

      if (membership) {
        workspaceId = membership.workspaceId;
        req.session.workspaceId = workspaceId;
      }
    }

    if (workspaceId) {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.id,
          },
        },
        include: { workspace: true },
      });

      if (membership && membership.workspace.status === 'ACTIVE') {
        req.workspace = membership.workspace;
        req.workspaceMember = membership;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.workspace || !req.workspaceMember) {
      throw new NotFoundError('Workspace');
    }

    if (!hasPermission(req.workspaceMember.role, permission)) {
      throw new ForbiddenError(`You lack required permission: ${permission}`);
    }

    next();
  };
}
