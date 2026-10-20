import type { Db } from '../../database/client.js';

export interface Device {
  id: string;
  user_id: string;
  public_key: string;
  platform: 'ANDROID';
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  bound_at: string;
}

export interface AttendanceChallenge {
  id: string;
  user_id: string;
  device_id: string;
  purpose: 'CHECK_IN' | 'CHECK_OUT' | 'ENROLL';
  nonce_hash: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function findActiveDeviceById(db: Db, userId: string, id: string) {
  return db.query<{ id: string; public_key: string }>(
    "SELECT id,public_key FROM devices WHERE id=$1 AND user_id=$2 AND status='ACTIVE'",
    [id, userId],
  );
}

export async function findPendingDevice(db: Db, userId: string) {
  return db.query<{ id: string }>("SELECT id FROM devices WHERE user_id=$1 AND status='PENDING'", [
    userId,
  ]);
}

export async function insertDevice(db: Db, userId: string, publicKey: string, platform: 'ANDROID') {
  return db.query<{ id: string; platform: string; status: string }>(
    'INSERT INTO devices(user_id,public_key,platform) VALUES($1,$2,$3) RETURNING id,platform,status',
    [userId, publicKey, platform],
  );
}

export async function findDevicesByUserId(db: Db, userId: string) {
  return db.query<{ id: string; platform: string; status: string; bound_at: string }>(
    'SELECT id,platform,status,bound_at FROM devices WHERE user_id=$1 ORDER BY bound_at DESC',
    [userId],
  );
}

export async function findAdminDevices(db: Db, isSuperAdmin: boolean, categoryCode: string | null) {
  return db.query<{
    id: string;
    user_id: string;
    platform: string;
    status: string;
    bound_at: string;
  }>(
    `SELECT d.id,d.user_id,d.platform,d.status,d.bound_at FROM devices d JOIN users u ON u.id=d.user_id
    WHERE ($1::boolean OR (u.employee_category_code=$2 AND u.role IN ('EMPLOYEE','VERIFIER'))) ORDER BY d.bound_at DESC LIMIT 100`,
    [isSuperAdmin, categoryCode],
  );
}

export async function findDeviceById(db: Db, id: string) {
  return db.query<Device>('SELECT * FROM devices WHERE id=$1', [id]);
}

export async function findDeviceStatusForUpdate(db: Db, id: string) {
  return db.query<{ status: 'PENDING' | 'ACTIVE' | 'REVOKED' }>(
    'SELECT status FROM devices WHERE id=$1 FOR UPDATE',
    [id],
  );
}

export async function revokeActiveDevicesForUser(db: Db, userId: string) {
  return db.query("UPDATE devices SET status='REVOKED' WHERE user_id=$1 AND status='ACTIVE'", [
    userId,
  ]);
}

export async function updateDeviceStatus(db: Db, id: string, status: 'ACTIVE' | 'REVOKED') {
  return db.query<{ id: string; status: string }>(
    'UPDATE devices SET status=$2 WHERE id=$1 RETURNING id,status',
    [id, status],
  );
}

export async function insertAttendanceChallenge(
  db: Db,
  userId: string,
  deviceId: string,
  purpose: 'CHECK_IN' | 'CHECK_OUT' | 'ENROLL',
  nonceHash: string,
) {
  return db.query<{ id: string; expires_at: string }>(
    `INSERT INTO attendance_challenges(user_id,device_id,purpose,nonce_hash,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '90 seconds') RETURNING id,expires_at`,
    [userId, deviceId, purpose, nonceHash],
  );
}

export async function consumeAttendanceChallenge(
  db: Db,
  nonceHash: string,
  userId: string,
  deviceId: string,
  purpose: 'CHECK_IN' | 'CHECK_OUT' | 'ENROLL',
) {
  return db.query<{ id: string; created_at: Date }>(
    `UPDATE attendance_challenges SET consumed_at=now() WHERE nonce_hash=$1 AND user_id=$2 AND device_id=$3
    AND purpose=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING id,created_at`,
    [nonceHash, userId, deviceId, purpose],
  );
}
