import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { currentUser } from '../auth/auth.middleware.js';
import { validateImage } from '../../shared/files/image-upload.js';
import { type FaceEngine } from '../face/face.types.js';
import {
  recordAttendance,
  getAttendanceAttempt,
  getAttendanceHistory,
  type Purpose,
  type AttendanceInputData,
} from './attendance.service.js';

import { attendanceInput, attendanceHistoryQuerySchema } from './attendance.schema.js';

export function createAttendanceController(pool: Pool, config: Config, engine: FaceEngine) {
  async function handleAttendance(purpose: Purpose, req: Request, res: Response) {
    const input = attendanceInput.parse(req.body) as AttendanceInputData;
    const image = await validateImage(req.file);
    const key = z
      .string()
      .min(16)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(req.get('Idempotency-Key'));
    const user = currentUser(req);

    const result = await recordAttendance(pool, config, engine, user, purpose, key, input, image);

    res.status(result.httpStatus).json({ ...result.body, request_id: res.locals.requestId });
  }

  return {
    checkIn: (req: Request, res: Response) => handleAttendance('CHECK_IN', req, res),
    checkOut: (req: Request, res: Response) => handleAttendance('CHECK_OUT', req, res),

    async getAttempt(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const user = currentUser(req);
      const data = await getAttendanceAttempt(pool, user.id, id);
      res.json({ data });
    },

    async getHistory(req: Request, res: Response) {
      const q = attendanceHistoryQuerySchema.parse(req.query);
      const user = currentUser(req);
      const data = await getAttendanceHistory(pool, user.id, q.from, q.to, q.limit, q.offset);
      res.json({ data });
    },
  };
}
