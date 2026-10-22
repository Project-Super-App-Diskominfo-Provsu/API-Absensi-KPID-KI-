import { z } from 'zod';
import { databaseConfigSchema } from './env.js';

const schema = z.object({
  ...databaseConfigSchema.shape,
  FCM_ENABLED: z.literal('true'),
  FIREBASE_PROJECT_ID: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  NOTIFICATION_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(8001),
  NOTIFICATION_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
});
export function readNotificationConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      'Invalid notification environment: ' +
        result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  return result.data;
}
