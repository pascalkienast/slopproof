CREATE TYPE "github_lifecycle_status" AS ENUM ('active', 'suspended', 'removed');
CREATE TYPE "github_oauth_purpose" AS ENUM ('contributor_login', 'maintainer_reauth');
CREATE TYPE "github_check_intent_reason" AS ENUM (
  'webhook_ingested',
  'analysis_ready',
  'proof_started',
  'review_required',
  'maintainer_decision',
  'revision_invalidated',
  'manual_reconcile',
  'technical_retry',
  'attempt_expired',
  'contributor_retry'
);
CREATE TYPE "github_check_sync_status" AS ENUM (
  'pending',
  'syncing',
  'synchronized',
  'retry_required',
  'permanent_failure'
);

ALTER TABLE installations ALTER COLUMN status DROP DEFAULT;
ALTER TABLE installations
  ALTER COLUMN status TYPE github_lifecycle_status
  USING status::github_lifecycle_status;
ALTER TABLE installations ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE installations
  ADD COLUMN suspended_at timestamp with time zone,
  ADD COLUMN removed_at timestamp with time zone;

ALTER TABLE repositories
  ALTER COLUMN default_branch DROP NOT NULL,
  ADD COLUMN status github_lifecycle_status DEFAULT 'active' NOT NULL,
  ADD COLUMN suspended_at timestamp with time zone,
  ADD COLUMN removed_at timestamp with time zone;

ALTER TABLE repositories
  DROP CONSTRAINT repositories_installation_id_installations_id_fk;
ALTER TABLE repositories
  ADD CONSTRAINT repositories_installation_id_installations_id_fk
  FOREIGN KEY (installation_id) REFERENCES installations(id)
  ON DELETE restrict ON UPDATE no action;

ALTER TABLE installations
  ADD CONSTRAINT installations_lifecycle_timestamps CHECK (
    (status = 'active' AND suspended_at IS NULL AND removed_at IS NULL)
    OR (status = 'suspended' AND suspended_at IS NOT NULL AND removed_at IS NULL)
    OR (status = 'removed' AND removed_at IS NOT NULL)
  );
ALTER TABLE repositories
  ADD CONSTRAINT repositories_lifecycle_timestamps CHECK (
    (status = 'active' AND suspended_at IS NULL AND removed_at IS NULL)
    OR (status = 'suspended' AND suspended_at IS NOT NULL AND removed_at IS NULL)
    OR (status = 'removed' AND removed_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION slopproof_guard_github_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% must be tombstoned, not deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'installations'
     AND OLD.status = 'removed' AND NEW.status <> 'removed' THEN
    RAISE EXCEPTION 'removed % cannot be reactivated', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER installations_lifecycle_guard
BEFORE UPDATE OF status OR DELETE ON installations
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_github_lifecycle();

CREATE TRIGGER repositories_lifecycle_guard
BEFORE UPDATE OF status OR DELETE ON repositories
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_github_lifecycle();

CREATE TABLE github_oauth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  state_hash text NOT NULL,
  purpose github_oauth_purpose NOT NULL,
  repository_id uuid NOT NULL,
  redirect_path text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT github_oauth_flows_state_hash_format
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT github_oauth_flows_redirect_allowlist CHECK (
    redirect_path ~ '^/(review(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?|revisions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(/contribute(/practice)?)?)$'
  ),
  CONSTRAINT github_oauth_flows_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT github_oauth_flows_consumption_window
    CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)),
  CONSTRAINT github_oauth_flows_repository_fk
    FOREIGN KEY (repository_id) REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action
);
CREATE UNIQUE INDEX github_oauth_flows_state_hash_uq
  ON github_oauth_flows(state_hash);
CREATE INDEX github_oauth_flows_expiry_idx
  ON github_oauth_flows(expires_at)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION slopproof_guard_github_oauth_flow()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state_hash IS DISTINCT FROM NEW.state_hash
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
     OR OLD.redirect_path IS DISTINCT FROM NEW.redirect_path
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'OAuth flow binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.consumed_at IS NOT NULL
     AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'OAuth flow was already consumed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER github_oauth_flows_single_use
BEFORE UPDATE ON github_oauth_flows
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_github_oauth_flow();

CREATE TABLE github_revision_sources (
  revision_id uuid PRIMARY KEY NOT NULL,
  head_sha text NOT NULL,
  base_sha text NOT NULL,
  source jsonb NOT NULL,
  source_hash text NOT NULL,
  fetched_at timestamp with time zone NOT NULL,
  CONSTRAINT github_revision_sources_revision_fk
    FOREIGN KEY (revision_id) REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT github_revision_sources_head_sha_format
    CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT github_revision_sources_base_sha_format
    CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT github_revision_sources_hash_format
    CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT github_revision_sources_object
    CHECK (jsonb_typeof(source) = 'object'),
  CONSTRAINT github_revision_sources_sha_binding CHECK (
    source->>'headSha' = head_sha AND source->>'baseSha' = base_sha
  ),
  CONSTRAINT github_revision_sources_size_bound
    CHECK (octet_length(source::text) <= 3145728)
);

CREATE OR REPLACE FUNCTION slopproof_guard_github_revision_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'GitHub revision source is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER github_revision_sources_immutable
BEFORE UPDATE OR DELETE ON github_revision_sources
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_github_revision_source();

ALTER TABLE check_runs
  ALTER COLUMN github_check_run_id DROP NOT NULL,
  ALTER COLUMN last_synchronized_at DROP NOT NULL,
  ALTER COLUMN last_synchronized_at DROP DEFAULT,
  ADD COLUMN sync_status github_check_sync_status DEFAULT 'synchronized' NOT NULL,
  ADD COLUMN sync_attempts integer DEFAULT 0 NOT NULL,
  ADD COLUMN last_sync_error_class text,
  ADD COLUMN sync_requested_at timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN intent_idempotency_key text,
  ADD COLUMN intent_hash text,
  ADD COLUMN intent_reason github_check_intent_reason;

ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_sync_attempts_nonnegative
    CHECK (sync_attempts >= 0),
  ADD CONSTRAINT check_runs_error_class_format
    CHECK (last_sync_error_class IS NULL OR last_sync_error_class ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  ADD CONSTRAINT check_runs_intent_pair CHECK (
    (intent_idempotency_key IS NULL AND intent_hash IS NULL AND intent_reason IS NULL)
    OR (intent_idempotency_key IS NOT NULL AND intent_hash IS NOT NULL AND intent_reason IS NOT NULL)
  ),
  ADD CONSTRAINT check_runs_intent_key_format CHECK (
    intent_idempotency_key IS NULL
    OR intent_idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  ADD CONSTRAINT check_runs_intent_hash_format CHECK (
    intent_hash IS NULL OR intent_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT check_runs_status_conclusion_consistent CHECK (
    (status = 'completed' AND conclusion IS NOT NULL)
    OR (status <> 'completed' AND conclusion IS NULL)
  );

CREATE INDEX check_runs_pending_sync_idx
  ON check_runs(sync_status, sync_requested_at)
  WHERE sync_status IN ('pending', 'retry_required');
