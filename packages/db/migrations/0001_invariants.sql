CREATE OR REPLACE FUNCTION slopproof_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER repository_policies_append_only
BEFORE UPDATE OR DELETE ON repository_policies
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE TRIGGER attempt_transitions_append_only
BEFORE UPDATE OR DELETE ON attempt_transitions
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE TRIGGER review_decisions_append_only
BEFORE UPDATE OR DELETE ON review_decisions
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION slopproof_reject_mutation();

CREATE OR REPLACE FUNCTION slopproof_guard_proof_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM attempts WHERE proof_plan_id = OLD.id) THEN
    RAISE EXCEPTION 'proof plan is immutable after attempt creation' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER proof_plans_immutable_after_attempt
BEFORE UPDATE OR DELETE ON proof_plans
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_proof_plan();

CREATE OR REPLACE FUNCTION slopproof_guard_proof_question()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM attempts WHERE proof_plan_id = OLD.proof_plan_id
  ) THEN
    RAISE EXCEPTION 'proof questions are immutable after attempt creation' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER proof_questions_immutable_after_attempt
BEFORE UPDATE OR DELETE ON proof_questions
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_proof_question();

CREATE OR REPLACE FUNCTION slopproof_guard_attempt_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_sha text;
  revision_repository uuid;
BEGIN
  SELECT revision.head_sha, pr.repository_id
  INTO revision_sha, revision_repository
  FROM pull_request_revisions revision
  JOIN pull_requests pr ON pr.id = revision.pull_request_id
  WHERE revision.id = NEW.revision_id;

  IF revision_sha IS NULL OR revision_sha <> NEW.head_sha THEN
    RAISE EXCEPTION 'attempt head SHA does not match its revision' USING ERRCODE = '23514';
  END IF;
  IF revision_repository <> NEW.repository_id THEN
    RAISE EXCEPTION 'attempt repository does not match its revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_revision_binding
BEFORE INSERT OR UPDATE OF revision_id, repository_id, head_sha ON attempts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_attempt_revision();

CREATE OR REPLACE FUNCTION slopproof_guard_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'preparing' THEN NEW.status IN ('ready','technical_retry','expired','invalidated')
    WHEN 'ready' THEN NEW.status IN ('active','technical_retry','expired','invalidated')
    WHEN 'active' THEN NEW.status IN ('uploading','technical_retry','expired','invalidated')
    WHEN 'uploading' THEN NEW.status IN ('processing','technical_retry','expired','invalidated')
    WHEN 'processing' THEN NEW.status IN ('review_required','technical_retry','expired','invalidated')
    WHEN 'review_required' THEN NEW.status IN ('passed','retry_required','technical_retry','expired','invalidated')
    ELSE false
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid attempt transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('passed','retry_required','technical_retry','expired','invalidated')
     AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'terminal attempt transition requires completed_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'invalidated' AND NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'invalidated attempt requires invalidated_at' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_transition_guard
BEFORE UPDATE OF status ON attempts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_attempt_transition();

CREATE OR REPLACE FUNCTION slopproof_guard_review_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_status attempt_status;
  attempt_sha text;
  revision_current boolean;
BEGIN
  SELECT attempt.status, attempt.head_sha, revision.is_current
  INTO attempt_status, attempt_sha, revision_current
  FROM attempts attempt
  JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
  WHERE attempt.id = NEW.attempt_id
  FOR UPDATE OF attempt;

  IF attempt_status <> 'review_required' THEN
    RAISE EXCEPTION 'review decision requires review_required attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW.head_sha <> attempt_sha OR NOT revision_current THEN
    RAISE EXCEPTION 'review decision is not bound to the current head SHA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_decisions_current_sha_guard
BEFORE INSERT ON review_decisions
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_review_decision();

CREATE OR REPLACE FUNCTION slopproof_guard_success_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.conclusion = 'success' AND NOT EXISTS (
    SELECT 1
    FROM pull_request_revisions revision
    JOIN attempts attempt ON attempt.revision_id = revision.id
    WHERE revision.id = NEW.revision_id
      AND revision.is_current = true
      AND attempt.status = 'passed'
  ) THEN
    RAISE EXCEPTION 'success check requires a passed attempt for the current revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_runs_success_guard
BEFORE INSERT OR UPDATE OF conclusion ON check_runs
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_success_check();

CREATE OR REPLACE FUNCTION slopproof_guard_handoff_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'handoff token was already consumed' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid handoff-token mutation' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER handoff_tokens_single_use
BEFORE UPDATE OF consumed_at ON handoff_tokens
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_handoff_consumption();

CREATE OR REPLACE FUNCTION slopproof_guard_recording_part()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_last integer;
BEGIN
  IF NEW.part_number > 1 THEN
    SELECT last_chunk_index INTO previous_last
    FROM recording_parts
    WHERE upload_session_id = NEW.upload_session_id
      AND part_number = NEW.part_number - 1;
    IF previous_last IS NULL OR NEW.first_chunk_index <> previous_last + 1 THEN
      RAISE EXCEPTION 'recording part range is not contiguous' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.first_chunk_index <> 0 THEN
    RAISE EXCEPTION 'first recording part must start at chunk zero' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recording_parts_contiguous
BEFORE INSERT ON recording_parts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_recording_part();
