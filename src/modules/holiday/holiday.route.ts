import { Router } from 'express';
import type { Pool } from 'pg';
import { roles } from '../auth/auth.middleware.js';
import { createHolidayController } from './holiday.controller.js';

export function holidayRoutes(pool: Pool) {
  const router = Router();
  const controller = createHolidayController(pool);

  router.get('/holidays', controller.listHolidays);
  router.get('/admin/holidays', roles('ADMIN', 'SUPER_ADMIN'), controller.listHolidays);
  router.post('/admin/holidays', roles('ADMIN', 'SUPER_ADMIN'), controller.createHoliday);
  router.delete('/admin/holidays/:id', roles('ADMIN', 'SUPER_ADMIN'), controller.deleteHoliday);

  return router;
}
