ALTER TABLE users ADD COLUMN face_enrollment_version integer NOT NULL DEFAULT 0
  CHECK (face_enrollment_version >= 0);
