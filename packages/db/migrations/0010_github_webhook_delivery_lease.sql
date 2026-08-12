ALTER TABLE webhook_deliveries
  ADD COLUMN queued_at timestamp with time zone,
  ADD COLUMN next_retry_at timestamp with time zone,
  ADD COLUMN retry_attempts integer DEFAULT 0 NOT NULL,
  ADD COLUMN job_payload jsonb;

UPDATE webhook_deliveries
   SET queued_at = received_at
 WHERE processing_status = 'queued' AND queued_at IS NULL;

UPDATE webhook_deliveries
   SET processing_status = 'ignored', processed_at = now()
 WHERE processing_status = 'reserved';

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_retry_attempts_nonnegative
    CHECK (retry_attempts >= 0),
  ADD CONSTRAINT webhook_deliveries_pr_job_payload_shape CHECK (
    job_payload IS NULL
    OR (
      event_name = 'pull_request'
      AND jsonb_typeof(job_payload) = 'object'
      AND octet_length(job_payload::text) <= 8192
    )
  ),
  ADD CONSTRAINT webhook_deliveries_retry_schedule_state CHECK (
    next_retry_at IS NULL OR processing_status = 'queued'
  ),
  ADD CONSTRAINT webhook_deliveries_processing_status CHECK (
    processing_status IN ('reserved', 'queued', 'processed', 'ignored',
                          'permanent_failure')
  );

CREATE INDEX webhook_deliveries_stale_queue_idx
  ON webhook_deliveries(COALESCE(next_retry_at, queued_at), delivery_id)
  WHERE processing_status = 'queued' AND job_payload IS NOT NULL;

ALTER TABLE pull_requests
  ADD COLUMN github_recovery_binding jsonb;

ALTER TABLE pull_requests
  ADD CONSTRAINT pull_requests_github_recovery_binding_shape CHECK (
    github_recovery_binding IS NULL
    OR (
      jsonb_typeof(github_recovery_binding) = 'object'
      AND github_recovery_binding ?& ARRAY[
        'installationId', 'accountId', 'accountLogin', 'owner',
        'repositoryName'
      ]
      AND github_recovery_binding - ARRAY[
        'installationId', 'accountId', 'accountLogin', 'owner',
        'repositoryName'
      ] = '{}'::jsonb
      AND octet_length(github_recovery_binding::text) <= 1024
    )
  );

CREATE TABLE github_recovery_candidates (
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  github_installation_id text NOT NULL
    CHECK (github_installation_id ~ '^[1-9][0-9]{0,15}$'),
  account_id text NOT NULL CHECK (account_id ~ '^[1-9][0-9]{0,15}$'),
  account_login text NOT NULL CHECK (char_length(account_login) BETWEEN 1 AND 100),
  owner text NOT NULL CHECK (char_length(owner) BETWEEN 1 AND 100),
  repository_name text NOT NULL
    CHECK (char_length(repository_name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pull_request_id, github_installation_id)
);

CREATE INDEX github_recovery_candidates_installation_idx
  ON github_recovery_candidates(github_installation_id, pull_request_id);
