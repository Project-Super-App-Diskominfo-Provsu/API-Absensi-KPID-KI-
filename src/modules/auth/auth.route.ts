import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { authMiddleware } from './auth.middleware.js';
import { createAuthController } from './auth.controller.js';
import { createWebAuthController } from './auth.web.controller.js';

export function authRoutes(
  pool: Pool,
  config: Config,
  limiters: { login: RequestHandler[]; refresh: RequestHandler[]; password: RequestHandler[] },
) {
  const router = Router();
  const controller = createAuthController(pool, config);
  const web = createWebAuthController(pool, config);

  router.post('/web/login', ...limiters.login, web.login);
  router.post('/web/session', ...limiters.refresh, web.session);
  router.post('/web/refresh', ...limiters.refresh, web.refresh);
  router.post('/web/logout', web.logout);

  router.post('/login', ...limiters.login, controller.login);
  router.post('/refresh', ...limiters.refresh, controller.refresh);
  router.post('/logout', authMiddleware(pool, config), controller.logout);
  router.post('/logout-all', authMiddleware(pool, config), controller.logoutAll);
  router.post(
    '/change-password',
    authMiddleware(pool, config),
    ...limiters.password,
    controller.changePassword,
  );

  return router;
}
