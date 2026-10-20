-- Revocation only needs live sessions; keep historical rows for reuse detection.
CREATE INDEX refresh_user_active_idx ON refresh_sessions(user_id) WHERE revoked_at IS NULL;
