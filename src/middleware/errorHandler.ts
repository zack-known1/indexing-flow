import { Request, Response, NextFunction } from 'express';
import { AppError, normalizeError } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalizeError(err);

  if (appError.expected) {
    logger.warn(
      {
        status: appError.status,
        code: appError.code,
        message: appError.message,
        path: req.path,
        method: req.method,
        internal: appError.internal,
      },
      'Application handled error',
    );
  } else {
    logger.error(
      {
        status: appError.status,
        code: appError.code,
        message: appError.message,
        path: req.path,
        method: req.method,
        internal: appError.internal,
        err,
      },
      'Unhandled error',
    );
  }

  if (appError.retryAfter) {
    res.setHeader('Retry-After', appError.retryAfter);
  }

  const acceptsJson = req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/');

  if (acceptsJson) {
    res.status(appError.status).json(appError.toJSON());
    return;
  }

  res.status(appError.status).render('error', {
    title: `Error ${appError.status}`,
    error: {
      status: appError.status,
      code: appError.code,
      message: appError.message,
    },
    user: req.user,
    workspace: req.workspace,
    appName: env.APP_NAME,
  });
}
