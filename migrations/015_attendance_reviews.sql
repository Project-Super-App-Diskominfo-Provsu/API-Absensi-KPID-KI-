CREATE TABLE attendance_reviews (
  attempt_id uuid PRIMARY KEY REFERENCES attendance_attempts(id) ON DELETE CASCADE,
  employee_category_at_event text,
  evidence jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence)='object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  reason text,
  identity_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status='PENDING' OR (reviewed_at IS NOT NULL AND length(trim(reason)) BETWEEN 5 AND 500)),
  CHECK (status<>'APPROVED' OR (evidence IS NOT NULL AND identity_verified))
);
CREATE INDEX attendance_reviews_pending_idx ON attendance_reviews(created_at,attempt_id) WHERE status='PENDING';
