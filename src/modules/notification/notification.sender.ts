import { randomUUID, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cert, initializeApp, deleteApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { z } from 'zod';

export interface ReminderMessage {
  token: string;
  notificationId: string;
  scheduleId: string;
  deadline: Date;
  now: Date;
}
export interface PushSender {
  send(message: ReminderMessage): Promise<void>;
}

export function buildReminderMessage(input: ReminderMessage): Message {
  const ttl = input.deadline.getTime() - input.now.getTime();
  if (ttl <= 0) throw new Error('Reminder expired');
  const time = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(input.deadline);
  return {
    token: input.token,
    notification: {
      title: 'Pengingat absensi masuk',
      body: `Batas check-in tepat waktu pukul ${time} WIB. Silakan lakukan absensi.`,
    },
    data: {
      type: 'CHECK_IN_REMINDER',
      notification_id: input.notificationId,
      schedule_id: input.scheduleId,
      expires_at: input.deadline.toISOString(),
    },
    android: {
      priority: 'high',
      ttl: Math.min(ttl, 300_000),
      collapseKey: 'check-in-reminder',
      notification: { channelId: 'attendance-reminders', tag: input.notificationId },
    },
  };
}

export function pushError(error: unknown) {
  const raw = (error as { code?: unknown })?.code;
  const code =
    typeof raw === 'string' && /^messaging\/[a-z-]+$/.test(raw) ? raw : 'messaging/unknown-error';
  const invalid = [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ].includes(code);
  const retryable = [
    'messaging/unknown-error',
    'messaging/internal-error',
    'messaging/server-unavailable',
    'messaging/quota-exceeded',
    'messaging/message-rate-exceeded',
    'messaging/device-message-rate-exceeded',
  ].includes(code);
  return { code, invalid, retryable };
}

export async function createFirebaseSender(projectId: string, credentialPath: string) {
  let credentials;
  try {
    credentials = z
      .object({
        type: z.literal('service_account'),
        project_id: z.literal(projectId),
        client_email: z.email(),
        private_key: z.string().min(1),
      })
      .parse(JSON.parse(await readFile(credentialPath, 'utf8')));
    if (!projectId || createPrivateKey(credentials.private_key).asymmetricKeyType !== 'rsa')
      throw new Error('Invalid key');
  } catch {
    throw new Error(
      'Firebase service account is unavailable or does not match FIREBASE_PROJECT_ID',
    );
  }
  const app = initializeApp(
    {
      projectId,
      credential: cert({
        projectId,
        clientEmail: credentials.client_email,
        privateKey: credentials.private_key,
      }),
    },
    'absensi-push-' + randomUUID(),
  );
  const messaging = getMessaging(app);
  return {
    async send(message: ReminderMessage) {
      await messaging.send(buildReminderMessage(message));
    },
    async close() {
      await deleteApp(app);
    },
  };
}
