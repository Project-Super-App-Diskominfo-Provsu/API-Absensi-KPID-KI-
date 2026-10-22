import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { loginSchema } from './auth.schema.js';
import { loginUser, refreshUserSession } from './auth.service.js';
import { checkWebSession, logoutWebSession, webCsrfToken } from './auth.web.service.js';
import {
  checkWebOrigin,
  webRefresh,
  sendWebSession,
  clearWebRefresh,
} from './auth.web.middleware.js';
import { ApiError } from '../../shared/errors/api-error.js';

export function createWebAuthController(pool: Pool, config: Config) {
  return {
    async login(req: Request, res: Response) {
      checkWebOrigin(req, config);
      const input = loginSchema.parse(req.body);
      sendWebSession(
        res,
        config,
        await loginUser(pool, config, input.email, input.password, 'WEB'),
      );
    },
    async session(req: Request, res: Response) {
      const refresh = webRefresh(req, config, false);
      try {
        await checkWebSession(pool, refresh);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) clearWebRefresh(res, config);
        throw error;
      }
      res.json({ data: { csrf_token: webCsrfToken(config, refresh) } });
    },
    async refresh(req: Request, res: Response) {
      const refresh = webRefresh(req, config);
      try {
        sendWebSession(res, config, await refreshUserSession(pool, config, refresh, 'WEB'));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) clearWebRefresh(res, config);
        throw error;
      }
    },
    async logout(req: Request, res: Response) {
      await logoutWebSession(pool, webRefresh(req, config));
      clearWebRefresh(res, config);
      res.status(204).end();
    },
  };
}
