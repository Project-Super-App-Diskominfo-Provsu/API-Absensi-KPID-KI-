import { z } from 'zod';
import { isIP } from 'node:net';

const serviceUrl = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine(
      (value) => URL.canParse(value) && protocols.includes(new URL(value).protocol),
      `Expected protocol: ${protocols.join(', ')}`,
    );

export const databaseConfigSchema = z.object({
  DATABASE_URL: serviceUrl(['postgres:', 'postgresql:']),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(15),
});
export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  return databaseConfigSchema.parse(env);
}

const score = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().min(0).max(1).optional(),
);
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    FCM_ENABLED: z.enum(['true', 'false']).default('false'),
    FIREBASE_PROJECT_ID: z.string().default(''),
    ...databaseConfigSchema.shape,
    DB_MIGRATE_ON_START: z.enum(['true', 'false']).default('false'),
    REDIS_URL: serviceUrl(['redis:', 'rediss:']),
    JWT_SECRET: z.string().min(32),
    BIOMETRIC_KEY_BASE64: z
      .string()
      .default('')
      .refine((v) => v === '' || Buffer.from(v, 'base64').length === 32, 'Must decode to 32 bytes'),
    CORS_ORIGINS: z.string().default(''),
    WEB_AUTH_ENABLED: z.enum(['true', 'false']).default('false'),
    ADMIN_WEB_ORIGIN: z.string().default(''),
    GOOGLE_ENABLED: z.enum(['true', 'false']).default('false'),
    GOOGLE_EMAIL_LINKING_ENABLED: z.enum(['true', 'false']).default('false'),
    GOOGLE_WEB_CLIENT_ID: z.string().default(''),
    GOOGLE_ANDROID_CLIENT_IDS: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    GOOGLE_REDIRECT_URI: z.string().default(''),
    TRUST_PROXY: z
      .string()
      .default('')
      .refine(
        (value) =>
          value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .every((entry) => {
              const [address, prefix, ...rest] = entry.split('/');
              const version = isIP(address ?? '');
              return (
                version > 0 &&
                rest.length === 0 &&
                (prefix === undefined ||
                  (/^\d+$/.test(prefix) &&
                    Number(prefix) >= 0 &&
                    Number(prefix) <= (version === 4 ? 32 : 128)))
              );
            }),
        'TRUST_PROXY must list explicit proxy IP addresses or CIDRs.',
      ),
    SSO_ENABLED: z.enum(['true', 'false']).default('false'),
    SSO_ISSUER: z.string().default(''),
    SSO_CLIENT_ID: z.string().default(''),
    SSO_CLIENT_SECRET: z.string().default(''),
    SSO_REDIRECT_URI: z.string().default(''),
    SSO_TOKEN_AUTH_METHOD: z
      .enum(['none', 'client_secret_basic', 'client_secret_post'])
      .default('none'),
    FACE_WORKER_URL: serviceUrl(['http:', 'https:']).default('http://localhost:8000'),
    FACE_WORKER_TOKEN: z.string().default(''),
    NOTIFICATION_WORKER_URL: serviceUrl(['http:', 'https:']).default('http://localhost:8001'),
    FACE_MODEL_VERSION: z.string().default(''),
    FACE_MATCH_THRESHOLD: score,
    FACE_REVIEW_THRESHOLD: score,
    FACE_LIVENESS_THRESHOLD: score,
    FACE_QUALITY_THRESHOLD: score,
  })
  .refine(
    (c) =>
      c.FACE_REVIEW_THRESHOLD === undefined ||
      c.FACE_MATCH_THRESHOLD === undefined ||
      c.FACE_REVIEW_THRESHOLD < c.FACE_MATCH_THRESHOLD,
    'Review threshold must be lower than match threshold',
  )
  .superRefine((c, ctx) => {
    const validUrl = (value: string, originOnly = false) => {
      try {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === 'https:' ||
            (c.NODE_ENV !== 'production' &&
              url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
          (!originOnly || value === url.origin)
        );
      } catch {
        return false;
      }
    };
    if (c.WEB_AUTH_ENABLED === 'true' && !validUrl(c.ADMIN_WEB_ORIGIN, true))
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_WEB_ORIGIN'],
        message:
          'Web login requires an exact HTTPS admin origin (HTTP localhost is allowed only outside production).',
      });
    if (c.GOOGLE_ENABLED === 'true') {
      if (!c.GOOGLE_WEB_CLIENT_ID.endsWith('.apps.googleusercontent.com'))
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_WEB_CLIENT_ID'],
          message: 'Google login requires a Web OAuth client ID.',
        });
      if (
        c.WEB_AUTH_ENABLED === 'true' &&
        (!c.GOOGLE_CLIENT_SECRET ||
          !validUrl(c.GOOGLE_REDIRECT_URI) ||
          new URL(c.GOOGLE_REDIRECT_URI).pathname !== '/api/v1/auth/web/google/callback')
      )
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_REDIRECT_URI'],
          message:
            'Google web login requires a client secret and the HTTPS API /api/v1/auth/web/google/callback URL.',
        });
    }
    if (c.SSO_ENABLED !== 'true') return;
    let valid = false;
    try {
      const issuer = new URL(c.SSO_ISSUER),
        redirect = new URL(c.SSO_REDIRECT_URI);
      valid =
        issuer.protocol === 'https:' &&
        !issuer.search &&
        !issuer.hash &&
        !issuer.username &&
        !issuer.password &&
        redirect.protocol === 'https:' &&
        !redirect.search &&
        !redirect.hash &&
        !redirect.username &&
        !redirect.password;
    } catch {
      /* Validate configured URLs without accepting request-provided issuers. */
    }
    if (
      !valid ||
      !c.SSO_CLIENT_ID ||
      (c.SSO_TOKEN_AUTH_METHOD !== 'none' && c.SSO_CLIENT_SECRET.length < 1)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Enabled SSO requires HTTPS issuer, HTTPS Android App Link redirect, client ID and matching client authentication configuration.',
      });
  });
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only report names and validation messages, never environment values.
    throw new Error(
      'Invalid environment: ' +
        result.error.issues
          .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
          .join('; '),
    );
  }
  return result.data;
}
