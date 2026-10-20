import { createClient } from 'redis';
import { pino } from 'pino';
import { readConfig } from './config/env.js';
import { createPool } from './database/client.js';
import { migrateDatabase } from './database/migrate.js';
import { createApp } from './app.js';
const logger = pino();
const config = readConfig();
if (!config.BIOMETRIC_KEY_BASE64) {
  logger.warn(
    'Biometric encryption key is not configured; enrollment and biometric attendance are disabled.',
  );
}
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => logger.error('PostgreSQL connection error'));
try {
  if (config.DB_MIGRATE_ON_START === 'true') {
    const applied = await migrateDatabase(pool);
    logger.info({ applied }, 'Database migrations checked');
  } else {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  }
} catch (error) {
  logger.fatal(
    { code: (error as { code?: string })?.code, error_type: error?.constructor?.name },
    config.DB_MIGRATE_ON_START === 'true'
      ? 'Database migration failed. Check migration checksums, PostgreSQL/PostGIS availability and database role permissions. Changes in the failed migration transaction were rolled back.'
      : 'Database schema is unavailable. Run db:migrate:production or enable DB_MIGRATE_ON_START=true.',
  );
  await pool.end();
  process.exit(1);
}
const redis = createClient({ url: config.REDIS_URL });
redis.on('error', () => logger.error('Redis connection error'));
await redis.connect();
const server = createApp(pool, redis, config).listen(config.PORT, () =>
  logger.info({ port: config.PORT }, 'Absensi API started'),
);
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
