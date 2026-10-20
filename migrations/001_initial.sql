CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE employee_categories (
  code text PRIMARY KEY CHECK (code IN ('KPID','KI')),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('EMPLOYEE','VERIFIER','ADMIN','SUPER_ADMIN')),
  employee_category_code text REFERENCES employee_categories(code),
  unit_id uuid REFERENCES units(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  location geography(Point,4326),
  radius_m integer NOT NULL DEFAULT 50 CHECK (radius_m = 50),
  max_gps_accuracy_m double precision CHECK (max_gps_accuracy_m > 0 AND max_gps_accuracy_m <= 50),
  max_location_age_s integer CHECK (max_location_age_s BETWEEN 1 AND 120),
  timezone text NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone = 'Asia/Jakarta'),
  active boolean NOT NULL DEFAULT false,
  CHECK (NOT active OR (location IS NOT NULL AND max_gps_accuracy_m IS NOT NULL AND max_location_age_s IS NOT NULL)),
  CHECK (location IS NULL OR NOT (ST_X(location::geometry) = 0 AND ST_Y(location::geometry) = 0))
);
CREATE INDEX offices_location_idx ON offices USING gist(location);
CREATE TABLE category_office_permissions (
  employee_category_code text NOT NULL REFERENCES employee_categories(code),
  office_id uuid NOT NULL REFERENCES offices(id),
  PRIMARY KEY (employee_category_code,office_id)
);
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  public_key text NOT NULL,
  platform text NOT NULL CHECK (platform = 'ANDROID'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX devices_one_active ON devices(user_id) WHERE status = 'ACTIVE';
CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_family_idx ON refresh_sessions(family_id);
CREATE TABLE work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  work_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  grace_minutes integer NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 120),
  UNIQUE (user_id,work_date),
  CHECK (ends_at > starts_at),
  CHECK ((starts_at AT TIME ZONE 'Asia/Jakarta')::date = work_date),
  CHECK (ends_at - starts_at <= interval '24 hours')
);
CREATE TABLE face_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  encrypted_embedding text NOT NULL,
  model_version text NOT NULL,
  quality_score double precision NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX face_one_active ON face_templates(user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX face_one_pending ON face_templates(user_id) WHERE status = 'PENDING';
CREATE TABLE attendance_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  purpose text NOT NULL CHECK (purpose IN ('CHECK_IN','CHECK_OUT','ENROLL')),
  nonce_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE attendance_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('CHECK_IN','CHECK_OUT')),
  status text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','ACCEPTED','REJECTED','NEEDS_REVIEW','ERROR')),
  reason_code text,
  http_status integer,
  response jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id,idempotency_key)
);
CREATE TABLE attendances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  schedule_id uuid NOT NULL REFERENCES work_schedules(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES attendance_attempts(id),
  office_id uuid NOT NULL REFERENCES offices(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  type text NOT NULL CHECK (type IN ('CHECK_IN','CHECK_OUT')),
  server_time timestamptz NOT NULL,
  employee_category_at_event text NOT NULL,
  office_snapshot jsonb NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  gps_accuracy double precision NOT NULL,
  distance_m double precision NOT NULL,
  face_score double precision NOT NULL,
  liveness_score double precision NOT NULL,
  model_version text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PRESENT','LATE','EARLY_LEAVE','ON_TIME')),
  UNIQUE (user_id,schedule_id,type)
);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE INDEX attendance_history_idx ON attendances(user_id,server_time DESC);
CREATE INDEX attempt_history_idx ON attendance_attempts(user_id,received_at DESC);

INSERT INTO employee_categories(code,name) VALUES
 ('KPID','Pegawai Komisi Penyiaran Indonesia Daerah Sumatera Utara'),
 ('KI','Pegawai Komisi Informasi Sumatera Utara');
INSERT INTO offices(code,name) VALUES
 ('DISKOMINFO_PROVSU','Dinas Komunikasi dan Informatika Provinsi Sumatera Utara'),
 ('KPID_SUMUT','Komisi Penyiaran Indonesia Daerah Sumatera Utara'),
 ('KI_SUMUT','Komisi Informasi Sumatera Utara');
INSERT INTO category_office_permissions(employee_category_code,office_id)
 SELECT c.code,o.id FROM employee_categories c CROSS JOIN offices o
 WHERE o.code = 'DISKOMINFO_PROVSU'
 OR (c.code = 'KPID' AND o.code = 'KPID_SUMUT')
 OR (c.code = 'KI' AND o.code = 'KI_SUMUT');
