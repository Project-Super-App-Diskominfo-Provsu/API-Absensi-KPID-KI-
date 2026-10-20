import type { Request, Response } from 'express';
import { z } from 'zod';
import { pagination } from '../../shared/validation/pagination.js';
import type { Pool } from 'pg';
import { currentUser } from '../auth/auth.middleware.js';
import {
  getMeProfile,
  listUsers,
  createUser,
  updateUser,
  listUnits,
  createUnit,
  listAuditLogs,
  createSchedule,
  listSchedules,
} from './admin.service.js';

import {
  createUserSchema,
  updateUserSchema,
  createUnitSchema,
  scheduleSchema,
  scheduleQuerySchema,
} from './admin.schema.js';

export function createAdminController(pool: Pool) {
  return {
    async me(req: Request, res: Response) {
      const user = currentUser(req);
      const data = await getMeProfile(pool, user);
      res.json({ data });
    },

    async listUsers(req: Request, res: Response) {
      const { limit, offset } = pagination.parse(req.query);
      const user = currentUser(req);
      const data = await listUsers(pool, user, limit, offset);
      res.json({ data });
    },

    async createUser(req: Request, res: Response) {
      const input = createUserSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await createUser(pool, actor, input);
      res.status(201).json({ data });
    },

    async updateUser(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const input = updateUserSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await updateUser(pool, actor, id, input);
      res.json({ data });
    },

    async listUnits(_req: Request, res: Response) {
      const data = await listUnits(pool);
      res.json({ data });
    },

    async createUnit(req: Request, res: Response) {
      const { name } = createUnitSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await createUnit(pool, actor.id, name);
      res.status(201).json({ data });
    },

    async listAuditLogs(req: Request, res: Response) {
      const { limit, offset } = pagination.parse(req.query);
      const data = await listAuditLogs(pool, limit, offset);
      res.json({ data });
    },

    async createSchedule(req: Request, res: Response) {
      const input = scheduleSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await createSchedule(pool, actor, input);
      res.status(201).json({ data });
    },

    async listSchedules(req: Request, res: Response) {
      const query = scheduleQuerySchema.parse(req.query);
      const user = currentUser(req);
      const data = await listSchedules(pool, user.id, query.from, query.to);
      res.json({ data });
    },
  };
}
