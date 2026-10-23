import { describe, it, expect } from 'vitest';
import {
  buildReminderMessage,
  pushError,
  createFirebaseSender,
} from '../src/modules/notification/notification.sender.js';
import { readNotificationConfig } from '../src/config/notification-env.js';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FCM reminder payload', () => {
  const input = {
    token: 'test-only-token',
    notificationId: 'job-id',
    scheduleId: 'schedule-id',
    now: new Date('2026-10-22T07:55:00+07:00'),
    deadline: new Date('2026-10-22T08:00:00+07:00'),
  };
  it('uses WIB, a stable notification identity, and a five-minute TTL', () => {
    const message = buildReminderMessage(input);
    expect(message.android).toMatchObject({
      priority: 'high',
      ttl: 300000,
      collapseKey: 'check-in-reminder',
      notification: { tag: 'job-id', channelId: 'attendance-reminders' },
    });
    expect(message.notification?.body).toContain('08.00 WIB');
    expect(message.data).toMatchObject({
      notification_id: 'job-id',
      expires_at: '2026-10-22T01:00:00.000Z',
    });
    expect(JSON.stringify(message)).not.toContain('employee_number');
  });
  it('shortens remaining TTL and refuses messages at the deadline', () => {
    expect(
      buildReminderMessage({ ...input, now: new Date('2026-10-22T07:59:59+07:00') }).android?.ttl,
    ).toBe(1000);
    expect(() => buildReminderMessage({ ...input, now: input.deadline })).toThrow('expired');
  });
  it('only discards explicitly invalid tokens and does not persist raw error messages', () => {
    expect(pushError({ code: 'messaging/registration-token-not-registered' })).toMatchObject({
      invalid: true,
      retryable: false,
    });
    expect(pushError({ code: 'messaging/internal-error' })).toMatchObject({
      invalid: false,
      retryable: true,
    });
    expect(pushError({ code: 'messaging/invalid-argument' })).toMatchObject({
      invalid: false,
      retryable: false,
    });
    expect(pushError({ code: 'private-token-and-untrusted-content', message: 'secret' })).toEqual({
      code: 'messaging/unknown-error',
      invalid: false,
      retryable: true,
    });
  });
  it('reports credential errors without exposing file contents', async () => {
    await expect(
      createFirebaseSender('test-project', 'missing-service-account.json'),
    ).rejects.toThrow('Firebase service account is unavailable');
    await expect(
      createFirebaseSender(
        'test-project',
        undefined,
        Buffer.from('invalid-json').toString('base64'),
      ),
    ).rejects.toThrow('Firebase service account is unavailable');
  });
  it('requires explicit FCM enablement and hides environment values in validation errors', () => {
    expect(() =>
      readNotificationConfig({
        DATABASE_URL: 'postgresql://user:secret@localhost/db',
        FCM_ENABLED: 'false',
      }),
    ).toThrow('Invalid notification environment');
    try {
      readNotificationConfig({ DATABASE_URL: 'private-secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('private-secret-value');
    }
  });
  it('accepts base64 service account configuration in readNotificationConfig', () => {
    const config = readNotificationConfig({
      DATABASE_URL: 'postgresql://user:secret@localhost/db',
      FCM_ENABLED: 'true',
      FIREBASE_PROJECT_ID: 'absensi-439de',
      FIREBASE_SERVICE_ACCOUNT_BASE64: 'e30=',
    });
    expect(config.FIREBASE_SERVICE_ACCOUNT_BASE64).toBe('e30=');
  });
  it('initializes file and base64 credentials without sending or contacting Google', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'absensi-fcm-'));
    const path = join(directory, 'account.json');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const json = JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'sender@test-project.iam.gserviceaccount.com',
      private_key: key,
    });
    try {
      await writeFile(path, json);
      const fromFile = await createFirebaseSender('test-project', path);
      await fromFile.close();
      const fromBase64 = await createFirebaseSender(
        'test-project',
        'unavailable-file',
        Buffer.from(json).toString('base64'),
      );
      await fromBase64.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
