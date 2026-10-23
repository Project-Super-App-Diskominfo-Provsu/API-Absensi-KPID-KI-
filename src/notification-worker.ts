import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import { readNotificationConfig } from './config/notification-env.js';
import { createPool } from './database/client.js';
import { verifyDatabaseSchema } from './database/migrate.js';
import { createFirebaseSender } from './modules/notification/notification.sender.js';
import { processCheckInReminders } from './modules/notification/notification.service.js';

const logger = pino();
const config = readNotificationConfig();
const pool = createPool(config.DATABASE_URL, Math.min(config.DB_POOL_MAX, 5));
pool.on('error', () => logger.error('Notification PostgreSQL connection error'));
try {
  await verifyDatabaseSchema(pool);
  const sender = await createFirebaseSender(
    config.FIREBASE_PROJECT_ID,
    config.GOOGLE_APPLICATION_CREDENTIALS,
    config.FIREBASE_SERVICE_ACCOUNT_BASE64,
  );
  let stopping = false,
    lastSuccess = 0;
  const controller = new AbortController();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url !== '/ready') {
      res.writeHead(404);
      res.end();
      return;
    }
    const ready = Date.now() - lastSuccess < Math.max(60000, config.NOTIFICATION_POLL_MS * 3);
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ready }));
  });
  server.on('error', () => {
    logger.fatal('Notification worker listener failed');
    process.exit(1);
  });
  server.listen(config.NOTIFICATION_WORKER_PORT, () =>
    logger.info({ port: config.NOTIFICATION_WORKER_PORT }, 'Notification worker started'),
  );
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    server.close();
    setTimeout(() => process.exit(1), 20000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  while (!stopping) {
    try {
      const processed = await processCheckInReminders(pool, config, sender);
      lastSuccess = Date.now();
      if (processed) logger.info({ processed }, 'Notification jobs processed');
    } catch {
      lastSuccess = 0;
      logger.error('Notification processing failed; leases will be retried');
    }
    try {
      await delay(config.NOTIFICATION_POLL_MS, undefined, { signal: controller.signal });
    } catch {}
  }
  await sender.close();
  await pool.end();
} catch {
  logger.fatal(
    'Notification worker startup failed. Check migrations, Firebase project and credential mount.',
  );
  await pool.end();
  process.exitCode = 1;
}
