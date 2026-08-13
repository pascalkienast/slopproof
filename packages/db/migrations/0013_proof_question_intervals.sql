CREATE TABLE proof_question_interval_sets (
  attempt_id uuid PRIMARY KEY REFERENCES attempts(id)
    ON DELETE cascade ON UPDATE no action,
  upload_session_id uuid NOT NULL UNIQUE REFERENCES upload_sessions(id)
    ON DELETE cascade ON UPDATE no action,
  manifest_digest text NOT NULL,
  interval_version text NOT NULL,
  maximum_question_duration_ms integer NOT NULL,
  recorded_duration_ms integer NOT NULL,
  intervals jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT proof_question_interval_sets_digest_format CHECK (
    manifest_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proof_question_interval_sets_version CHECK (
    interval_version = 'proof-question-interval-v1'
  ),
  CONSTRAINT proof_question_interval_sets_duration CHECK (
    recorded_duration_ms BETWEEN 1 AND 480000
  ),
  CONSTRAINT proof_question_interval_sets_question_duration CHECK (
    maximum_question_duration_ms = 120000
  ),
  CONSTRAINT proof_question_interval_sets_array CHECK (
    jsonb_typeof(intervals) = 'array'
    AND jsonb_array_length(intervals) BETWEEN 1 AND 5
    AND octet_length(intervals::text) <= 8192
  )
);

CREATE OR REPLACE FUNCTION slopproof_validate_proof_question_intervals_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_question_ids jsonb;
  supplied_question_ids jsonb;
  invalid_interval_count integer;
  first_start_ms integer;
  final_end_ms integer;
  bound_envelope jsonb;
  bound_manifest_digest text;
  bound_duration_ms integer;
  expected_question_budget integer;
  expected_question_count integer;
  expected_min_ordinal integer;
  expected_max_ordinal integer;
  expected_distinct_ordinals integer;
BEGIN
  SELECT
    COALESCE(
      jsonb_agg(to_jsonb(question.id::text) ORDER BY question.ordinal),
      '[]'::jsonb
    ),
    upload.finalize_envelope,
    upload.manifest_digest,
    (upload.finalize_envelope->'manifest'->>'durationMs')::integer,
    proof_plan.question_budget,
    count(question.id)::integer,
    min(question.ordinal)::integer,
    max(question.ordinal)::integer,
    count(DISTINCT question.ordinal)::integer
    INTO expected_question_ids, bound_envelope, bound_manifest_digest,
         bound_duration_ms, expected_question_budget,
         expected_question_count, expected_min_ordinal,
         expected_max_ordinal, expected_distinct_ordinals
    FROM attempts attempt
    JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
    JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
    JOIN upload_sessions upload
      ON upload.id = NEW.upload_session_id
     AND upload.attempt_id = attempt.id
    JOIN proof_questions question
      ON question.proof_plan_id = attempt.proof_plan_id
     AND question.required = true
   WHERE attempt.id = NEW.attempt_id
     AND attempt.status = 'processing'
     AND revision.is_current = true
     AND upload.state = 'pending_finalization'
   GROUP BY upload.id, upload.finalize_envelope, upload.manifest_digest,
            proof_plan.question_budget;

  IF expected_question_ids IS NULL
     OR jsonb_array_length(expected_question_ids) = 0
     OR bound_envelope IS NULL
     OR bound_manifest_digest IS DISTINCT FROM NEW.manifest_digest
     OR bound_duration_ms IS DISTINCT FROM NEW.recorded_duration_ms
     OR expected_question_count IS DISTINCT FROM expected_question_budget
     OR expected_distinct_ordinals IS DISTINCT FROM expected_question_budget
     OR expected_min_ordinal IS DISTINCT FROM 0
     OR expected_max_ordinal IS DISTINCT FROM expected_question_budget - 1
     OR bound_envelope->'manifest'->'questionIntervals'
        IS DISTINCT FROM NEW.intervals THEN
    RAISE EXCEPTION 'Proof question interval binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    jsonb_agg(interval.item->'questionId' ORDER BY interval.ordinality),
    count(*) FILTER (
      WHERE jsonb_typeof(interval.item) <> 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(interval.item)) <> 8
         OR interval.item->>'schemaVersion' <> '1'
         OR interval.item->>'intervalVersion' <>
            'proof-question-interval-v1'
         OR interval.item->>'source' <> 'mobile_navigation_v1'
         OR COALESCE(interval.item->>'questionId', '') !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR COALESCE(interval.item->>'ordinal', '') !~ '^(0|[1-9][0-9]*)$'
         OR (interval.item->>'ordinal')::integer <>
            interval.ordinality::integer - 1
         OR COALESCE(interval.item->>'startMs', '') !~ '^(0|[1-9][0-9]*)$'
         OR COALESCE(interval.item->>'endMs', '') !~ '^[1-9][0-9]*$'
         OR COALESCE(interval.item->>'recordedDurationMs', '') !~
            '^[1-9][0-9]*$'
         OR (interval.item->>'recordedDurationMs')::integer <>
            NEW.recorded_duration_ms
         OR (interval.item->>'startMs')::integer >=
            (interval.item->>'endMs')::integer
         OR (interval.item->>'endMs')::integer > NEW.recorded_duration_ms
         OR (interval.item->>'endMs')::integer -
            (interval.item->>'startMs')::integer >
            NEW.maximum_question_duration_ms
         OR (
           interval.ordinality > 1
           AND (interval.item->>'startMs')::integer <>
               (NEW.intervals->(interval.ordinality::integer - 2)->>'endMs')::integer
         )
    )::integer,
    (NEW.intervals->0->>'startMs')::integer,
    (NEW.intervals->(jsonb_array_length(NEW.intervals) - 1)->>'endMs')::integer
    INTO supplied_question_ids, invalid_interval_count, first_start_ms,
         final_end_ms
    FROM jsonb_array_elements(NEW.intervals)
      WITH ORDINALITY AS interval(item, ordinality);

  IF supplied_question_ids IS DISTINCT FROM expected_question_ids
     OR invalid_interval_count <> 0
     OR first_start_ms > 1000
     OR NEW.recorded_duration_ms - final_end_ms NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'Proof question interval set is incomplete or inconsistent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_question_interval_sets_validate_v1
BEFORE INSERT ON proof_question_interval_sets
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_proof_question_intervals_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_proof_question_intervals_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Proof question interval sets are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER proof_question_interval_sets_immutable
BEFORE UPDATE ON proof_question_interval_sets
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_proof_question_intervals_v1();

CREATE INDEX proof_question_interval_sets_upload_idx
  ON proof_question_interval_sets(upload_session_id, manifest_digest);

-- The original invariant guarded UPDATE/DELETE only. Extend it to INSERT and
-- lock the parent plan so a concurrent Attempt insert cannot race a late
-- question into an already served plan.
DROP TRIGGER proof_questions_immutable_after_attempt ON proof_questions;

CREATE OR REPLACE FUNCTION slopproof_guard_proof_question()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_proof_plan_id uuid;
  source_proof_plan_id uuid;
  exact_replay boolean := false;
BEGIN
  target_proof_plan_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.proof_plan_id
    ELSE NEW.proof_plan_id
  END;
  source_proof_plan_id := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.proof_plan_id
    ELSE OLD.proof_plan_id
  END;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM proof_questions question
       WHERE question.proof_plan_id = NEW.proof_plan_id
         AND question.ordinal = NEW.ordinal
         AND question.id = NEW.id
         AND question.type IS NOT DISTINCT FROM NEW.type
         AND question.prompt IS NOT DISTINCT FROM NEW.prompt
         AND question.diff_anchor IS NOT DISTINCT FROM NEW.diff_anchor
         AND question.rubric IS NOT DISTINCT FROM NEW.rubric
         AND question.required IS NOT DISTINCT FROM NEW.required
    ) INTO exact_replay;
    IF exact_replay THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM 1 FROM proof_plans
   WHERE id IN (source_proof_plan_id, target_proof_plan_id)
   ORDER BY id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM attempts
     WHERE proof_plan_id IN (source_proof_plan_id, target_proof_plan_id)
  ) THEN
    RAISE EXCEPTION 'proof questions are immutable after attempt creation'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER proof_questions_immutable_after_attempt
BEFORE INSERT OR UPDATE OR DELETE ON proof_questions
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_proof_question();
