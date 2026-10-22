import { Router } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { createNotificationController } from './notification.controller.js';

export function notificationRoutes(pool: Pool, config: Config) {
  const router = Router();
  const controller = createNotificationController(pool, config);
  router.post('/devices/:id/push-token', controller.register);
  router.delete('/devices/:id/push-token', controller.remove);
  return router;
}
