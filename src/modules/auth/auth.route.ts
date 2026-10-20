import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { authMiddleware } from './auth.middleware.js';
import { createAuthController } from './auth.controller.js';

export function authRoutes(pool: Pool, config: Config, loginLimiter: RequestHandler) {
  const router = Router();
  const controller = createAuthController(pool, config);

  router.post('/login', loginLimiter, controller.login);
  router.post('/refresh', loginLimiter, controller.refresh);
  router.post('/logout', authMiddleware(pool, config), controller.logout);

  return router;
}
