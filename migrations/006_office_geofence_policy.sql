-- Keep historical polygon migration intact; apply the agreed 50m policy.
ALTER TABLE offices ADD COLUMN address text;
UPDATE offices SET address=CASE code
  WHEN 'DISKOMINFO_PROVSU' THEN 'Jl. HM. Said No.27, Gaharu, Kec. Medan Tim., Kota Medan, Sumatera Utara 20233'
  WHEN 'KPID_SUMUT' THEN 'Jl. Adinegoro No.7, Gaharu, Kec. Medan Tim., Kota Medan, Sumatera Utara 20235'
  WHEN 'KI_SUMUT' THEN 'Jl. Alfalah No.22, Suka Maju, Kec. Medan Johor, Kota Medan, Sumatera Utara 20146'
  ELSE address END;

UPDATE offices
SET polygon=ST_Buffer(ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography,50,'quad_segs=64')::geometry
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  AND (polygon IS NULL OR ST_Equals(polygon,
    ST_Buffer(ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography,COALESCE(radius_m,50))::geometry));

UPDATE offices SET radius_m=50;
ALTER TABLE offices ALTER COLUMN radius_m SET DEFAULT 50;
ALTER TABLE offices ALTER COLUMN radius_m SET NOT NULL;
ALTER TABLE offices ADD CONSTRAINT offices_radius_fixed CHECK (radius_m=50);

ALTER TABLE offices ADD CONSTRAINT offices_polygon_valid
  CHECK (polygon IS NULL OR (ST_IsValid(polygon) AND NOT ST_IsEmpty(polygon) AND ST_Area(polygon)>0));
ALTER TABLE offices ADD CONSTRAINT offices_active_polygon CHECK (NOT active OR polygon IS NOT NULL);

CREATE FUNCTION refresh_office_polygon() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    IF (TG_OP='INSERT' AND NEW.polygon IS NULL) OR
       (TG_OP='UPDATE' AND (NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude)
        AND NEW.polygon IS NOT DISTINCT FROM OLD.polygon) THEN
      NEW.polygon:=ST_Buffer(ST_SetSRID(ST_MakePoint(NEW.longitude,NEW.latitude),4326)::geography,50,'quad_segs=64')::geometry;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER offices_geofence_refresh BEFORE INSERT OR UPDATE ON offices
FOR EACH ROW EXECUTE FUNCTION refresh_office_polygon();
