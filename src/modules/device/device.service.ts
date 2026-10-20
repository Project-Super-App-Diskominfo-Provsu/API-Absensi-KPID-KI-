import type { Pool } from 'pg';
import { transaction, type Db } from '../../database/client.js';
import { audit } from '../../database/audit.js';
import { fail } from '../../shared/errors/api-error.js';
import { hash, token, verifyDeviceSignature } from '../../shared/security/crypto.js';
import type { User } from '../auth/auth.model.js';
import { managedUser } from '../admin/admin.service.js';
import {
  findActiveDeviceById,
  findPendingDevice,
  insertDevice,
  findDevicesByUserId,
  findAdminDevices,
  findDeviceById,
  findDeviceStatusForUpdate,
  revokeActiveDevicesForUser,
  updateDeviceStatus as updateDeviceStatusModel,
  insertAttendanceChallenge,
} from './device.model.js';

export async function activeDevice(db: Db, userId: string, id: string) {
  const row = await findActiveDeviceById(db, userId, id);
  if (!row.rowCount) fail(403, 'DEVICE_NOT_BOUND', 'Perangkat belum disetujui atau sudah dicabut.');
  return row.rows[0]!;
}

export async function bindDevice(
  pool: Pool,
  user: User,
  input: {
    public_key: string;
    platform: 'ANDROID';
    signature: string;
  },
) {
  verifyDeviceSignature(
    input.public_key,
    input.signature,
    `bind:${user.id}:${input.platform}:${hash(input.public_key)}`,
  );

  return transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const pending = await findPendingDevice(db, user.id);
    if (pending.rowCount) {
      fail(409, 'DEVICE_PENDING', 'Permohonan perangkat masih menunggu persetujuan.');
    }

    const inserted = await insertDevice(db, user.id, input.public_key, input.platform);
    await audit(db, user.id, 'DEVICE_BIND_REQUESTED', inserted.rows[0]!.id);
    return inserted.rows[0]!;
  });
}

export async function getUserDevices(pool: Pool, userId: string) {
  const result = await findDevicesByUserId(pool, userId);
  return result.rows;
}

export async function getAdminDevices(pool: Pool, actor: User) {
  const result = await findAdminDevices(
    pool,
    actor.role === 'SUPER_ADMIN',
    actor.employee_category_code,
  );
  return result.rows;
}

export async function updateDevice(
  pool: Pool,
  actor: User,
  id: string,
  input: {
    status: 'ACTIVE' | 'REVOKED';
    reason: string;
  },
) {
  return transaction(pool, async (db) => {
    const device = await findDeviceById(db, id);
    if (!device.rowCount) fail(404, 'NOT_FOUND', 'Perangkat tidak ditemukan.');

    const targetUserId = device.rows[0]!.user_id;
    if (targetUserId === actor.id) {
      fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Persetujuan perangkat sendiri tidak diizinkan.');
    }

    await managedUser(db, actor, targetUserId);
    const current = await findDeviceStatusForUpdate(db, id);

    if (input.status === 'ACTIVE') {
      if (current.rows[0]!.status !== 'PENDING') {
        fail(409, 'DEVICE_STATE_INVALID', 'Hanya perangkat pending dapat disetujui.');
      }
      await revokeActiveDevicesForUser(db, targetUserId);
    }

    const updated = await updateDeviceStatusModel(db, id, input.status);
    await audit(db, actor.id, 'DEVICE_STATUS_CHANGED', id, {
      ...input,
      user_id: targetUserId,
    });

    return updated.rows[0]!;
  });
}

export async function createChallenge(
  pool: Pool,
  user: User,
  input: {
    device_id: string;
    purpose: 'CHECK_IN' | 'CHECK_OUT' | 'ENROLL';
  },
) {
  const nonce = token();
  const row = await transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    await activeDevice(db, user.id, input.device_id);
    const inserted = await insertAttendanceChallenge(
      db,
      user.id,
      input.device_id,
      input.purpose,
      hash(nonce),
    );
    return inserted.rows[0]!;
  });

  return {
    ...row,
    nonce,
    mode: 'PASSIVE_SERVER_PAD',
    purpose: input.purpose,
  };
}
