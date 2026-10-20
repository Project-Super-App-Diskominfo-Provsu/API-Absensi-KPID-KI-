import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/database/client.js';
import { PostgisUnavailableError, requirePostgis } from '../src/database/postgis.js';

describe('PostGIS database prerequisite', () => {
  it('reports the database image prerequisite without leaking SQL or credentials', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) } as unknown as Db;
    await expect(requirePostgis(db, '001_initial.sql')).rejects.toMatchObject({
      name: 'PostgisUnavailableError',
      code: 'POSTGIS_NOT_AVAILABLE',
      migration: '001_initial.sql',
    });
    const error = new PostgisUnavailableError('001_initial.sql');
    expect(error.message).toContain('Dockerfile.postgres');
    expect(error.message).toContain('major version must match existing data');
  });

  it('allows the existing migrator to enable an available PostGIS extension', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as Db;
    await expect(requirePostgis(db, '001_initial.sql')).resolves.toBeUndefined();
  });

  it('preserves database errors instead of diagnosing every failure as missing PostGIS', async () => {
    const failure = Object.assign(new Error('fixture database unavailable'), { code: '08006' });
    const db = { query: vi.fn().mockRejectedValue(failure) } as unknown as Db;
    await expect(requirePostgis(db, '001_initial.sql')).rejects.toBe(failure);
  });
});
