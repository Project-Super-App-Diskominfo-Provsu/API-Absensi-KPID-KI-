import type { Pool } from 'pg';
import { audit } from '../../database/audit.js';
import { transaction, type Db } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import {
  findActiveCategory,
  checkCategoryOfficePermission,
  findPermittedOfficesWithDistance,
  findOfficesByCategory,
  findAllOffices,
  findOfficeByIdForUpdate,
  updateOfficeData,
  polygonToWkt,
  isValidOfficePolygon,
  type LocationInput,
  type Office,
  type OfficePolygonInput,
} from './office.model.js';

export type { LocationInput, Office, OfficePolygonInput };

export async function selectOffice(
  db: Db,
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

  const locations = await findPermittedOfficesWithDistance(
    db,
    category,
    input.latitude,
    input.longitude,
    input.office_id ?? null,
  );

  if (!locations.rowCount)
    fail(409, 'OFFICE_UNAVAILABLE', 'Lokasi absensi belum siap atau tidak aktif.');

  const inside: Office[] = locations.rows.filter(
    (office) => office.within_polygon && office.within_radius,
  );
  if (!inside.length)
    fail(422, 'GEOFENCE_OUT_OF_RANGE', 'Posisi di luar area kantor yang diizinkan.');

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
    polygon?: OfficePolygonInput;
    radius_m?: number;
    max_gps_accuracy_m?: number;
    max_location_age_s?: number;
    active?: boolean;
  },
) {
  return transaction(pool, async (db) => {
    const old = await findOfficeByIdForUpdate(db, officeId);
    if (!old.rowCount) fail(404, 'NOT_FOUND', 'Lokasi tidak ditemukan.');

    const polygonWkt = input.polygon ? polygonToWkt(input.polygon) : null;
    if (polygonWkt && !(await isValidOfficePolygon(db, polygonWkt)))
      fail(400, 'POLYGON_INVALID', 'Polygon harus valid, tidak kosong, dan tidak menyilang.');
    const merged = { ...old.rows[0], ...input };
    const regeneratePolygon = input.latitude !== undefined || !old.rows[0]!.polygon;

    if (merged.active && (merged.latitude === null || merged.longitude === null)) {
      fail(
        400,
        'OFFICE_NOT_CONFIGURED',
        'Area poligon atau koordinat dan kebijakan GPS wajib diisi sebelum aktivasi.',
      );
    }

    if (merged.active && (!merged.max_gps_accuracy_m || !merged.max_location_age_s)) {
      fail(
        400,
        'OFFICE_NOT_CONFIGURED',
        'Kebijakan GPS (akurasi dan usia lokasi) wajib diisi sebelum aktivasi.',
      );
    }

    if (merged.latitude === 0 && merged.longitude === 0) {
      fail(400, 'COORDINATES_INVALID', 'Koordinat pengganti (0,0) tidak diizinkan.');
    }

    const updated = await updateOfficeData(db, officeId, {
      name: merged.name,
      latitude: merged.latitude,
      longitude: merged.longitude,
      polygonWkt,
      regeneratePolygon,
      radius_m: merged.radius_m,
      max_gps_accuracy_m: merged.max_gps_accuracy_m,
      max_location_age_s: merged.max_location_age_s,
      active: merged.active,
    });

    const saved = await findOfficeByIdForUpdate(db, officeId);
    await audit(db, actorId, 'OFFICE_UPDATED', officeId, {
      before: old.rows[0]!,
      after: saved.rows[0]!,
    });

    return updated.rows[0]!;
  });
}
