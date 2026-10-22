import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { transaction } from '../../database/client.js';
import { audit } from '../../database/audit.js';
import { fail } from '../../shared/errors/api-error.js';
import { hash, encrypt, verifyDeviceSignature } from '../../shared/security/crypto.js';
import type { User } from '../auth/auth.model.js';
import { managedUser } from '../admin/admin.service.js';
import { activeDevice } from '../device/device.service.js';
import { consumeAttendanceChallenge } from '../device/device.model.js';
import {
  findActiveOrPendingTemplate,
  insertFaceTemplate,
  findPendingFaceEnrollments,
  findFaceTemplateById,
  updateFaceTemplateApproval,
  deleteFaceTemplatesByUserId,
  findActiveEnrollmentUserForUpdate,
  incrementEnrollmentVersion,
} from './face.model.js';

import type { FaceEngine, FaceObservation } from './face.types.js';
import { facePolicy, normalize, similarity, validateObservation } from './face.policy.js';
import { validateImage } from '../../shared/files/image-upload.js';
export async function enrollFace(
  pool: Pool,
  config: Config,
  engine: FaceEngine,
  user: User,
  input: {
    device_id: string;
    nonce: string;
    signature: string;
    consent_version: string;
    consent: 'true';
  },
  files: Express.Multer.File[],
) {
  facePolicy(config);
  if (!files || files.length < 3) {
    fail(400, 'ENROLL_IMAGES_REQUIRED', 'Enrollment membutuhkan 3 sampai 5 foto.');
  }
  const images = await Promise.all(files.map(validateImage));
  const digests = images.map(hash);
  if (new Set(digests).size !== digests.length) {
    fail(400, 'ENROLL_IMAGES_DUPLICATE', 'Gunakan foto yang berbeda.');
  }

  const enrollmentVersion = await transaction(pool, async (db) => {
    const active = await findActiveEnrollmentUserForUpdate(db, user.id);
    if (!active.rowCount) fail(403, 'USER_INACTIVE', 'Akun tidak aktif.');
    const device = await activeDevice(db, user.id, input.device_id);
    verifyDeviceSignature(
      device.public_key,
      input.signature,
      `enroll:${user.id}:${input.device_id}:${input.nonce}:${input.consent_version}:${digests.join(':')}`,
    );
    const nonce = await consumeAttendanceChallenge(
      db,
      hash(input.nonce),
      user.id,
      input.device_id,
      'ENROLL',
    );
    if (!nonce.rowCount) {
      fail(409, 'REPLAY_DETECTED', 'Challenge tidak valid, kedaluwarsa, atau telah digunakan.');
    }
    const existing = await findActiveOrPendingTemplate(db, user.id);
    if (existing.rowCount) {
      fail(409, 'FACE_ALREADY_ENROLLED', 'Reset enrollment melalui admin sebelum mendaftar ulang.');
    }
    await audit(db, user.id, 'FACE_ENROLL_STARTED', user.id);
    return active.rows[0]!.face_enrollment_version;
  });

  const observations: FaceObservation[] = [];
  for (const image of images) {
    const obs = await engine.observe(image, input.nonce);
    validateObservation(obs, config);
    observations.push(obs);
  }

  const first = observations[0]!;
  for (const value of observations.slice(1)) {
    if (similarity(first.embedding, value.embedding) < facePolicy(config).match) {
      fail(
        422,
        'ENROLL_FACE_INCONSISTENT',
        'Foto enrollment tidak menunjukkan wajah yang konsisten.',
      );
    }
  }

  const mean = normalize(
    first.embedding.map(
      (_, i) =>
        observations.reduce((n, v) => n + normalize(v.embedding)[i]!, 0) / observations.length,
    ),
  );

  return transaction(pool, async (db) => {
    const active = await findActiveEnrollmentUserForUpdate(db, user.id);
    if (!active.rowCount) fail(403, 'USER_INACTIVE', 'Akun tidak aktif.');
    if (active.rows[0]!.face_enrollment_version !== enrollmentVersion) {
      fail(
        409,
        'FACE_ENROLLMENT_CHANGED',
        'Enrollment berubah atau direset. Mulai enrollment baru.',
      );
    }
    await activeDevice(db, user.id, input.device_id);
    const existing = await findActiveOrPendingTemplate(db, user.id);
    if (existing.rowCount) {
      fail(409, 'FACE_ALREADY_ENROLLED', 'Reset enrollment melalui admin sebelum mendaftar ulang.');
    }
    const inserted = await insertFaceTemplate(
      db,
      user.id,
      encrypt(mean, config.BIOMETRIC_KEY_BASE64, user.id),
      first.model_version,
      Math.min(...observations.map((v) => v.quality_score)),
      input.consent_version,
    );
    await incrementEnrollmentVersion(db, user.id);
    await audit(db, user.id, 'FACE_ENROLL_PENDING', inserted.rows[0]!.id);
    return inserted.rows[0]!;
  });
}

export async function listPendingFaceEnrollments(pool: Pool, actor: User) {
  const result = await findPendingFaceEnrollments(
    pool,
    actor.role === 'SUPER_ADMIN',
    actor.employee_category_code,
  );
  return result.rows;
}

export async function reviewFaceEnrollment(
  pool: Pool,
  actor: User,
  id: string,
  input: {
    status: 'ACTIVE' | 'REVOKED';
    identity_verified: boolean;
    reason: string;
  },
) {
  if (input.status === 'ACTIVE' && !input.identity_verified) {
    fail(400, 'IDENTITY_VERIFICATION_REQUIRED', 'Identitas wajib diperiksa sebelum persetujuan.');
  }

  await transaction(pool, async (db) => {
    const row = await findFaceTemplateById(db, id);
    if (!row.rowCount) fail(404, 'NOT_FOUND', 'Enrollment tidak ditemukan.');
    const owner = row.rows[0]!.user_id;
    if (owner === actor.id) {
      fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Persetujuan wajah sendiri tidak diizinkan.');
    }
    await managedUser(db, actor, owner);
    const updated = await updateFaceTemplateApproval(db, id, input.status, actor.id);
    if (!updated.rowCount) fail(409, 'FACE_STATE_INVALID', 'Enrollment sudah diproses.');
    await audit(db, actor.id, 'FACE_ENROLL_REVIEWED', id, input);
  });
}

export async function deleteUserFaceData(pool: Pool, actor: User, userId: string, reason: string) {
  await transaction(pool, async (db) => {
    if (userId === actor.id) {
      fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Reset wajah sendiri tidak diizinkan.');
    }
    await managedUser(db, actor, userId);
    await incrementEnrollmentVersion(db, userId);
    await deleteFaceTemplatesByUserId(db, userId);
    await audit(db, actor.id, 'FACE_DATA_DELETED', userId, { reason });
  });
}
