CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date date NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('NATIONAL_HOLIDAY', 'JOINT_LEAVE')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX holidays_date_idx ON holidays (holiday_date);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('SAKIT', 'IZIN', 'CUTI', 'DINAS_LUAR')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  notes text NOT NULL CHECK (length(trim(notes)) >= 5),
  attachment_url text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_date_range_check CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_user_date_idx ON leave_requests (user_id, start_date, end_date);
CREATE INDEX leave_requests_status_idx ON leave_requests (status, start_date, end_date);

INSERT INTO holidays (holiday_date, name, type) VALUES
  ('2026-01-01', 'Tahun Baru 2026 Masehi', 'NATIONAL_HOLIDAY'),
  ('2026-01-16', 'Isra Mikraj Nabi Muhammad SAW', 'NATIONAL_HOLIDAY'),
  ('2026-02-17', 'Tahun Baru Imlek 2577 Kongzili', 'NATIONAL_HOLIDAY'),
  ('2026-03-20', 'Hari Suci Nyepi Tahun Baru Saka 1948', 'NATIONAL_HOLIDAY'),
  ('2026-03-21', 'Hari Raya Idul Fitri 1447 Hijriah', 'NATIONAL_HOLIDAY'),
  ('2026-03-22', 'Hari Raya Idul Fitri 1447 Hijriah', 'NATIONAL_HOLIDAY'),
  ('2026-03-23', 'Cuti Bersama Hari Raya Idul Fitri 1447 H', 'JOINT_LEAVE'),
  ('2026-03-24', 'Cuti Bersama Hari Raya Idul Fitri 1447 H', 'JOINT_LEAVE'),
  ('2026-05-01', 'Hari Buruh Internasional', 'NATIONAL_HOLIDAY'),
  ('2026-05-14', 'Kenaikan Yesus Kristus', 'NATIONAL_HOLIDAY'),
  ('2026-05-27', 'Hari Raya Waisak 2570 BE', 'NATIONAL_HOLIDAY'),
  ('2026-05-28', 'Hari Raya Idul Adha 1447 Hijriah', 'NATIONAL_HOLIDAY'),
  ('2026-06-01', 'Hari Lahir Pancasila', 'NATIONAL_HOLIDAY'),
  ('2026-06-16', 'Tahun Baru Islam 1448 Hijriah', 'NATIONAL_HOLIDAY'),
  ('2026-08-17', 'Proklamasi Kemerdekaan RI', 'NATIONAL_HOLIDAY'),
  ('2026-08-25', 'Maulid Nabi Muhammad SAW', 'NATIONAL_HOLIDAY'),
  ('2026-12-25', 'Kelahiran Yesus Kristus (Hari Raya Natal)', 'NATIONAL_HOLIDAY')
ON CONFLICT (holiday_date) DO NOTHING;
