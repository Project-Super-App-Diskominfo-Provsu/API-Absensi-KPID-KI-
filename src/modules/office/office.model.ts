import type { Db } from '../../database/client.js';

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  captured_at: string;
  office_id?: string;
}

export interface OfficeLocation {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  max_gps_accuracy_m: number;
  max_location_age_s: number;
  timezone: string;
  active?: boolean;
}

export interface Office extends OfficeLocation {
  distance_m: number;
}
export interface OfficeQueryResult extends Office {
  within_radius: boolean;
}

export const officeFields = `o.id,o.code,o.name,o.radius_m,o.max_gps_accuracy_m,o.max_location_age_s,o.timezone,o.active,
 o.latitude,o.longitude`;

export async function findActiveCategory(db: Db, categoryCode: string | null) {
  return db.query('SELECT code FROM employee_categories WHERE code=$1 AND active', [categoryCode]);
}

export async function checkCategoryOfficePermission(
  db: Db,
  categoryCode: string | null,
  officeId: string,
) {
  return db.query(
    'SELECT 1 FROM category_office_permissions WHERE employee_category_code=$1 AND office_id=$2',
    [categoryCode, officeId],
  );
}

export async function findPermittedOfficesWithDistance(
  db: Db,
  categoryCode: string | null,
  latitude: number,
  longitude: number,
  officeId: string | null,
) {
  return db.query<OfficeQueryResult>(
    `SELECT ${officeFields},
     ST_Distance(ST_SetSRID(ST_MakePoint(o.longitude,o.latitude),4326)::geography,
       ST_SetSRID(ST_MakePoint($3,$2),4326)::geography) AS distance_m,
     ST_DWithin(ST_SetSRID(ST_MakePoint(o.longitude,o.latitude),4326)::geography,
       ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,o.radius_m) AS within_radius
     FROM offices o JOIN category_office_permissions p ON p.office_id=o.id
     WHERE p.employee_category_code=$1 AND o.active AND ($4::uuid IS NULL OR o.id=$4)
     ORDER BY distance_m,o.code`,
    [categoryCode, latitude, longitude, officeId],
  );
}

export async function findOfficesByCategory(db: Db, categoryCode: string | null) {
  return db.query(
    `SELECT ${officeFields} FROM offices o JOIN category_office_permissions p ON p.office_id=o.id WHERE p.employee_category_code=$1 AND o.active ORDER BY o.code`,
    [categoryCode],
  );
}

export async function findAllOffices(db: Db) {
  return db.query(`SELECT ${officeFields} FROM offices o ORDER BY o.code`);
}

export async function findOfficeByIdForUpdate(db: Db, id: string) {
  return db.query(`SELECT ${officeFields} FROM offices o WHERE o.id=$1 FOR UPDATE`, [id]);
}

export async function updateOfficeData(
  db: Db,
  id: string,
  data: {
    name: string;
    latitude: number | null;
    longitude: number | null;
    max_gps_accuracy_m: number;
    max_location_age_s: number;
    active: boolean;
  },
) {
  return db.query<{ id: string }>(
    `UPDATE offices SET name=$2,latitude=$3,longitude=$4,
    max_gps_accuracy_m=$5,max_location_age_s=$6,active=$7 WHERE id=$1 RETURNING id`,
    [
      id,
      data.name,
      data.latitude,
      data.longitude,
      data.max_gps_accuracy_m,
      data.max_location_age_s,
      data.active,
    ],
  );
}
