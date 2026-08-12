-- A target-branch update can change the reviewed diff while keeping the PR
-- head commit unchanged. Revisions are therefore bound to the full tuple.
DROP INDEX pull_request_revisions_sha_uq;
CREATE UNIQUE INDEX pull_request_revisions_sha_uq
  ON pull_request_revisions(pull_request_id, head_sha, base_sha);
