CREATE INDEX github_oauth_flows_cleanup_idx
  ON github_oauth_flows(expires_at, id);
CREATE INDEX github_oauth_flows_created_idx
  ON github_oauth_flows(created_at);
CREATE INDEX github_oauth_flows_repository_active_idx
  ON github_oauth_flows(repository_id, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX github_oauth_flows_repository_created_idx
  ON github_oauth_flows(repository_id, created_at);
