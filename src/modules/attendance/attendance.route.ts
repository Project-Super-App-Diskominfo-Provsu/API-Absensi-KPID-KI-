import { Router } from 'express';
import type { RedisClientType } from 'redis';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { upload } from '../../shared/files/image-upload.js';
import { type FaceEngine } from '../face/face.types.js';
import { createAttendanceController } from './attendance.controller.js';

export function attendanceRoutes(
  pool: Pool,
  redis: RedisClientType,
  config: Config,
  engine: FaceEngine,
) {
  const router = Router();
  const controller = createAttendanceController(pool, redis, config, engine);

  router.post('/attendance/check-in', upload.single('image'), controller.checkIn);
  router.post('/attendance/check-out', upload.single('image'), controller.checkOut);
  router.get('/attendance/attempts/:id', controller.getAttempt);
  router.get('/attendance/history', controller.getHistory);

  return router;
}
