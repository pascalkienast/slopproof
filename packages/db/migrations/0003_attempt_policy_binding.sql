CREATE OR REPLACE FUNCTION slopproof_guard_attempt_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_sha text;
  revision_repository uuid;
  plan_revision uuid;
  policy_repository uuid;
BEGIN
  SELECT revision.head_sha, pull_request.repository_id
    INTO revision_sha, revision_repository
    FROM pull_request_revisions revision
    JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
   WHERE revision.id = NEW.revision_id;

  SELECT plan.revision_id, policy.repository_id
    INTO plan_revision, policy_repository
    FROM proof_plans plan
    JOIN repository_policies policy ON policy.id = plan.repository_policy_id
   WHERE plan.id = NEW.proof_plan_id;

  IF revision_sha IS NULL OR revision_sha <> NEW.head_sha THEN
    RAISE EXCEPTION 'attempt head SHA does not match its revision'
      USING ERRCODE = '23514';
  END IF;
  IF revision_repository <> NEW.repository_id THEN
    RAISE EXCEPTION 'attempt repository does not match its revision'
      USING ERRCODE = '23514';
  END IF;
  IF plan_revision IS NULL OR plan_revision <> NEW.revision_id THEN
    RAISE EXCEPTION 'attempt proof plan does not match its revision'
      USING ERRCODE = '23514';
  END IF;
  IF policy_repository IS NULL OR policy_repository <> NEW.repository_id THEN
    RAISE EXCEPTION 'attempt frozen policy does not match its repository'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
