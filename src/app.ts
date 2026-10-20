import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import type { Config } from './config/env.js';
import { authMiddleware } from './modules/auth/auth.middleware.js';
import { authRoutes } from './modules/auth/auth.route.js';
import { officeRoutes } from './modules/office/office.route.js';
import { adminRoutes } from './modules/admin/admin.route.js';
import { deviceRoutes } from './modules/device/device.route.js';
import { faceRoutes } from './modules/face/face.route.js';
import { HttpFaceEngine } from './modules/face/face.client.js';
import { type FaceEngine } from './modules/face/face.types.js';
import { attendanceRoutes } from './modules/attendance/attendance.route.js';
import { ssoRoutes } from './modules/sso/sso.route.js';
import type { SsoProvider } from './modules/sso/sso.service.js';
import { errorHandler } from './middleware/error-handler.js';
import { hash } from './shared/security/crypto.js';
import { openapi } from './docs/openapi.js';

export function createApp(
  pool: Pool,
  redis: RedisClientType,
  config: Config,
  engine: FaceEngine = new HttpFaceEngine(config),
  ssoProvider?: SsoProvider,
) {
  if (!redis.isReady) throw new Error('Connect Redis before creating the application.');
  const app = express();
  const logger = pino({ level: config.NODE_ENV === 'test' ? 'silent' : 'info' });
  const rateNamespace = config.NODE_ENV === 'test' ? `${randomUUID()}:` : '';
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set('X-Request-Id', res.locals.requestId);
    res.set('Cache-Control', 'no-store');
    const start = performance.now();
    res.on('finish', () =>
      logger.info(
        {
          request_id: res.locals.requestId,
          method: req.method,
          path: req.route?.path ?? 'unmatched',
          status: res.statusCode,
          duration_ms: Math.round(performance.now() - start),
        },
        'request',
      ),
    );
    next();
  });
  app.use(helmet());
  const origins = config.CORS_ORIGINS.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    }),
  );
  app.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
  app.get('/ready', async (_req, res) => {
    const result = await Promise.allSettled([
      pool.query('SELECT 1 FROM category_office_permissions LIMIT 1'),
      redis.ping(),
      engine.ready(),
    ]);
    const db = result[0].status === 'fulfilled',
      cache = result[1].status === 'fulfilled',
      face = result[2].status === 'fulfilled' && result[2].value;
    res
      .status(db && cache && face ? 200 : 503)
      .json({ data: { database: db, redis: cache, face_worker: face } });
  });
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
  function limiter(prefix: string, limit: number, keyGenerator?: (req: express.Request) => string) {
    return rateLimit({
      windowMs: 15 * 60000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: new RedisStore({
        prefix: prefix + rateNamespace,
        sendCommand: (...args: string[]) => redis.sendCommand(args),
      }),
      keyGenerator,
      handler: (_req, res) =>
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Terlalu banyak permintaan.' },
          request_id: res.locals.requestId,
        }),
    });
  }
  app.use('/api/v1', limiter('absensi:global:', 3000));
  app.use(express.json({ limit: '64kb' }));
  app.use(
    '/api/v1/auth',
    authRoutes(
      pool,
      config,
      limiter(
        'absensi:login:',
        10,
        (req) =>
          `${ipKeyGenerator(req.ip ?? '127.0.0.1')}:${hash(String(req.body?.email ?? '').toLowerCase())}`,
      ),
    ),
  );
  app.use('/api/v1', ssoRoutes(pool, config, limiter('absensi:sso:', 30), ssoProvider));
  app.use('/api/v1', authMiddleware(pool, config));
  app.use(
    '/api/v1',
    officeRoutes(pool),
    adminRoutes(pool),
    deviceRoutes(pool),
    faceRoutes(pool, config, engine),
    attendanceRoutes(pool, config, engine),
  );
  app.use((_req, res) =>
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' },
      request_id: res.locals.requestId,
    }),
  );
  app.use(errorHandler(logger));
  return app;
}
