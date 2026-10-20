import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { loginUser, refreshUserSession, logoutUser } from './auth.service.js';

import { loginSchema, refreshSchema } from './auth.schema.js';

export function createAuthController(pool: Pool, config: Config) {
  return {
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
