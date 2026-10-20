import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/database/redis.js';

it('bounds Redis commands and rejects offline requests without replaying them', async () => {
  const redis = createRedisClient(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379');
  redis.on('error', () => {});
  try {
    await expect(redis.ping()).rejects.toThrow();
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
    const started = performance.now();
    // An empty unique list makes the server wait indefinitely; the client must time out.
    await expect(redis.sendCommand(['BLPOP', `absensi:test:${randomUUID()}`, '0'])).rejects.toThrow(
      /timeout|timed out/i,
    );
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    // Destroy immediately even if a test assertion fails.
    if (redis.isOpen) redis.destroy();
  }
  await expect(redis.ping()).rejects.toThrow();
});
