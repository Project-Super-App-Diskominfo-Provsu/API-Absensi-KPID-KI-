import { createClient } from 'redis';

export function createRedisClient(url: string) {
  return createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
    // Library command timeout bounds the write queue, not replies already sent.
    commandOptions: { timeout: 3000 },
    pingInterval: 1000,
    socket: {
      connectTimeout: 5000,
      socketTimeout: 3000,
      reconnectStrategy: (retries) =>
        retries >= 10
          ? new Error('Redis reconnect limit reached')
          : Math.min(100 * 2 ** retries, 3000),
    },
  });
}
