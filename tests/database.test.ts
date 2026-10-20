import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { transaction } from '../src/database/client.js';

it('preserves the original failure and discards a connection if rollback also fails', async () => {
  const failure = new Error('connection lost during work');
  const db = {
    query: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('rollback failed')),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(db) } as unknown as Pool;
  await expect(
    transaction(pool, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
});
