DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work_schedules
    WHERE (starts_at AT TIME ZONE 'Asia/Jakarta')::date <> work_date
       OR (ends_at AT TIME ZONE 'Asia/Jakarta')::date <> work_date
  ) THEN
    RAISE EXCEPTION 'Cross-date schedules exist. Review work_schedules before applying migration 009; no schedules were changed.';
  END IF;
END
$$;

ALTER TABLE work_schedules ADD CONSTRAINT work_schedules_same_day
  CHECK ((starts_at AT TIME ZONE 'Asia/Jakarta')::date = work_date
     AND (ends_at AT TIME ZONE 'Asia/Jakarta')::date = work_date);
