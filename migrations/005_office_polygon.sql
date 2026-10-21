-- Migration 005: Add polygon geofencing to offices
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE offices ADD COLUMN IF NOT EXISTS polygon geometry(Polygon, 4326);

CREATE INDEX IF NOT EXISTS offices_polygon_idx ON offices USING gist(polygon);

-- Backfill polygon for offices that currently have point coordinates
UPDATE offices
SET polygon = ST_Buffer(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography, COALESCE(radius_m, 50))::geometry
WHERE polygon IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

-- Make radius_m optional as polygon becomes the primary geofence definition
ALTER TABLE offices ALTER COLUMN radius_m DROP NOT NULL;
ALTER TABLE offices DROP CONSTRAINT IF EXISTS offices_radius_m_check;

ALTER TABLE offices DROP CONSTRAINT IF EXISTS offices_active_coordinates;
ALTER TABLE offices DROP CONSTRAINT IF EXISTS offices_active_geofence;

ALTER TABLE offices ADD CONSTRAINT offices_active_geofence
  CHECK (NOT active OR (polygon IS NOT NULL OR (latitude IS NOT NULL AND longitude IS NOT NULL)));
