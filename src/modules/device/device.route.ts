import { Router } from 'express';
import type { Pool } from 'pg';
import { roles } from '../auth/auth.middleware.js';
import { createDeviceController } from './device.controller.js';

export function deviceRoutes(pool: Pool) {
  const router = Router();
  const controller = createDeviceController(pool);

  router.post('/devices/bind', controller.bind);
  router.get('/devices', controller.list);
  router.get('/admin/devices', roles('ADMIN', 'SUPER_ADMIN'), controller.adminList);
  router.patch('/admin/devices/:id', roles('ADMIN', 'SUPER_ADMIN'), controller.adminUpdate);
  router.post('/attendance/challenges', controller.createChallenge);

  return router;
}
