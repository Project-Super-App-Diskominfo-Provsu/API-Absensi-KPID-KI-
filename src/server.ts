import { createRedisClient } from './database/redis.js';
import { pino } from 'pino';
import { readConfig } from './config/env.js';
import { createPool } from './database/client.js';
import {
  migrateDatabase,
  verifyDatabaseSchema,
  SchemaVerificationError,
} from './database/migrate.js';
import { createApp } from './app.js';
import { createServer } from 'node:http';
const logger = pino();
const config = readConfig();
if (!config.BIOMETRIC_KEY_BASE64) {
  logger.warn(
    'Biometric encryption key is not configured; enrollment and biometric attendance are disabled.',
  );
}
const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
pool.on('error', () => logger.error('PostgreSQL connection error'));
try {
  if (config.DB_MIGRATE_ON_START === 'true') {
    const applied = await migrateDatabase(pool);
    logger.info({ applied }, 'Database migrations checked');
  } else {
    await verifyDatabaseSchema(pool);
  }
} catch (error) {
  logger.fatal(
    {
      code: (error as { code?: string })?.code,
      error_type: error?.constructor?.name,
      migration: (error as { migration?: string })?.migration,
      ...(error instanceof SchemaVerificationError ? { detail: error.message } : {}),
    },
    config.DB_MIGRATE_ON_START === 'true'
      ? 'Database migration failed. Check the reported migration, checksums and database permissions. PostgreSQL must have PostGIS packages installed for migration 004. Changes were rolled back.'
      : 'Database schema is unavailable. Run npm run db:migrate locally or npm run db:migrate:production in the image.',
  );
  await pool.end();
  process.exit(1);
}
const redis = createRedisClient(config.REDIS_URL);
redis.on('error', () => logger.error('Redis connection error'));
try {
  await redis.connect();
} catch {
  logger.fatal('Redis startup failed. Check REDIS_URL, credentials, TLS and deployment network.');
  if (redis.isOpen) redis.destroy();
  await pool.end();
  process.exit(1);
}
const server = createServer(createApp(pool, redis, config));
server.on('listening', () => logger.info({ port: config.PORT }, 'Absensi API started'));
server.on('error', (error: NodeJS.ErrnoException) => {
  logger.fatal(
    { code: error.code, port: config.PORT },
    error.code === 'EADDRINUSE'
      ? 'HTTP port is already in use. Stop the existing API process or choose another PORT.'
      : 'HTTP listener failed. Check PORT and listener permissions.',
  );
  void Promise.allSettled([pool.end(), redis.close()]).then(() => process.exit(1));
});
server.listen(config.PORT);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(1), 15000);
  force.unref();
  server.close(() => {
    void Promise.all([pool.end(), redis.quit()])
      .then(() => {
        clearTimeout(force);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
