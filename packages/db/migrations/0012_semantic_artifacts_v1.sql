CREATE TABLE semantic_generation_budgets (
  generation_context_id uuid PRIMARY KEY REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  repository_policy_id uuid NOT NULL REFERENCES repository_policies(id)
    ON DELETE restrict ON UPDATE no action,
  head_sha text NOT NULL,
  question_budget integer NOT NULL,
  budget_version text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT semantic_generation_budgets_head_sha CHECK (
    head_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT semantic_generation_budgets_count CHECK (
    question_budget BETWEEN 1 AND 5
  ),
  CONSTRAINT semantic_generation_budgets_version CHECK (
    budget_version = 'semantic-generation-budget-v1'
  )
);

CREATE OR REPLACE FUNCTION slopproof_validate_semantic_budget_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM generation_contexts context
      JOIN pull_request_revisions revision ON revision.id = context.revision_id
      JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
      JOIN repositories repository ON repository.id = pull_request.repository_id
      JOIN installations installation ON installation.id = repository.installation_id
      JOIN repository_policies policy ON policy.id = NEW.repository_policy_id
     WHERE context.id = NEW.generation_context_id
       AND context.revision_id = NEW.revision_id
       AND context.head_sha = NEW.head_sha
       AND revision.head_sha = NEW.head_sha
       AND revision.is_current = true
       AND pull_request.state = 'open'
       AND pull_request.repository_id = NEW.repository_id
       AND repository.status = 'active'
       AND installation.status = 'active'
       AND policy.repository_id = NEW.repository_id
       AND policy.version = repository.active_policy_version
       AND NEW.question_budget BETWEEN
           (policy.policy->'proof'->>'minimumQuestions')::integer
           AND (policy.policy->'proof'->>'maximumQuestions')::integer
  ) THEN
    RAISE EXCEPTION 'Semantic generation budget binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_generation_budgets_validate_v1
BEFORE INSERT ON semantic_generation_budgets
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_budget_v1();
CREATE TRIGGER semantic_generation_budgets_immutable
BEFORE UPDATE OR DELETE ON semantic_generation_budgets
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE TABLE semantic_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  purpose text NOT NULL,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  generation_context_id uuid NOT NULL REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  practice_session_id uuid REFERENCES practice_sessions(id)
    ON DELETE restrict ON UPDATE no action,
  practice_question_id uuid,
  practice_answer_id uuid,
  artifact_seed text NOT NULL,
  question_count integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  deadline_at timestamp with time zone NOT NULL,
  delete_after timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  artifact_id uuid,
  degraded boolean,
  CONSTRAINT semantic_generation_runs_purpose CHECK (
    purpose IN ('learning_material', 'practice_feedback', 'proof_questions')
  ),
  CONSTRAINT semantic_generation_runs_idempotency_key CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$'
  ),
  CONSTRAINT semantic_generation_runs_seed_format CHECK (
    artifact_seed ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_generation_runs_question_count CHECK (
    question_count BETWEEN 1 AND 5
  ),
  CONSTRAINT semantic_generation_runs_deadline CHECK (
    deadline_at > created_at
    AND deadline_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT semantic_generation_runs_retention CHECK (
    delete_after > created_at
    AND delete_after <= created_at + interval '24 hours'
  ),
  CONSTRAINT semantic_generation_runs_completion CHECK (
    (completed_at IS NULL AND artifact_id IS NULL AND degraded IS NULL)
    OR
    (completed_at IS NOT NULL AND artifact_id IS NOT NULL AND degraded IS NOT NULL
      AND completed_at >= created_at)
  ),
  CONSTRAINT semantic_generation_runs_practice_shape CHECK (
    (purpose = 'practice_feedback'
      AND practice_session_id IS NOT NULL
      AND practice_question_id IS NOT NULL
      AND practice_answer_id IS NOT NULL)
    OR
    (purpose <> 'practice_feedback'
      AND practice_session_id IS NULL
      AND practice_question_id IS NULL
      AND practice_answer_id IS NULL)
  )
);

CREATE INDEX semantic_generation_runs_revision_idx
  ON semantic_generation_runs(revision_id, created_at);
CREATE INDEX semantic_generation_runs_context_idx
  ON semantic_generation_runs(generation_context_id, purpose);
CREATE INDEX semantic_generation_runs_deadline_idx
  ON semantic_generation_runs(delete_after, id)
  WHERE completed_at IS NULL;

ALTER TABLE practice_sessions
  ADD COLUMN repository_id uuid REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  ADD COLUMN generation_context_id uuid REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  ADD COLUMN learning_bundle_id uuid,
  ADD COLUMN head_sha text,
  ADD COLUMN context_hash text,
  ADD COLUMN delete_after timestamp with time zone,
  ADD COLUMN invalidated_at timestamp with time zone,
  ADD COLUMN deleted_at timestamp with time zone;

CREATE UNIQUE INDEX practice_sessions_active_user_revision_uq
  ON practice_sessions(revision_id, user_id)
  WHERE invalidated_at IS NULL AND deleted_at IS NULL
    AND generation_context_id IS NOT NULL;
CREATE INDEX practice_sessions_retention_idx
  ON practice_sessions(delete_after, id)
  WHERE deleted_at IS NULL AND generation_context_id IS NOT NULL;

CREATE TABLE semantic_learning_bundles (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES semantic_generation_runs(id)
    ON DELETE restrict ON UPDATE no action,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  generation_context_id uuid NOT NULL REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  head_sha text NOT NULL,
  context_hash text NOT NULL,
  schema_version text NOT NULL,
  content_hash text NOT NULL,
  generation_outcome text NOT NULL,
  encrypted_payload text,
  delete_after timestamp with time zone NOT NULL,
  invalidated_at timestamp with time zone,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT semantic_learning_bundles_sha_format CHECK (
    head_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT semantic_learning_bundles_hash_format CHECK (
    context_hash ~ '^[0-9a-f]{64}$' AND content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_learning_bundles_version CHECK (
    schema_version = 'learning-bundle-v1'
  ),
  CONSTRAINT semantic_learning_bundles_outcome CHECK (
    generation_outcome IN ('generated', 'repaired', 'fallback')
  ),
  CONSTRAINT semantic_learning_bundles_lifecycle CHECK (
    (encrypted_payload IS NOT NULL AND deleted_at IS NULL)
    OR (encrypted_payload IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT semantic_learning_bundles_payload_bound CHECK (
    encrypted_payload IS NULL OR (
      octet_length(convert_to(encrypted_payload, 'UTF8')) <= 4194304
      AND encrypted_payload::jsonb->>'schemaVersion' = '1'
      AND encrypted_payload::jsonb->>'algorithm' = 'aes-256-gcm'
      AND encrypted_payload::jsonb->>'aadSha256' ~ '^[0-9a-f]{64}$'
    )
  )
);

CREATE INDEX semantic_learning_bundles_retention_idx
  ON semantic_learning_bundles(delete_after, id) WHERE deleted_at IS NULL;

ALTER TABLE practice_sessions
  ADD CONSTRAINT practice_sessions_learning_bundle_fk
  FOREIGN KEY (learning_bundle_id) REFERENCES semantic_learning_bundles(id)
  ON DELETE restrict ON UPDATE no action;

CREATE TABLE semantic_practice_answers (
  id uuid PRIMARY KEY,
  practice_session_id uuid NOT NULL REFERENCES practice_sessions(id)
    ON DELETE restrict ON UPDATE no action,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  generation_context_id uuid NOT NULL REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  practice_question_id uuid NOT NULL,
  encrypted_payload text,
  delete_after timestamp with time zone NOT NULL,
  invalidated_at timestamp with time zone,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT semantic_practice_answers_lifecycle CHECK (
    (encrypted_payload IS NOT NULL AND deleted_at IS NULL)
    OR (encrypted_payload IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT semantic_practice_answers_payload_bound CHECK (
    encrypted_payload IS NULL OR (
      octet_length(convert_to(encrypted_payload, 'UTF8')) <= 32768
      AND encrypted_payload::jsonb->>'schemaVersion' = '1'
      AND encrypted_payload::jsonb->>'algorithm' = 'aes-256-gcm'
      AND encrypted_payload::jsonb->>'aadSha256' ~ '^[0-9a-f]{64}$'
    )
  )
);

CREATE UNIQUE INDEX semantic_practice_answers_question_uq
  ON semantic_practice_answers(practice_session_id, practice_question_id);
CREATE INDEX semantic_practice_answers_retention_idx
  ON semantic_practice_answers(delete_after, id) WHERE deleted_at IS NULL;

ALTER TABLE semantic_generation_runs
  ADD CONSTRAINT semantic_generation_runs_practice_answer_fk
  FOREIGN KEY (practice_answer_id) REFERENCES semantic_practice_answers(id)
  ON DELETE restrict ON UPDATE no action;

CREATE TABLE semantic_practice_feedback (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES semantic_generation_runs(id)
    ON DELETE restrict ON UPDATE no action,
  practice_session_id uuid NOT NULL REFERENCES practice_sessions(id)
    ON DELETE restrict ON UPDATE no action,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  generation_context_id uuid NOT NULL REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  practice_question_id uuid NOT NULL,
  head_sha text NOT NULL,
  context_hash text NOT NULL,
  schema_version text NOT NULL,
  content_hash text NOT NULL,
  generation_outcome text NOT NULL,
  encrypted_payload text,
  delete_after timestamp with time zone NOT NULL,
  invalidated_at timestamp with time zone,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT semantic_practice_feedback_sha_format CHECK (
    head_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT semantic_practice_feedback_hash_format CHECK (
    context_hash ~ '^[0-9a-f]{64}$' AND content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_practice_feedback_version CHECK (
    schema_version = 'practice-feedback-v1'
  ),
  CONSTRAINT semantic_practice_feedback_outcome CHECK (
    generation_outcome IN ('generated', 'repaired', 'fallback')
  ),
  CONSTRAINT semantic_practice_feedback_lifecycle CHECK (
    (encrypted_payload IS NOT NULL AND deleted_at IS NULL)
    OR (encrypted_payload IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT semantic_practice_feedback_payload_bound CHECK (
    encrypted_payload IS NULL OR (
      octet_length(convert_to(encrypted_payload, 'UTF8')) <= 1048576
      AND encrypted_payload::jsonb->>'schemaVersion' = '1'
      AND encrypted_payload::jsonb->>'algorithm' = 'aes-256-gcm'
      AND encrypted_payload::jsonb->>'aadSha256' ~ '^[0-9a-f]{64}$'
    )
  )
);

CREATE INDEX semantic_practice_feedback_retention_idx
  ON semantic_practice_feedback(delete_after, id) WHERE deleted_at IS NULL;

CREATE TABLE semantic_proof_plans_v2 (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES semantic_generation_runs(id)
    ON DELETE restrict ON UPDATE no action,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE restrict ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  generation_context_id uuid NOT NULL REFERENCES generation_contexts(id)
    ON DELETE restrict ON UPDATE no action,
  head_sha text NOT NULL,
  context_hash text NOT NULL,
  schema_version text NOT NULL,
  planner_version text NOT NULL,
  content_hash text NOT NULL,
  plan_hash text NOT NULL,
  question_budget integer NOT NULL,
  generation_outcome text NOT NULL,
  plan jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL,
  delete_after timestamp with time zone NOT NULL,
  CONSTRAINT semantic_proof_plans_v2_sha_format CHECK (
    head_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT semantic_proof_plans_v2_hash_format CHECK (
    context_hash ~ '^[0-9a-f]{64}$'
    AND content_hash ~ '^[0-9a-f]{64}$'
    AND plan_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_proof_plans_v2_versions CHECK (
    schema_version = 'proof-question-plan-v2'
    AND planner_version = 'proof-planner-v2'
  ),
  CONSTRAINT semantic_proof_plans_v2_budget CHECK (
    question_budget BETWEEN 1 AND 5
    AND jsonb_array_length(plan->'questions') = question_budget
  ),
  CONSTRAINT semantic_proof_plans_v2_outcome CHECK (
    generation_outcome IN ('generated', 'repaired', 'fallback')
  ),
  CONSTRAINT semantic_proof_plans_v2_shape CHECK (
    jsonb_typeof(plan) = 'object'
    AND plan->>'id' = id::text
    AND plan->>'revisionId' = revision_id::text
    AND plan->>'headSha' = head_sha
    AND plan->>'contextHash' = context_hash
    AND plan->>'contentHash' = content_hash
    AND plan->>'planHash' = plan_hash
    AND (plan->>'questionBudget')::integer = question_budget
    AND plan->>'generationOutcome' = generation_outcome
    AND octet_length(plan::text) <= 2097152
  )
);

CREATE TABLE semantic_provider_invocations (
  call_id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES semantic_generation_runs(id)
    ON DELETE restrict ON UPDATE no action,
  metadata_version text NOT NULL,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  output_schema_version text NOT NULL,
  planner_version text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer NOT NULL,
  invocation_count integer NOT NULL,
  outcome text NOT NULL,
  degraded boolean NOT NULL,
  completed_at timestamp with time zone NOT NULL,
  CONSTRAINT semantic_provider_invocations_version CHECK (
    metadata_version = 'semantic-provider-metadata-v1'
  ),
  CONSTRAINT semantic_provider_invocations_purpose CHECK (
    purpose IN ('learning_material', 'practice_feedback', 'proof_questions')
  ),
  CONSTRAINT semantic_provider_invocations_hashes CHECK (
    input_hash ~ '^[0-9a-f]{64}$' AND output_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_provider_invocations_tokens CHECK (
    (input_tokens IS NULL AND output_tokens IS NULL)
    OR (input_tokens BETWEEN 0 AND 10000000 AND output_tokens BETWEEN 0 AND 10000000)
  ),
  CONSTRAINT semantic_provider_invocations_runtime CHECK (
    latency_ms BETWEEN 0 AND 900000 AND invocation_count BETWEEN 0 AND 2
  ),
  CONSTRAINT semantic_provider_invocations_outcome CHECK (
    outcome IN ('generated', 'repaired', 'fallback')
    AND degraded = (outcome = 'fallback')
  )
);

CREATE TABLE semantic_practice_rate_limits (
  id bigserial PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE cascade ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE cascade ON UPDATE no action,
  actor_key_hash text NOT NULL,
  action text NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT semantic_practice_rate_limits_hash CHECK (
    actor_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_practice_rate_limits_action CHECK (
    action IN ('start_session', 'submit_answer')
  ),
  CONSTRAINT semantic_practice_rate_limits_expiry CHECK (
    expires_at > occurred_at
  )
);

CREATE INDEX semantic_practice_rate_limits_window_idx
  ON semantic_practice_rate_limits(
    repository_id, revision_id, actor_key_hash, action, occurred_at
  );
CREATE INDEX semantic_practice_rate_limits_cleanup_idx
  ON semantic_practice_rate_limits(expires_at, id);

CREATE TABLE semantic_practice_capability_uses (
  jti uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id)
    ON DELETE cascade ON UPDATE no action,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id)
    ON DELETE cascade ON UPDATE no action,
  actor_key_hash text NOT NULL,
  action text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT semantic_practice_capability_uses_hash CHECK (
    actor_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_practice_capability_uses_action CHECK (
    action IN ('read', 'start_session', 'submit_answer')
  ),
  CONSTRAINT semantic_practice_capability_uses_expiry CHECK (
    expires_at > consumed_at
    AND expires_at <= consumed_at + interval '15 minutes'
  )
);

CREATE INDEX semantic_practice_capability_uses_cleanup_idx
  ON semantic_practice_capability_uses(expires_at, jti);

CREATE OR REPLACE FUNCTION slopproof_validate_practice_capability_use_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pull_request_revisions revision
      JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
      JOIN repositories repository ON repository.id = pull_request.repository_id
      JOIN installations installation ON installation.id = repository.installation_id
     WHERE revision.id = NEW.revision_id
       AND pull_request.repository_id = NEW.repository_id
       AND revision.is_current = true
       AND pull_request.state = 'open'
       AND repository.status = 'active'
       AND installation.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Practice capability use binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_practice_capability_uses_validate_v1
BEFORE INSERT ON semantic_practice_capability_uses
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_practice_capability_use_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_semantic_practice_rate_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pull_request_revisions revision
      JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
      JOIN repositories repository ON repository.id = pull_request.repository_id
      JOIN installations installation ON installation.id = repository.installation_id
     WHERE revision.id = NEW.revision_id
       AND pull_request.repository_id = NEW.repository_id
       AND revision.is_current = true
       AND pull_request.state = 'open'
       AND repository.status = 'active'
       AND installation.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Practice rate limit revision binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_practice_rate_limits_validate_v1
BEFORE INSERT ON semantic_practice_rate_limits
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_practice_rate_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_semantic_generation_run_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_repository uuid;
  expected_head text;
  expected_context_hash text;
  expected_budget integer;
BEGIN
  SELECT pull_request.repository_id, revision.head_sha, context.context_hash,
         budget.question_budget
    INTO expected_repository, expected_head, expected_context_hash, expected_budget
    FROM generation_contexts context
    JOIN pull_request_revisions revision ON revision.id = context.revision_id
    JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
    JOIN repositories repository ON repository.id = pull_request.repository_id
    JOIN installations installation ON installation.id = repository.installation_id
    JOIN semantic_generation_budgets budget
      ON budget.generation_context_id = context.id
     AND budget.revision_id = revision.id
     AND budget.repository_id = pull_request.repository_id
     AND budget.head_sha = revision.head_sha
   WHERE context.id = NEW.generation_context_id
     AND context.revision_id = NEW.revision_id
     AND revision.is_current = true
     AND pull_request.state = 'open'
     AND repository.status = 'active'
     AND installation.status = 'active';

  IF expected_repository IS NULL OR expected_repository <> NEW.repository_id THEN
    RAISE EXCEPTION 'Semantic generation run binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF expected_budget IS NULL THEN
    RAISE EXCEPTION 'Semantic generation requires the analyzer-owned question budget'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.purpose = 'proof_questions' AND NEW.question_count <> expected_budget)
     OR (NEW.purpose = 'learning_material'
         AND NEW.question_count <> greatest(3, expected_budget)) THEN
    RAISE EXCEPTION 'Semantic generation question count is not analyzer-owned'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'practice_feedback' AND NOT EXISTS (
    SELECT 1
      FROM practice_sessions session
      JOIN semantic_practice_answers answer
        ON answer.id = NEW.practice_answer_id
       AND answer.practice_session_id = session.id
       AND answer.practice_question_id = NEW.practice_question_id
     WHERE session.id = NEW.practice_session_id
       AND session.repository_id = NEW.repository_id
       AND session.revision_id = NEW.revision_id
       AND session.generation_context_id = NEW.generation_context_id
       AND session.head_sha = expected_head
       AND session.context_hash = expected_context_hash
       AND session.invalidated_at IS NULL
       AND session.deleted_at IS NULL
       AND session.delete_after > NEW.created_at
       AND answer.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Practice feedback run binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_generation_runs_validate_v1
BEFORE INSERT ON semantic_generation_runs
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_generation_run_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_practice_session_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.generation_context_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.repository_id IS NULL OR NEW.learning_bundle_id IS NULL
     OR NEW.head_sha IS NULL OR NEW.context_hash IS NULL
     OR NEW.delete_after IS NULL
     OR NEW.version <> 'practice-session-v1'
     OR NEW.head_sha !~ '^[0-9a-f]{40}$'
     OR NEW.context_hash !~ '^[0-9a-f]{64}$'
     OR NEW.delete_after <= NEW.started_at
     OR NEW.delete_after > NEW.started_at + interval '24 hours'
     OR NOT EXISTS (
       SELECT 1
         FROM generation_contexts context
         JOIN pull_request_revisions revision ON revision.id = context.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         JOIN repositories repository ON repository.id = pull_request.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
         JOIN semantic_learning_bundles bundle
           ON bundle.id = NEW.learning_bundle_id
          AND bundle.generation_context_id = context.id
          AND bundle.deleted_at IS NULL
        WHERE context.id = NEW.generation_context_id
          AND context.revision_id = NEW.revision_id
          AND context.head_sha = NEW.head_sha
          AND context.context_hash = NEW.context_hash
          AND pull_request.repository_id = NEW.repository_id
          AND pull_request.author_id = NEW.user_id
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
          AND revision.is_current = true
          AND bundle.delete_after >= NEW.delete_after
     ) THEN
    RAISE EXCEPTION 'Practice session binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER practice_sessions_semantic_v1_binding
BEFORE INSERT OR UPDATE OF revision_id, repository_id, generation_context_id,
  learning_bundle_id, head_sha, context_hash, user_id, version, started_at,
  delete_after
ON practice_sessions
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_practice_session_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_practice_answer_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM practice_sessions session
      JOIN semantic_learning_bundles bundle ON bundle.id = session.learning_bundle_id
      JOIN pull_request_revisions revision ON revision.id = session.revision_id
      JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
      JOIN repositories repository ON repository.id = pull_request.repository_id
      JOIN installations installation ON installation.id = repository.installation_id
     WHERE session.id = NEW.practice_session_id
       AND session.repository_id = NEW.repository_id
       AND session.revision_id = NEW.revision_id
       AND session.generation_context_id = NEW.generation_context_id
       AND session.invalidated_at IS NULL
       AND session.deleted_at IS NULL
       AND session.delete_after = NEW.delete_after
       AND NEW.created_at < NEW.delete_after
       AND bundle.deleted_at IS NULL
       AND revision.is_current = true
       AND pull_request.state = 'open'
       AND pull_request.author_id = session.user_id
       AND repository.id = NEW.repository_id
       AND repository.status = 'active'
       AND installation.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Practice answer binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_practice_answers_validate_v1
BEFORE INSERT ON semantic_practice_answers
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_practice_answer_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_semantic_artifact_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_purpose text;
  run_repository uuid;
  run_revision uuid;
  run_context uuid;
  run_session uuid;
  run_question uuid;
  run_created timestamp with time zone;
  run_delete_after timestamp with time zone;
  run_question_count integer;
BEGIN
  SELECT purpose, repository_id, revision_id, generation_context_id,
         practice_session_id, practice_question_id,
         created_at, delete_after, question_count
    INTO run_purpose, run_repository, run_revision, run_context,
         run_session, run_question,
         run_created, run_delete_after, run_question_count
    FROM semantic_generation_runs
   WHERE id = NEW.run_id
   FOR UPDATE;
  IF run_purpose IS NULL
     OR run_repository <> NEW.repository_id
     OR run_revision <> NEW.revision_id
     OR run_context <> NEW.generation_context_id
     OR run_created <> NEW.created_at
     OR run_delete_after <> NEW.delete_after
     OR (TG_TABLE_NAME = 'semantic_learning_bundles'
         AND run_purpose <> 'learning_material')
     OR (TG_TABLE_NAME = 'semantic_practice_feedback'
         AND (run_purpose <> 'practice_feedback'
              OR run_session::text <> to_jsonb(NEW)->>'practice_session_id'
              OR run_question::text <> to_jsonb(NEW)->>'practice_question_id'))
     OR (TG_TABLE_NAME = 'semantic_proof_plans_v2'
         AND (run_purpose <> 'proof_questions'
              OR run_question_count <>
                 (to_jsonb(NEW)->>'question_budget')::integer))
     OR NOT EXISTS (
       SELECT 1
         FROM generation_contexts context
         JOIN pull_request_revisions revision ON revision.id = context.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         JOIN repositories repository ON repository.id = pull_request.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
        WHERE context.id = NEW.generation_context_id
          AND context.revision_id = NEW.revision_id
          AND context.head_sha = NEW.head_sha
          AND context.context_hash = NEW.context_hash
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.id = NEW.repository_id
          AND repository.status = 'active'
          AND installation.status = 'active'
     ) THEN
    RAISE EXCEPTION 'Semantic artifact binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_learning_bundles_validate_v1
BEFORE INSERT ON semantic_learning_bundles
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_artifact_v1();
CREATE TRIGGER semantic_practice_feedback_validate_v1
BEFORE INSERT ON semantic_practice_feedback
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_artifact_v1();
CREATE TRIGGER semantic_proof_plans_v2_validate_v1
BEFORE INSERT ON semantic_proof_plans_v2
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_artifact_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_semantic_private_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is retention-shredded, not deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF NEW.encrypted_payload IS NOT NULL
     OR OLD.encrypted_payload IS NULL
     OR NEW.deleted_at IS NULL
     OR NEW.deleted_at < OLD.created_at
     OR (to_jsonb(NEW) - 'encrypted_payload' - 'invalidated_at' - 'deleted_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'encrypted_payload' - 'invalidated_at' - 'deleted_at') THEN
    RAISE EXCEPTION '% is immutable outside retention shredding', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_learning_bundles_private_guard
BEFORE UPDATE OR DELETE ON semantic_learning_bundles
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_semantic_private_v1();
CREATE TRIGGER semantic_practice_answers_private_guard
BEFORE UPDATE OR DELETE ON semantic_practice_answers
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_semantic_private_v1();
CREATE TRIGGER semantic_practice_feedback_private_guard
BEFORE UPDATE OR DELETE ON semantic_practice_feedback
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_semantic_private_v1();

CREATE TRIGGER semantic_proof_plans_v2_immutable
BEFORE UPDATE OR DELETE ON semantic_proof_plans_v2
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();
CREATE TRIGGER semantic_provider_invocations_immutable
BEFORE UPDATE OR DELETE ON semantic_provider_invocations
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE OR REPLACE FUNCTION slopproof_validate_semantic_invocation_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM semantic_generation_runs run
     WHERE run.id = NEW.run_id
       AND run.purpose = NEW.purpose
       AND NEW.completed_at >= run.created_at
  ) THEN
    RAISE EXCEPTION 'Semantic provider metadata binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_provider_invocations_validate_v1
BEFORE INSERT ON semantic_provider_invocations
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_semantic_invocation_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_semantic_run_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'semantic_generation_runs is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.completed_at IS NOT NULL
     OR NEW.completed_at IS NULL
     OR NEW.artifact_id IS NULL
     OR NEW.degraded IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.generation_context_id IS DISTINCT FROM OLD.generation_context_id
     OR NEW.practice_session_id IS DISTINCT FROM OLD.practice_session_id
     OR NEW.practice_question_id IS DISTINCT FROM OLD.practice_question_id
     OR NEW.practice_answer_id IS DISTINCT FROM OLD.practice_answer_id
     OR NEW.artifact_seed IS DISTINCT FROM OLD.artifact_seed
     OR NEW.question_count IS DISTINCT FROM OLD.question_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.delete_after IS DISTINCT FROM OLD.delete_after THEN
    RAISE EXCEPTION 'semantic_generation_runs permits one completion only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_generation_runs_guard_v1
BEFORE UPDATE OR DELETE ON semantic_generation_runs
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_semantic_run_v1();

CREATE OR REPLACE FUNCTION slopproof_invalidate_semantic_private_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_current = true AND NEW.is_current = false THEN
    UPDATE semantic_learning_bundles
       SET encrypted_payload = NULL,
           invalidated_at = COALESCE(NEW.invalidated_at, now()),
           deleted_at = COALESCE(NEW.invalidated_at, now())
     WHERE revision_id = NEW.id AND encrypted_payload IS NOT NULL;
    UPDATE semantic_practice_answers
       SET encrypted_payload = NULL,
           invalidated_at = COALESCE(NEW.invalidated_at, now()),
           deleted_at = COALESCE(NEW.invalidated_at, now())
     WHERE revision_id = NEW.id AND encrypted_payload IS NOT NULL;
    UPDATE semantic_practice_feedback
       SET encrypted_payload = NULL,
           invalidated_at = COALESCE(NEW.invalidated_at, now()),
           deleted_at = COALESCE(NEW.invalidated_at, now())
     WHERE revision_id = NEW.id AND encrypted_payload IS NOT NULL;
    UPDATE practice_sessions
       SET invalidated_at = COALESCE(NEW.invalidated_at, now()),
           deleted_at = COALESCE(NEW.invalidated_at, now())
     WHERE revision_id = NEW.id
       AND generation_context_id IS NOT NULL
       AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pull_request_revisions_semantic_private_invalidation
AFTER UPDATE OF is_current ON pull_request_revisions
FOR EACH ROW EXECUTE FUNCTION slopproof_invalidate_semantic_private_v1();
