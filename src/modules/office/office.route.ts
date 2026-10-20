import { Router } from 'express';
import type { Pool } from 'pg';
import { roles } from '../auth/auth.middleware.js';
import { createOfficeController } from './office.controller.js';

export function officeRoutes(pool: Pool) {
  const router = Router();
  const controller = createOfficeController(pool);

  router.get('/offices', controller.getOffices);
  router.get('/admin/offices', roles('ADMIN', 'SUPER_ADMIN'), controller.getAdminOffices);
  router.patch('/admin/offices/:id', roles('SUPER_ADMIN'), controller.patchOffice);

  return router;
}
