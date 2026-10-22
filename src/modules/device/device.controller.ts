import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { currentUser } from '../auth/auth.middleware.js';
import { reviewListQuerySchema } from '../../shared/validation/pagination.js';
import {
  bindDevice,
  getUserDevices,
  getAdminDevices,
  updateDevice,
  createChallenge,
} from './device.service.js';

import { bindDeviceSchema, updateDeviceSchema, challengeSchema } from './device.schema.js';

export function createDeviceController(pool: Pool) {
  return {
    async bind(req: Request, res: Response) {
      const input = bindDeviceSchema.parse(req.body);
      const user = currentUser(req);
      const data = await bindDevice(pool, user, input);
      res.status(201).json({ data });
    },

    async list(req: Request, res: Response) {
      const user = currentUser(req);
      const data = await getUserDevices(pool, user.id);
      res.json({ data });
    },

    async adminList(req: Request, res: Response) {
      const actor = currentUser(req);
      const result = await getAdminDevices(pool, actor, reviewListQuerySchema.parse(req.query));
      res.json({ data: result.data, meta: result.meta });
    },

    async adminUpdate(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const input = updateDeviceSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await updateDevice(pool, actor, id, input);
      res.json({ data });
    },

    async createChallenge(req: Request, res: Response) {
      const input = challengeSchema.parse(req.body);
      const user = currentUser(req);
      const data = await createChallenge(pool, user, input);
      res.status(201).json({ data });
    },
  };
}
