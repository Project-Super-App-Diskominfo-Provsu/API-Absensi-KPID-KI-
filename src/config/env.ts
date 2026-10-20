import { z } from 'zod';
import { isIP } from 'node:net';

const score = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().min(0).max(1).optional(),
);
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    DB_MIGRATE_ON_START: z.enum(['true', 'false']).default('false'),
    REDIS_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    BIOMETRIC_KEY_BASE64: z
      .string()
      .default('')
      .refine((v) => v === '' || Buffer.from(v, 'base64').length === 32, 'Must decode to 32 bytes'),
    CORS_ORIGINS: z.string().default(''),
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
    FACE_WORKER_URL: z.string().url().default('http://localhost:8000'),
    FACE_WORKER_TOKEN: z.string().default(''),
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
  return schema.parse(env);
}
