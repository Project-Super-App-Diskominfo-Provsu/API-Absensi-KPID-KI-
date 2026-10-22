import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { z } from 'zod';
import { currentUser } from '../auth/auth.middleware.js';
import { pushTokenSchema } from './notification.schema.js';
import { registerPushToken, unregisterPushToken } from './notification.service.js';

export function createNotificationController(pool: Pool, config: Config) {
  return {
    async register(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const input = pushTokenSchema.parse(req.body);
      await registerPushToken(
        pool,
        config,
        currentUser(req).id,
        req.sessionId!,
        id,
        input.token,
        input.signature,
      );
      res.status(204).end();
    },
    async remove(req: Request, res: Response) {
      await unregisterPushToken(pool, currentUser(req).id, z.uuid().parse(req.params.id));
      res.status(204).end();
    },
  };
}
