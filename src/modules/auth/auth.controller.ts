import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import {
  loginUser,
  refreshUserSession,
  logoutUser,
  logoutAllUserSessions,
  changePassword,
} from './auth.service.js';
import { currentUser } from './auth.middleware.js';

import { loginSchema, refreshSchema, changePasswordSchema } from './auth.schema.js';

export function createAuthController(pool: Pool, config: Config) {
  return {
    async changePassword(req: Request, res: Response) {
      const input = changePasswordSchema.parse(req.body);
      await changePassword(pool, currentUser(req).id, input.current_password, input.new_password);
      res.status(204).end();
    },
    async logoutAll(req: Request, res: Response) {
      await logoutAllUserSessions(pool, currentUser(req).id);
      res.status(204).end();
    },
    async login(req: Request, res: Response) {
      const input = loginSchema.parse(req.body);
      const result = await loginUser(pool, config, input.email, input.password);
      res.json({ data: result });
    },

    async refresh(req: Request, res: Response) {
      const input = refreshSchema.parse(req.body);
      const result = await refreshUserSession(pool, config, input.refresh_token);
      res.json({ data: result });
    },

    async logout(req: Request, res: Response) {
      if (req.sessionId) {
        await logoutUser(pool, req.sessionId);
      }
      res.status(204).end();
    },
  };
}
