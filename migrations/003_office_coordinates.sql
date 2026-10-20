-- Expand only: preserve the legacy geography column and extension for rollback.
ALTER TABLE offices ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE offices ADD COLUMN IF NOT EXISTS longitude double precision;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='offices' AND column_name='location'
  ) THEN
    EXECUTE 'UPDATE offices SET latitude=ST_Y(location::geometry),longitude=ST_X(location::geometry)';
    -- Keep old and new writers compatible during a rolling deployment.
    EXECUTE $ddl$
      CREATE FUNCTION sync_office_coordinates() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.latitude IS NULL AND NEW.longitude IS NULL THEN
            NEW.latitude := ST_Y(NEW.location::geometry);
            NEW.longitude := ST_X(NEW.location::geometry);
          ELSE
            NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude,NEW.latitude),4326)::geography;
          END IF;
        ELSIF NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude THEN
          NEW.location := CASE WHEN NEW.latitude IS NULL OR NEW.longitude IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint(NEW.longitude,NEW.latitude),4326)::geography END;
        ELSIF NEW.location IS DISTINCT FROM OLD.location THEN
          NEW.latitude := ST_Y(NEW.location::geometry);
          NEW.longitude := ST_X(NEW.location::geometry);
        END IF;
        RETURN NEW;
      END
      $body$
    $ddl$;
    EXECUTE 'CREATE TRIGGER offices_coordinate_sync BEFORE INSERT OR UPDATE ON offices FOR EACH ROW EXECUTE FUNCTION sync_office_coordinates()';
  END IF;
END
$migration$;

ALTER TABLE offices ADD CONSTRAINT offices_coordinate_pair
  CHECK ((latitude IS NULL) = (longitude IS NULL));
ALTER TABLE offices ADD CONSTRAINT offices_coordinate_bounds
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);
ALTER TABLE offices ADD CONSTRAINT offices_coordinate_nonzero
  CHECK (latitude IS NULL OR latitude <> 0 OR longitude <> 0);
ALTER TABLE offices ADD CONSTRAINT offices_active_coordinates
  CHECK (NOT active OR (latitude IS NOT NULL AND longitude IS NOT NULL));
