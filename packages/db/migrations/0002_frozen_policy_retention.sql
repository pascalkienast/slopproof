ALTER TABLE "proof_plans" ADD COLUMN "repository_policy_id" uuid;

INSERT INTO repository_policies
  (repository_id, version, schema_version, policy, policy_hash,
   created_by, activated_at)
SELECT DISTINCT repository.id, 1, '1',
       '{"schemaVersion":"1","decisionMode":"maintainer_review","proof":{"minimumQuestions":1,"maximumQuestions":5,"maximumDurationSeconds":600,"maximumUploadBytes":500000000},"evidence":{"retentionHours":24,"deleteAfterMaintainerPass":true}}'::jsonb,
       '815e7c457542310d9ea1223d99113e1a4e5a2472f70f5cc30077adfeb742649c',
       'migration-default', now()
FROM proof_plans plan
JOIN pull_request_revisions revision ON revision.id = plan.revision_id
JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
JOIN repositories repository ON repository.id = pull_request.repository_id
LEFT JOIN repository_policies policy
  ON policy.repository_id = repository.id
 AND policy.version = repository.active_policy_version
WHERE policy.id IS NULL
  AND repository.active_policy_version = 1
ON CONFLICT (repository_id, version) DO NOTHING;

ALTER TABLE "proof_plans" DISABLE TRIGGER "proof_plans_immutable_after_attempt";

UPDATE "proof_plans" plan
SET "repository_policy_id" = policy.id
FROM "pull_request_revisions" revision
JOIN "pull_requests" pull_request ON pull_request.id = revision.pull_request_id
JOIN "repositories" repository ON repository.id = pull_request.repository_id
JOIN "repository_policies" policy
  ON policy.repository_id = repository.id
 AND policy.version = repository.active_policy_version
WHERE plan.revision_id = revision.id
  AND plan.repository_policy_id IS NULL;

ALTER TABLE "proof_plans" ENABLE TRIGGER "proof_plans_immutable_after_attempt";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM proof_plans WHERE repository_policy_id IS NULL) THEN
    RAISE EXCEPTION 'cannot bind existing proof plan to an active repository policy';
  END IF;
END;
$$;

ALTER TABLE "proof_plans" ALTER COLUMN "repository_policy_id" SET NOT NULL;
ALTER TABLE "proof_plans" ADD CONSTRAINT "proof_plans_repository_policy_id_repository_policies_id_fk"
  FOREIGN KEY ("repository_policy_id") REFERENCES "public"."repository_policies"("id")
  ON DELETE restrict ON UPDATE no action;
CREATE INDEX "proof_plans_repository_policy_idx" ON "proof_plans" USING btree ("repository_policy_id");

ALTER TABLE "attempts" ADD COLUMN "evidence_delete_after" timestamp with time zone;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT attempt_id, min(delete_after) AS earliest, max(delete_after) AS latest
      FROM (
        SELECT attempt_id, delete_after FROM recording_objects
        UNION ALL SELECT attempt_id, delete_after FROM transcripts
        UNION ALL SELECT attempt_id, delete_after FROM frame_selections
        UNION ALL SELECT attempt_id, delete_after FROM evaluations
      ) artifact
      GROUP BY attempt_id
    ) deadlines
    WHERE deadlines.earliest IS DISTINCT FROM deadlines.latest
  ) THEN
    RAISE EXCEPTION 'existing evidence artifacts have divergent deletion deadlines';
  END IF;
END;
$$;

UPDATE attempts attempt
SET evidence_delete_after = deadlines.deadline
FROM (
  SELECT attempt_id, max(delete_after) AS deadline
  FROM (
    SELECT attempt_id, delete_after FROM recording_objects
    UNION ALL SELECT attempt_id, delete_after FROM transcripts
    UNION ALL SELECT attempt_id, delete_after FROM frame_selections
    UNION ALL SELECT attempt_id, delete_after FROM evaluations
  ) artifact
  GROUP BY attempt_id
) deadlines
WHERE attempt.id = deadlines.attempt_id;

CREATE INDEX "attempts_evidence_delete_after_idx"
  ON "attempts" USING btree ("evidence_delete_after")
  WHERE "evidence_delete_after" IS NOT NULL;

CREATE OR REPLACE FUNCTION slopproof_guard_proof_plan_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_repository uuid;
  policy_repository uuid;
BEGIN
  SELECT pull_request.repository_id
    INTO revision_repository
    FROM pull_request_revisions revision
    JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
   WHERE revision.id = NEW.revision_id;

  SELECT repository_id
    INTO policy_repository
    FROM repository_policies
   WHERE id = NEW.repository_policy_id;

  IF revision_repository IS NULL OR policy_repository IS NULL
     OR revision_repository <> policy_repository THEN
    RAISE EXCEPTION 'proof plan policy does not belong to the revision repository'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_plans_repository_policy_binding
BEFORE INSERT OR UPDATE OF revision_id, repository_policy_id ON proof_plans
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_proof_plan_policy();

CREATE OR REPLACE FUNCTION slopproof_guard_evidence_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.evidence_delete_after IS NOT NULL
     AND NEW.evidence_delete_after IS DISTINCT FROM OLD.evidence_delete_after THEN
    RAISE EXCEPTION 'accepted evidence deletion deadline is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_evidence_deadline_immutable
BEFORE UPDATE OF evidence_delete_after ON attempts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_evidence_deadline();

CREATE OR REPLACE FUNCTION slopproof_guard_artifact_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_deadline timestamptz;
BEGIN
  SELECT evidence_delete_after
    INTO accepted_deadline
    FROM attempts
   WHERE id = NEW.attempt_id;

  IF accepted_deadline IS NULL OR NEW.delete_after IS DISTINCT FROM accepted_deadline THEN
    RAISE EXCEPTION 'evidence artifact deadline must equal the accepted attempt deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recording_objects_deadline_binding
BEFORE INSERT OR UPDATE OF attempt_id, delete_after ON recording_objects
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_artifact_deadline();

CREATE TRIGGER transcripts_deadline_binding
BEFORE INSERT OR UPDATE OF attempt_id, delete_after ON transcripts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_artifact_deadline();

CREATE TRIGGER frame_selections_deadline_binding
BEFORE INSERT OR UPDATE OF attempt_id, delete_after ON frame_selections
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_artifact_deadline();

CREATE TRIGGER evaluations_deadline_binding
BEFORE INSERT OR UPDATE OF attempt_id, delete_after ON evaluations
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_artifact_deadline();
