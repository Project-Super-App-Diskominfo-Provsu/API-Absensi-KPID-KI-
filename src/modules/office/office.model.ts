import type { Db } from '../../database/client.js';

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  captured_at: string;
  office_id?: string;
}

export type OfficePolygonInput =
  | Array<{ latitude: number; longitude: number }>
  | { type: 'Polygon'; coordinates: [number, number][][] };

export function polygonToWkt(input: OfficePolygonInput): string {
  const rings: [number, number][][] = Array.isArray(input)
    ? [input.map((point) => [point.longitude, point.latitude])]
    : input.coordinates;
  return (
    'POLYGON(' +
    rings
      .map((coordinates) => {
        const ring = [...coordinates];
        const first = ring[0]!;
        const last = ring[ring.length - 1]!;
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
        return (
          '(' + ring.map(([longitude, latitude]) => longitude + ' ' + latitude).join(',') + ')'
        );
      })
      .join(',') +
    ')'
  );
}

export async function isValidOfficePolygon(db: Db, wkt: string): Promise<boolean> {
  const result = await db.query<{ valid: boolean }>(
    'SELECT ST_IsValid(p) AND NOT ST_IsEmpty(p) AND ST_Area(p) > 0 AS valid FROM (SELECT ST_GeomFromText($1,4326) AS p) q',
    [wkt],
  );
  return result.rows[0]?.valid === true;
}

export interface OfficeLocation {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  polygon?: unknown;
  radius_m?: number | null;
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
  within_polygon: boolean;
}

export const officeFields = `o.id,o.code,o.name,o.address,o.radius_m,o.max_gps_accuracy_m,o.max_location_age_s,o.timezone,o.active,
 o.latitude,o.longitude,
 CASE WHEN o.polygon IS NOT NULL THEN ST_AsGeoJSON(o.polygon)::json ELSE NULL END AS polygon`;

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
     COALESCE(ST_Covers(o.polygon, ST_SetSRID(ST_MakePoint($3,$2),4326)),false) AS within_polygon,
     COALESCE(ST_DWithin(ST_SetSRID(ST_MakePoint(o.longitude,o.latitude),4326)::geography,
       ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,50),false) AS within_radius
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
    polygonWkt: string | null;
    regeneratePolygon: boolean;
    radius_m?: number | null;
    max_gps_accuracy_m: number;
    max_location_age_s: number;
    active: boolean;
  },
) {
  return db.query<{ id: string }>(
    `UPDATE offices SET
      name = $2,
      latitude = COALESCE($3, CASE WHEN $4::text IS NOT NULL THEN ST_Y(ST_Centroid(ST_GeomFromText($4,4326))) ELSE latitude END),
      longitude = COALESCE($5, CASE WHEN $4::text IS NOT NULL THEN ST_X(ST_Centroid(ST_GeomFromText($4,4326))) ELSE longitude END),
      polygon = CASE
        WHEN $4::text IS NOT NULL THEN ST_GeomFromText($4,4326)
        WHEN $10::boolean AND $3::float8 IS NOT NULL AND $5::float8 IS NOT NULL
          THEN ST_Buffer(ST_SetSRID(ST_MakePoint($5,$3),4326)::geography,50,'quad_segs=64')::geometry
        ELSE polygon END,
      radius_m = COALESCE($6, 50),
      max_gps_accuracy_m = $7,
      max_location_age_s = $8,
      active = $9
    WHERE id = $1 RETURNING id`,
    [
      id,
      data.name,
      data.latitude,
      data.polygonWkt,
      data.longitude,
      data.radius_m ?? null,
      data.max_gps_accuracy_m,
      data.max_location_age_s,
      data.active,
      data.regeneratePolygon,
    ],
  );
}
