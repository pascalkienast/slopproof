CREATE TABLE multimodal_evaluation_sidecars_v1 (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES pull_request_revisions(id) ON DELETE CASCADE,
  head_sha text NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  evaluation_version text NOT NULL,
  output_schema_version text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  encrypted_payload jsonb,
  provider_completed_at timestamp with time zone NOT NULL,
  delete_after timestamp with time zone NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT multimodal_evaluation_sidecars_v1_attempt_uq UNIQUE (attempt_id),
  CONSTRAINT multimodal_evaluation_sidecars_v1_evaluation_uq UNIQUE (evaluation_id),
  CONSTRAINT multimodal_evaluation_sidecars_v1_head_sha CHECK (
    head_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT multimodal_evaluation_sidecars_v1_hashes CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
    AND output_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT multimodal_evaluation_sidecars_v1_versions CHECK (
    prompt_version = 'proof-judge-system-v2'
    AND evaluation_version = 'multimodal-proof-evaluation-v1'
    AND output_schema_version = 'multimodal-judge-candidate-v1'
  ),
  CONSTRAINT multimodal_evaluation_sidecars_v1_ciphertext_lifecycle CHECK (
    (encrypted_payload IS NOT NULL AND deleted_at IS NULL)
    OR (encrypted_payload IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT multimodal_evaluation_sidecars_v1_ciphertext_envelope CHECK (
    encrypted_payload IS NULL OR (
      jsonb_typeof(encrypted_payload) = 'object'
      AND encrypted_payload->>'schemaVersion' = '1'
      AND encrypted_payload->>'algorithm' = 'aes-256-gcm'
      AND encrypted_payload->>'nonce' ~ '^[A-Za-z0-9+/]{16}$'
      AND encrypted_payload->>'ciphertext' ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      AND length(encrypted_payload->>'ciphertext') > 0
      AND encrypted_payload->>'authenticationTag' ~ '^(?:[A-Za-z0-9+/]{4}){5}[A-Za-z0-9+/]{2}==$'
      AND encrypted_payload->>'aadSha256' ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT multimodal_evaluation_sidecars_v1_retention CHECK (
    provider_completed_at <= created_at
    AND delete_after > created_at
  )
);

CREATE INDEX multimodal_evaluation_sidecars_v1_retention_idx
  ON multimodal_evaluation_sidecars_v1(delete_after, id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION slopproof_validate_multimodal_sidecar_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_aad text;
BEGIN
  PERFORM 1
    FROM attempts attempt
    JOIN pull_request_revisions revision
      ON revision.id = attempt.revision_id
    JOIN pull_requests pull_request
      ON pull_request.id = revision.pull_request_id
     AND pull_request.repository_id = attempt.repository_id
    JOIN repositories repository ON repository.id = attempt.repository_id
    JOIN installations installation
      ON installation.id = repository.installation_id
    JOIN recording_objects recording ON recording.attempt_id = attempt.id
    JOIN transcripts transcript
      ON transcript.id = NEW.transcript_id
     AND transcript.attempt_id = attempt.id
    JOIN evaluations evaluation
      ON evaluation.id = NEW.evaluation_id
     AND evaluation.attempt_id = attempt.id
   WHERE attempt.id = NEW.attempt_id
     AND attempt.revision_id = NEW.revision_id
     AND attempt.head_sha = NEW.head_sha
     AND revision.head_sha = NEW.head_sha
     AND revision.is_current = true
     AND attempt.status = 'processing'
     AND pull_request.state = 'open'
     AND repository.status = 'active'
     AND installation.status = 'active'
     AND attempt.evidence_delete_after IS NOT NULL
     AND attempt.evidence_delete_after = NEW.delete_after
     AND recording.delete_after = NEW.delete_after
     AND recording.deleted_at IS NULL
     AND transcript.delete_after = NEW.delete_after
     AND transcript.deleted_at IS NULL
     AND evaluation.delete_after = NEW.delete_after
     AND evaluation.deleted_at IS NULL
     AND evaluation.recommendation = 'review_required'
     AND NEW.delete_after > clock_timestamp()
   FOR UPDATE OF attempt, revision, pull_request, repository, installation,
                 recording, transcript, evaluation;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Multimodal evaluation sidecar binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_aad := concat_ws(
    ':',
    'slopproof',
    'multimodal-evaluation-sidecar',
    'v1',
    NEW.attempt_id::text,
    NEW.revision_id::text,
    NEW.head_sha,
    NEW.evaluation_id::text,
    NEW.transcript_id::text,
    NEW.input_hash
  );
  IF NEW.encrypted_payload->>'aadSha256' IS DISTINCT FROM
     encode(digest(convert_to(expected_aad, 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'Multimodal evaluation sidecar AAD binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER multimodal_evaluation_sidecars_v1_validate
BEFORE INSERT ON multimodal_evaluation_sidecars_v1
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_multimodal_sidecar_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_multimodal_sidecar_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'multimodal_evaluation_sidecars_v1 is retention-shredded, not deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.encrypted_payload IS NULL
     OR NEW.encrypted_payload IS NOT NULL
     OR NEW.deleted_at IS NULL
     OR NEW.deleted_at < OLD.delete_after
     OR (to_jsonb(NEW) - 'encrypted_payload' - 'deleted_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'encrypted_payload' - 'deleted_at')
     OR NOT EXISTS (
       SELECT 1 FROM deletion_jobs deletion
        WHERE deletion.object_class = 'attempt_evidence'
          AND deletion.object_id = OLD.attempt_id::text
          AND deletion.state = 'running'
          AND deletion.deadline <= NEW.deleted_at
     ) THEN
    RAISE EXCEPTION 'multimodal_evaluation_sidecars_v1 is immutable outside retention shredding'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER multimodal_evaluation_sidecars_v1_immutable
BEFORE UPDATE OR DELETE ON multimodal_evaluation_sidecars_v1
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_multimodal_sidecar_v1();
