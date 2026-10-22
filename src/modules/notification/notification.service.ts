import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { transaction } from '../../database/client.js';
import { audit } from '../../database/audit.js';
import { fail } from '../../shared/errors/api-error.js';
import { activeDevice } from '../device/device.service.js';
import { hash, verifyDeviceSignature } from '../../shared/security/crypto.js';
import * as model from './notification.model.js';
import { pushError, type PushSender } from './notification.sender.js';

export function requireNotifications(config: Pick<Config, 'FCM_ENABLED' | 'FIREBASE_PROJECT_ID'>) {
  if (config.FCM_ENABLED !== 'true' || !config.FIREBASE_PROJECT_ID)
    fail(503, 'FCM_NOT_CONFIGURED', 'Notifikasi belum dikonfigurasi.');
}
export async function registerPushToken(
  pool: Pool,
  config: Config,
  userId: string,
  sessionId: string,
  deviceId: string,
  token: string,
  signature: string,
) {
  requireNotifications(config);
  try {
    await transaction(pool, async (db) => {
      const owner = await db.query('SELECT id FROM users WHERE id=$1 AND active FOR UPDATE', [
        userId,
      ]);
      if (!owner.rowCount) fail(403, 'USER_INACTIVE', 'Akun tidak aktif.');
      const session = (await model.mobileSessionFamily(db, userId, sessionId)).rows[0];
      if (!session)
        fail(
          403,
          'MOBILE_SESSION_REQUIRED',
          'Registrasi notifikasi memerlukan sesi Android aktif.',
        );
      const device = await activeDevice(db, userId, deviceId);
      verifyDeviceSignature(
        device.public_key,
        signature,
        `push-token:${userId}:${deviceId}:${hash(token)}`,
      );
      await model.savePushToken(db, deviceId, session.family_id, config.FIREBASE_PROJECT_ID, token);
      await audit(db, userId, 'PUSH_TOKEN_REGISTERED', deviceId);
    });
  } catch (error) {
    if ((error as { code?: string })?.code === '23505')
      fail(409, 'FCM_TOKEN_IN_USE', 'Token notifikasi sudah terdaftar pada perangkat lain.');
    throw error;
  }
}
export async function unregisterPushToken(pool: Pool, userId: string, deviceId: string) {
  await transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const owned = await db.query('SELECT id FROM devices WHERE id=$1 AND user_id=$2', [
      deviceId,
      userId,
    ]);
    if (!owned.rowCount) fail(403, 'DEVICE_NOT_BOUND', 'Perangkat bukan milik pengguna.');
    await model.removePushToken(db, deviceId, userId);
    await audit(db, userId, 'PUSH_TOKEN_REMOVED', deviceId);
  });
}

export async function processCheckInReminders(
  pool: Pool,
  config: Pick<Config, 'FCM_ENABLED' | 'FIREBASE_PROJECT_ID'>,
  sender: PushSender,
  clock: () => Date = () => new Date(),
  limit = 25,
) {
  requireNotifications(config);
  await model.enqueueReminders(pool, config.FIREBASE_PROJECT_ID, clock());
  let processed = 0;
  for (; processed < limit; processed++) {
    const delivery = (await model.claimReminder(pool, clock())).rows[0];
    if (!delivery) break;
    const now = clock();
    const context = (
      await model.reminderContext(pool, delivery.schedule_id, config.FIREBASE_PROJECT_ID, now)
    ).rows[0];
    let reason: string | undefined;
    if (
      !context ||
      !context.active ||
      !['EMPLOYEE', 'VERIFIER'].includes(context.role) ||
      !['KPID', 'KI'].includes(context.employee_category_code ?? '')
    )
      reason = 'ACCOUNT_INELIGIBLE';
    else if (context.checked_in) reason = 'ALREADY_CHECKED_IN';
    else if (context.deadline.getTime() <= now.getTime()) reason = 'EXPIRED';
    else if (!context.token || !context.device_id) reason = 'NO_PUSH_TOKEN';
    else if (!context.session_active) reason = 'SESSION_INACTIVE';
    if (reason || !context) {
      await model.finishReminder(pool, delivery, 'SKIPPED', reason ?? 'ACCOUNT_INELIGIBLE', now);
      continue;
    }
    const due = new Date(context.deadline.getTime() - 300_000);
    if (due > now) {
      await model.retryReminder(pool, delivery, due, context.deadline, 'SCHEDULE_CHANGED', true);
      continue;
    }
    const heartbeat = setInterval(() => {
      void model.renewReminderLease(pool, delivery, clock()).catch(() => {});
    }, 30000);
    heartbeat.unref();
    try {
      await sender.send({
        token: context.token!,
        notificationId: delivery.id,
        scheduleId: delivery.schedule_id,
        deadline: context.deadline,
        now: clock(),
      });
      await model.finishReminder(pool, delivery, 'SENT', null, clock());
    } catch (error) {
      const failure = pushError(error);
      if (failure.invalid)
        await model.discardInvalidToken(pool, context.device_id!, context.token!);
      const retryAt = new Date(
        clock().getTime() + Math.min(60_000, 5000 * 2 ** (delivery.attempts - 1)),
      );
      if (failure.retryable && delivery.attempts < 3 && retryAt < context.deadline)
        await model.retryReminder(pool, delivery, retryAt, context.deadline, failure.code);
      else await model.finishReminder(pool, delivery, 'FAILED', failure.code, clock());
    } finally {
      clearInterval(heartbeat);
    }
  }
  return processed;
}
