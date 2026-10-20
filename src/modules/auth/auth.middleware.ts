import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { fail } from '../../shared/errors/api-error.js';
import type { User } from './auth.model.js';
import { verifyUserToken, getUserWithActiveSession } from './auth.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

export const currentUser = (req: Express.Request): User =>
  req.user ?? fail(401, 'UNAUTHENTICATED', 'Silakan login.');

export const roles =
  (...allowed: User['role'][]): RequestHandler =>
  (req, _res, next) => {
    if (!allowed.includes(currentUser(req).role)) fail(403, 'FORBIDDEN', 'Akses tidak diizinkan.');
    next();
  };

export function authMiddleware(pool: Pool, config: Config): RequestHandler {
  return async (req, _res, next) => {
    const bearer = req.get('authorization');
    const { userId, sessionId } = await verifyUserToken(config.JWT_SECRET, bearer);
    const user = await getUserWithActiveSession(pool, userId, sessionId);
    req.user = user;
    req.sessionId = sessionId;
    next();
  };
}
