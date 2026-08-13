CREATE TABLE web_request_rate_limits (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  subject_key_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT web_request_rate_limits_action_v1 CHECK (
    action IN (
      'handoff_create',
      'handoff_exchange',
      'upload_start',
      'upload_part_url',
      'upload_part_complete',
      'upload_finalize',
      'review_queue',
      'review_detail',
      'review_context',
      'evidence_capability',
      'evidence_stream',
      'review_decision'
    )
  ),
  CONSTRAINT web_request_rate_limits_subject_hash_v1 CHECK (
    subject_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT web_request_rate_limits_expiry_v1 CHECK (
    expires_at > occurred_at
  )
);

CREATE INDEX web_request_rate_limits_subject_window_idx
  ON web_request_rate_limits(action, subject_key_hash, occurred_at);

CREATE INDEX web_request_rate_limits_global_window_idx
  ON web_request_rate_limits(action, occurred_at);

CREATE INDEX web_request_rate_limits_cleanup_idx
  ON web_request_rate_limits(expires_at, id);
