CREATE TABLE device_push_tokens (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  session_family_id uuid NOT NULL,
  project_id text NOT NULL,
  token text NOT NULL CHECK (length(token) BETWEEN 20 AND 4096),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'CHECK_IN_REMINDER' CHECK (kind='CHECK_IN_REMINDER'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SENT','SKIPPED','FAILED')),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  claim_id uuid,
  lease_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id,kind)
);
CREATE INDEX notification_due_idx ON notification_deliveries(next_attempt_at,id)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX work_schedules_reminder_idx ON work_schedules(work_date,starts_at);
