import { createClient } from 'redis';
import { pino } from 'pino';
import { readConfig } from './config/env.js';
import { createPool } from './database/client.js';
import { createApp } from './app.js';
const logger = pino();
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => logger.error('PostgreSQL connection error'));
const redis = createClient({ url: config.REDIS_URL });
redis.on('error', () => logger.error('Redis connection error'));
await redis.connect();
await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
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
