import { Router } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { roles } from '../auth/auth.middleware.js';
import { upload } from '../../shared/files/image-upload.js';
import { type FaceEngine } from './face.types.js';
import { createFaceController } from './face.controller.js';

export function faceRoutes(pool: Pool, config: Config, engine: FaceEngine) {
  const router = Router();
  const controller = createFaceController(pool, config, engine);

  router.post('/face/enroll', upload.array('images', 5), controller.enroll);
  router.get('/admin/face-enrollments', roles('ADMIN', 'SUPER_ADMIN'), controller.listEnrollments);
  router.patch('/admin/face-enrollments/:id', roles('ADMIN', 'SUPER_ADMIN'), controller.review);
  router.delete('/admin/users/:id/face', roles('ADMIN', 'SUPER_ADMIN'), controller.deleteFace);

  return router;
}
