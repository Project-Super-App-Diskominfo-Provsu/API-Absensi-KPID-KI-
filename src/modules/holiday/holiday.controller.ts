import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { currentUser } from '../auth/auth.middleware.js';
import { listHolidays, createHoliday, removeHoliday } from './holiday.service.js';
import { createHolidaySchema, holidayQuerySchema } from './holiday.schema.js';

export function createHolidayController(pool: Pool) {
  return {
    async listHolidays(req: Request, res: Response) {
      const query = holidayQuerySchema.parse(req.query);
      const data = await listHolidays(pool, query.from, query.to);
      res.json({ data });
    },

    async createHoliday(req: Request, res: Response) {
      const input = createHolidaySchema.parse(req.body);
      const actor = currentUser(req);
      const data = await createHoliday(pool, actor, input);
      res.status(201).json({ data });
    },

    async deleteHoliday(req: Request, res: Response) {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const actor = currentUser(req);
      const data = await removeHoliday(pool, actor, id);
      res.json({ data });
    },
  };
}
