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
  getManagedProfile,
  listAdminAttendance,
  listAdminSchedules,
  patchSchedule,
  generateSchedules,
} from './admin.service.js';

import {
  createUserSchema,
  updateUserSchema,
  createUnitSchema,
  scheduleSchema,
  generateSchedulesSchema,
  scheduleQuerySchema,
  userListQuerySchema,
  adminAttendanceQuerySchema,
  adminScheduleQuerySchema,
  patchScheduleSchema,
} from './admin.schema.js';

export function createAdminController(pool: Pool) {
  return {
    async me(req: Request, res: Response) {
      const user = currentUser(req);
      const data = await getMeProfile(pool, user);
      res.json({ data });
    },

    async listUsers(req: Request, res: Response) {
      const query = userListQuerySchema.parse(req.query);
      const user = currentUser(req);
      const result = await listUsers(pool, user, query);
      res.json({ data: result.data, meta: result.meta });
    },
    async getUser(req: Request, res: Response) {
      res.json({
        data: await getManagedProfile(pool, currentUser(req), z.uuid().parse(req.params.id)),
      });
    },
    async listAttendance(req: Request, res: Response) {
      const result = await listAdminAttendance(
        pool,
        currentUser(req),
        adminAttendanceQuerySchema.parse(req.query),
      );
      res.json({ data: result.data, meta: result.meta });
    },
    async listAdminSchedules(req: Request, res: Response) {
      const result = await listAdminSchedules(
        pool,
        currentUser(req),
        adminScheduleQuerySchema.parse(req.query),
      );
      res.json({ data: result.data, meta: result.meta });
    },
    async patchSchedule(req: Request, res: Response) {
      res.json({
        data: await patchSchedule(
          pool,
          currentUser(req),
          z.uuid().parse(req.params.id),
          patchScheduleSchema.parse(req.body),
        ),
      });
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
      const result = await listAuditLogs(pool, limit, offset);
      res.json({ data: result.data, meta: result.meta });
    },

    async createSchedule(req: Request, res: Response) {
      const input = scheduleSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await createSchedule(pool, actor, input);
      res.status(201).json({ data });
    },

    async generateSchedules(req: Request, res: Response) {
      const input = generateSchedulesSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await generateSchedules(pool, actor, input);
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
