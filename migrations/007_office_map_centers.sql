-- Place coordinates from the Google Maps pins supplied on 2026-10-21.
-- Seed only unconfigured offices; preserve coordinates and polygons set by administrators.
-- Migration 006's trigger generates the 50m polygon. Activation remains explicit.
UPDATE offices AS o
SET latitude = centers.latitude, longitude = centers.longitude
FROM (VALUES
  ('DISKOMINFO_PROVSU', 3.601785::double precision, 98.682827::double precision),
  ('KPID_SUMUT', 3.601287::double precision, 98.6823199::double precision),
  ('KI_SUMUT', 3.5464663::double precision, 98.6946129::double precision)
) AS centers(code, latitude, longitude)
WHERE o.code = centers.code
  AND o.latitude IS NULL AND o.longitude IS NULL AND o.polygon IS NULL;
