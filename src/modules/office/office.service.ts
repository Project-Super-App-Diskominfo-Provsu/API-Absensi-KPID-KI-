import type { RedisClientType } from 'redis';
import { locateOffices } from './office.geo.js';
import type { Pool } from 'pg';
import { audit } from '../../database/audit.js';
import { transaction, type Db } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import {
  findActiveCategory,
  checkCategoryOfficePermission,
  findPermittedOffices,
  findOfficesByCategory,
  findAllOffices,
  findOfficeByIdForUpdate,
  updateOfficeData,
  type LocationInput,
  type Office,
} from './office.model.js';

export type { LocationInput, Office };

export async function selectOffice(
  db: Db,
  redis: RedisClientType,
  category: string | null,
  input: LocationInput,
  now: Date,
): Promise<Office> {
  const c = await findActiveCategory(db, category);
  if (!c.rowCount) fail(403, 'EMPLOYEE_CATEGORY_INVALID', 'Kategori pegawai belum valid.');

  if (input.office_id) {
    const allowed = await checkCategoryOfficePermission(db, category, input.office_id);
    if (!allowed.rowCount)
      fail(403, 'OFFICE_NOT_ALLOWED', 'Kategori pegawai tidak diizinkan di kantor ini.');
  }

  const locations = await findPermittedOffices(db, category, input.office_id ?? null);

  if (!locations.rowCount)
    fail(409, 'OFFICE_UNAVAILABLE', 'Lokasi absensi belum siap atau tidak aktif.');

  const distances = await locateOffices(redis, locations.rows, input.latitude, input.longitude);
  const inside: Office[] = locations.rows
    .filter((office) => distances.has(office.id))
    .map((office) => ({ ...office, distance_m: distances.get(office.id)! }))
    .sort((a, b) => a.distance_m - b.distance_m || a.code.localeCompare(b.code));
  if (!inside.length)
    fail(422, 'GEOFENCE_OUT_OF_RANGE', 'Posisi di luar radius 50 meter lokasi yang diizinkan.');

  const accurate = inside.filter((o) => input.accuracy_m <= o.max_gps_accuracy_m);
  if (!accurate.length)
    fail(422, 'GPS_ACCURACY_LOW', 'Akurasi GPS belum memadai. Ambil lokasi ulang.');

  const age = now.getTime() - Date.parse(input.captured_at);
  const office = accurate.find((o) => age >= -5000 && age <= o.max_location_age_s * 1000);
  if (!office)
    fail(422, 'LOCATION_STALE', 'Sampel lokasi kedaluwarsa atau waktu perangkat tidak valid.');

  return office;
}

export async function getOfficesForUser(pool: Pool, categoryCode: string | null) {
  const c = await findActiveCategory(pool, categoryCode);
  if (!c.rowCount) fail(403, 'EMPLOYEE_CATEGORY_INVALID', 'Kategori pegawai belum valid.');

  const rows = await findOfficesByCategory(pool, categoryCode);
  return rows.rows;
}

export async function getAllOfficesForAdmin(pool: Pool) {
  const rows = await findAllOffices(pool);
  return rows.rows;
}

export async function updateOffice(
  pool: Pool,
  actorId: string,
  officeId: string,
  input: {
    name?: string;
    latitude?: number;
    longitude?: number;
    radius_m?: number;
    max_gps_accuracy_m?: number;
    max_location_age_s?: number;
    active?: boolean;
  },
) {
  return transaction(pool, async (db) => {
    const old = await findOfficeByIdForUpdate(db, officeId);
    if (!old.rowCount) fail(404, 'NOT_FOUND', 'Lokasi tidak ditemukan.');

    const merged = { ...old.rows[0], ...input };
    if (
      merged.active &&
      (merged.latitude === null ||
        merged.longitude === null ||
        !merged.max_gps_accuracy_m ||
        !merged.max_location_age_s)
    ) {
      fail(
        400,
        'OFFICE_NOT_CONFIGURED',
        'Koordinat dan kebijakan GPS wajib diisi sebelum aktivasi.',
      );
    }

    if (merged.latitude === 0 && merged.longitude === 0) {
      fail(400, 'COORDINATES_INVALID', 'Koordinat pengganti (0,0) tidak diizinkan.');
    }

    const updated = await updateOfficeData(db, officeId, {
      name: merged.name,
      latitude: merged.latitude,
      longitude: merged.longitude,
      max_gps_accuracy_m: merged.max_gps_accuracy_m,
      max_location_age_s: merged.max_location_age_s,
      active: merged.active,
    });

    await audit(db, actorId, 'OFFICE_UPDATED', officeId, {
      before: old.rows[0]!,
      after: merged,
    });

    return updated.rows[0]!;
  });
}
