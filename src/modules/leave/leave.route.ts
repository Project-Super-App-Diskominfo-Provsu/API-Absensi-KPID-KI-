import { Router } from 'express';
import type { Pool } from 'pg';
import { roles } from '../auth/auth.middleware.js';
import { createLeaveController } from './leave.controller.js';

export function leaveRoutes(pool: Pool) {
  const router = Router();
  const controller = createLeaveController(pool);

  router.post('/leaves', controller.submitLeave);
  router.get('/leaves', controller.listUserLeaves);
  router.delete('/leaves/:id', controller.cancelUserLeave);

  router.get('/admin/leaves', roles('ADMIN', 'SUPER_ADMIN'), controller.adminListLeaves);
  router.patch('/admin/leaves/:id', roles('ADMIN', 'SUPER_ADMIN'), controller.reviewLeave);

  return router;
}
