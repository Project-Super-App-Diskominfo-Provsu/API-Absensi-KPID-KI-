import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { currentUser } from '../auth/auth.middleware.js';
import {
  submitLeave,
  listUserLeaves,
  cancelUserLeave,
  adminListLeaves,
  reviewLeave,
} from './leave.service.js';
import {
  createLeaveSchema,
  leaveQuerySchema,
  adminLeaveQuerySchema,
  reviewLeaveSchema,
} from './leave.schema.js';

export function createLeaveController(pool: Pool) {
  return {
    async submitLeave(req: Request, res: Response) {
      const input = createLeaveSchema.parse(req.body);
      const user = currentUser(req);
      const data = await submitLeave(pool, user, input);
      res.status(201).json({ data });
    },

    async listUserLeaves(req: Request, res: Response) {
      const query = leaveQuerySchema.parse(req.query);
      const user = currentUser(req);
      const result = await listUserLeaves(pool, user.id, query);
      res.json(result);
    },

    async cancelUserLeave(req: Request, res: Response) {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const user = currentUser(req);
      const data = await cancelUserLeave(pool, user, id);
      res.json({ data });
    },

    async adminListLeaves(req: Request, res: Response) {
      const query = adminLeaveQuerySchema.parse(req.query);
      const actor = currentUser(req);
      const result = await adminListLeaves(pool, actor, query);
      res.json(result);
    },

    async reviewLeave(req: Request, res: Response) {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const input = reviewLeaveSchema.parse(req.body);
      const actor = currentUser(req);
      const data = await reviewLeave(pool, actor, id, input);
      res.json({ data });
    },
  };
}
