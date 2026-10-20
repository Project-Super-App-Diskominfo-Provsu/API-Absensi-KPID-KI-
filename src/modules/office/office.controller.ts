import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { currentUser } from '../auth/auth.middleware.js';
import { getOfficesForUser, getAllOfficesForAdmin, updateOffice } from './office.service.js';

import { patchOfficeSchema } from './office.schema.js';

export function createOfficeController(pool: Pool) {
  return {
    async getOffices(req: Request, res: Response) {
      const user = currentUser(req);
      const data = await getOfficesForUser(pool, user.employee_category_code);
      res.json({ data });
    },

    async getAdminOffices(_req: Request, res: Response) {
      const data = await getAllOfficesForAdmin(pool);
      res.json({ data });
    },

    async patchOffice(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const input = patchOfficeSchema.parse(req.body);
      const user = currentUser(req);
      const data = await updateOffice(pool, user.id, id, input);
      res.json({ data });
    },
  };
}
