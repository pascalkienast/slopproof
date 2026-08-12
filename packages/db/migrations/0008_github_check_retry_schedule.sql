ALTER TABLE check_runs
  ADD COLUMN next_sync_after timestamp with time zone;

ALTER TABLE pull_requests
  ADD COLUMN next_github_refresh_at timestamp with time zone;

ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_next_sync_after_state CHECK (
    next_sync_after IS NULL OR sync_status = 'retry_required'
  );

DROP INDEX check_runs_pending_sync_idx;

CREATE INDEX check_runs_pending_sync_idx
  ON check_runs(sync_status, next_sync_after, sync_requested_at)
  WHERE sync_status IN ('pending', 'retry_required');

CREATE INDEX pull_requests_github_refresh_due_idx
  ON pull_requests(next_github_refresh_at, id)
  WHERE state = 'open' AND next_github_refresh_at IS NOT NULL;
