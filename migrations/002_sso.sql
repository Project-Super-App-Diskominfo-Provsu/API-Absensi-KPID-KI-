ALTER TABLE users ADD COLUMN auth_mode text NOT NULL DEFAULT 'LOCAL'
  CHECK (auth_mode IN ('LOCAL','SSO','BOTH'));

CREATE TABLE sso_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer,subject),
  UNIQUE (user_id,issuer)
);
CREATE TABLE sso_login_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sso_flow_expiry_idx ON sso_login_flows(expires_at);
