import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRedisClient } from '../src/database/redis.js';
import { locateOffices } from '../src/modules/office/office.geo.js';
import type { OfficeLocation } from '../src/modules/office/office.model.js';

const redis = createRedisClient(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379');
redis.on('error', () => {});
const office: OfficeLocation = {
  id: 'office-a',
  code: 'KPID_SUMUT',
  name: 'KPID',
  latitude: 3.5,
  longitude: 98.6,
  radius_m: 50,
  max_gps_accuracy_m: 15,
  max_location_age_s: 30,
  timezone: 'Asia/Jakarta',
  active: true,
};
beforeAll(async () => {
  await redis.connect();
});
afterAll(() => {
  if (redis.isOpen) redis.destroy();
});

it('isolates concurrent measurements and leaves no office or employee location key behind', async () => {
  const before = await redis.keys('absensi:geo:*');
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      locateOffices(redis, [office], 3.5, i % 2 === 0 ? 98.6 : 98.61),
    ),
  );
  for (let i = 0; i < results.length; i++) expect(results[i]!.has(office.id)).toBe(i % 2 === 0);
  expect((await redis.keys('absensi:geo:*')).sort()).toEqual(before.sort());
});

it('uses changed database coordinates immediately without stale cache', async () => {
  expect((await locateOffices(redis, [office], 3.5, 98.6)).has(office.id)).toBe(true);
  expect((await locateOffices(redis, [{ ...office, longitude: 98.61 }], 3.5, 98.6)).size).toBe(0);
  expect((await locateOffices(redis, [office], 3.5, 98.6)).has(office.id)).toBe(true);
});

it('fails safely for unsupported coordinates and an unavailable Redis connection', async () => {
  await expect(locateOffices(redis, [office], 90, 98.6)).rejects.toMatchObject({
    status: 422,
    code: 'GEOFENCE_COORDINATES_UNSUPPORTED',
  });
  await expect(
    locateOffices(redis, [{ ...office, latitude: 90 }], 3.5, 98.6),
  ).rejects.toMatchObject({ status: 503, code: 'OFFICE_NOT_CONFIGURED' });
  const disconnected = createRedisClient(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379');
  await expect(locateOffices(disconnected, [office], 3.5, 98.6)).rejects.toMatchObject({
    status: 503,
    code: 'GEOFENCE_UNAVAILABLE',
  });
});

it('rejects incomplete ACL permissions before creating a temporary coordinate key', async () => {
  const username = `geo_test_${randomUUID()}`;
  const password = randomUUID();
  const url = new URL(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379');
  url.username = username;
  url.password = password;
  const restricted = createRedisClient(url.toString());
  restricted.on('error', () => {});
  const before = await redis.keys('absensi:geo:*');
  try {
    // EXPIRE is deliberately missing. Other GEO writes would otherwise succeed.
    await redis.sendCommand([
      'ACL',
      'SETUSER',
      username,
      'on',
      `>${password}`,
      '~absensi:geo:*',
      '+eval',
      '+geoadd',
      '+geosearch',
      '+del',
      '+ping',
      '+client',
    ]);
    await restricted.connect();
    await expect(locateOffices(restricted, [office], 3.5, 98.6)).rejects.toMatchObject({
      status: 503,
      code: 'GEOFENCE_UNAVAILABLE',
    });
    expect((await redis.keys('absensi:geo:*')).sort()).toEqual(before.sort());
  } finally {
    if (restricted.isOpen) restricted.destroy();
    await redis.sendCommand(['ACL', 'DELUSER', username]);
  }
});
