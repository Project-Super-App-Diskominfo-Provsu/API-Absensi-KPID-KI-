import { z } from 'zod';
import { databaseConfigSchema } from './env.js';

const schema = z
  .object({
    ...databaseConfigSchema.shape,
    FCM_ENABLED: z.literal('true'),
    FIREBASE_PROJECT_ID: z.string().min(1),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().default(''),
    FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().default(''),
    NOTIFICATION_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(8001),
    NOTIFICATION_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  })
  .refine(
    (c) => Boolean(c.GOOGLE_APPLICATION_CREDENTIALS || c.FIREBASE_SERVICE_ACCOUNT_BASE64),
    'Set either GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_BASE64',
  );
export function readNotificationConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      'Invalid notification environment: ' +
        result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  return result.data;
}
