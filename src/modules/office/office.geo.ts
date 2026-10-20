import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { ApiError, fail } from '../../shared/errors/api-error.js';
import type { OfficeLocation } from './office.model.js';

// One atomic operation, with no shared cache or stored employee location.
// TTL also bounds lifetime if a Redis command fails before DEL.
const locate = `
local commands = {
  {'GEOADD', KEYS[1], unpack(ARGV, 3)},
  {'EXPIRE', KEYS[1], 10},
  {'GEOSEARCH', KEYS[1], 'FROMLONLAT', ARGV[1], ARGV[2], 'BYRADIUS', 50, 'm', 'WITHDIST'},
  {'DEL', KEYS[1]}
}
-- Check all permissions before any write: Lua errors do not roll back Redis writes.
for _, command in ipairs(commands) do
  if not redis.acl_check_cmd(unpack(command)) then
    return redis.error_reply('GEO command permission denied')
  end
end
redis.call(unpack(commands[1]))
redis.call(unpack(commands[2]))
local matches = redis.call(unpack(commands[3]))
redis.call(unpack(commands[4]))
return matches
`;
export const GEO_MAX_LATITUDE = 85.05112878;

export async function locateOffices(
  redis: RedisClientType,
  offices: OfficeLocation[],
  latitude: number,
  longitude: number,
): Promise<Map<string, number>> {
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > GEO_MAX_LATITUDE ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    fail(422, 'GEOFENCE_COORDINATES_UNSUPPORTED', 'Koordinat di luar cakupan Redis GEO.');
  if (
    offices.some(
      (office) =>
        !Number.isFinite(office.latitude) ||
        Math.abs(office.latitude) > GEO_MAX_LATITUDE ||
        !Number.isFinite(office.longitude) ||
        Math.abs(office.longitude) > 180,
    )
  )
    fail(503, 'OFFICE_NOT_CONFIGURED', 'Koordinat kantor tidak mendukung Redis GEO.');
  if (!offices.length) return new Map();
  try {
    const result = await redis.eval(locate, {
      keys: [`absensi:geo:${randomUUID()}`],
      arguments: [
        String(longitude),
        String(latitude),
        ...offices.flatMap((office) => [
          String(office.longitude),
          String(office.latitude),
          office.id,
        ]),
      ],
    });
    if (!Array.isArray(result)) throw new Error('Invalid GEO response');
    const permitted = new Set(offices.map((office) => office.id));
    const distances = new Map<string, number>();
    for (const match of result) {
      if (
        !Array.isArray(match) ||
        match.length !== 2 ||
        typeof match[0] !== 'string' ||
        typeof match[1] !== 'string' ||
        !permitted.has(match[0])
      )
        throw new Error('Invalid GEO match');
      const distance = Number(match[1]);
      if (!Number.isFinite(distance) || distance < 0 || distance > 50)
        throw new Error('Invalid GEO distance');
      distances.set(match[0], distance);
    }
    return distances;
  } catch {
    throw new ApiError(
      503,
      'GEOFENCE_UNAVAILABLE',
      'Pengukuran lokasi belum tersedia. Coba kembali.',
    );
  }
}
