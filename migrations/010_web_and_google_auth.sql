ALTER TABLE refresh_sessions ADD COLUMN client_type text NOT NULL DEFAULT 'MOBILE'
  CHECK (client_type IN ('MOBILE','WEB'));

CREATE TABLE google_login_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_type text NOT NULL CHECK (client_type IN ('MOBILE','WEB')),
  nonce text NOT NULL,
  state_hash text UNIQUE,
  browser_hash text,
  code_verifier text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  consumed_at timestamptz,
  CHECK (client_type='MOBILE' OR (state_hash IS NOT NULL AND browser_hash IS NOT NULL AND code_verifier IS NOT NULL))
);
CREATE INDEX google_login_flow_expiry_idx ON google_login_flows(expires_at);
