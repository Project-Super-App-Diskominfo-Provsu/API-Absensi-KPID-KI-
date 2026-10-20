import { Router } from 'express';
import type { Pool } from 'pg';
import { roles } from '../auth/auth.middleware.js';
import { createAdminController } from './admin.controller.js';

export function adminRoutes(pool: Pool) {
  const router = Router();
  const controller = createAdminController(pool);

  router.use('/admin', roles('ADMIN', 'SUPER_ADMIN'));

  router.get('/me', controller.me);
  router.get('/admin/users', controller.listUsers);
  router.post('/admin/users', controller.createUser);
  router.patch('/admin/users/:id', controller.updateUser);
  router.get('/admin/units', controller.listUnits);
  router.post('/admin/units', roles('SUPER_ADMIN'), controller.createUnit);
  router.get('/admin/audit-logs', roles('SUPER_ADMIN'), controller.listAuditLogs);
  router.post('/admin/schedules', controller.createSchedule);
  router.get('/schedules', controller.listSchedules);

  return router;
}
