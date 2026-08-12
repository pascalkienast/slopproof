CREATE TABLE oauth_start_rate_limits (
  id bigserial PRIMARY KEY,
  client_key_hash text NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT oauth_start_rate_limits_client_key_hash_format
    CHECK (client_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_start_rate_limits_expiry_after_occurrence
    CHECK (expires_at > occurred_at)
);

CREATE INDEX oauth_start_rate_limits_client_window_idx
  ON oauth_start_rate_limits(client_key_hash, occurred_at);
CREATE INDEX oauth_start_rate_limits_cleanup_idx
  ON oauth_start_rate_limits(expires_at, id);
