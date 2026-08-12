CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE generation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL,
  analysis_snapshot_id uuid NOT NULL,
  head_sha text NOT NULL,
  analyzer_version text NOT NULL,
  context_version text NOT NULL,
  context_hash text NOT NULL,
  canonical_material text NOT NULL,
  provider_material text NOT NULL,
  source_hash text NOT NULL,
  allowed_anchor_ids jsonb NOT NULL,
  limits jsonb NOT NULL,
  exclusions jsonb NOT NULL,
  context jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT generation_contexts_revision_fk
    FOREIGN KEY (revision_id) REFERENCES pull_request_revisions(id)
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT generation_contexts_analysis_snapshot_fk
    FOREIGN KEY (analysis_snapshot_id) REFERENCES analysis_snapshots(id)
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT generation_contexts_head_sha_format
    CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT generation_contexts_analyzer_version_v1
    CHECK (analyzer_version = 'bounded-diff-v1'),
  CONSTRAINT generation_contexts_context_version_v1
    CHECK (context_version = 'generation-context-v1'),
  CONSTRAINT generation_contexts_context_hash_format
    CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generation_contexts_canonical_material_hash CHECK (
    encode(digest(convert_to(canonical_material, 'UTF8'), 'sha256'), 'hex') = context_hash
  ),
  CONSTRAINT generation_contexts_canonical_material_binding CHECK (
    canonical_material::jsonb = context - 'contextHash'
  ),
  CONSTRAINT generation_contexts_canonical_material_size CHECK (
    octet_length(convert_to(canonical_material, 'UTF8')) <= 2097152
  ),
  CONSTRAINT generation_contexts_provider_material_binding CHECK (
    provider_material::jsonb = jsonb_build_object(
      'schemaVersion', '1',
      'trust', 'untrusted_github_revision',
      'title', context->'title',
      'body', context->'body',
      'files', context->'files',
      'anchors', context->'anchors',
      'excerpts', context->'excerpts',
      'deterministicTestFiles', context->'deterministicTestFiles',
      'allowedAnchorIds', context->'allowedAnchorIds',
      'limits', context->'limits',
      'limitsHit', context->'limitsHit',
      'exclusions', context->'exclusions'
    )
  ),
  CONSTRAINT generation_contexts_provider_material_size CHECK (
    octet_length(convert_to(provider_material, 'UTF8')) =
      (context->'usage'->>'providerBytes')::integer
    AND octet_length(convert_to(provider_material, 'UTF8')) <=
      (context->'limits'->>'maximumTotalBytes')::integer
  ),
  CONSTRAINT generation_contexts_source_hash_format
    CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generation_contexts_allowed_anchors_array
    CHECK (
      jsonb_typeof(allowed_anchor_ids) = 'array'
      AND jsonb_array_length(allowed_anchor_ids) <= 400
    ),
  CONSTRAINT generation_contexts_limits_object
    CHECK (jsonb_typeof(limits) = 'object'),
  CONSTRAINT generation_contexts_exclusions_array
    CHECK (
      jsonb_typeof(exclusions) = 'array'
      AND jsonb_array_length(exclusions) <= 600
    ),
  CONSTRAINT generation_contexts_context_object
    CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT generation_contexts_context_size_bound
    CHECK (octet_length(context::text) <= 2097152),
  CONSTRAINT generation_contexts_json_binding CHECK (
    context->>'schemaVersion' = '1'
    AND context->>'contextVersion' = context_version
    AND context->>'revisionId' = revision_id::text
    AND context->>'analysisSnapshotId' = analysis_snapshot_id::text
    AND context->>'headSha' = head_sha
    AND context->>'analyzerVersion' = analyzer_version
    AND context->>'contextHash' = context_hash
    AND context->>'sourceHash' = source_hash
    AND context->'allowedAnchorIds' = allowed_anchor_ids
    AND context->'limits' = limits
    AND context->'exclusions' = exclusions
  )
);

CREATE UNIQUE INDEX generation_contexts_snapshot_version_uq
  ON generation_contexts(analysis_snapshot_id, context_version);
CREATE UNIQUE INDEX generation_contexts_revision_hash_uq
  ON generation_contexts(revision_id, context_hash);
CREATE INDEX generation_contexts_revision_idx
  ON generation_contexts(revision_id, created_at);

CREATE OR REPLACE FUNCTION slopproof_validate_generation_context_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_anchor_ids jsonb;
  anchor_count integer;
  distinct_anchor_count integer;
  referenced_anchor_count integer;
  distinct_referenced_anchor_count integer;
  unknown_referenced_anchor_count integer;
  expected_context_anchors jsonb;
BEGIN
  PERFORM 1
    FROM analysis_snapshots
   WHERE id = NEW.analysis_snapshot_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Generation context snapshot is unavailable'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COALESCE(
      (
        SELECT jsonb_agg(anchor.item->'id' ORDER BY anchor.ordinality)
          FROM jsonb_array_elements(snapshot.snapshot->'anchors')
               WITH ORDINALITY AS anchor(item, ordinality)
      ),
      '[]'::jsonb
    )
    INTO expected_anchor_ids
    FROM analysis_snapshots snapshot
    JOIN pull_request_revisions revision
      ON revision.id = snapshot.revision_id
    JOIN pull_requests pull_request
      ON pull_request.id = revision.pull_request_id
    JOIN github_revision_sources source
      ON source.revision_id = revision.id
   WHERE snapshot.id = NEW.analysis_snapshot_id
     AND snapshot.revision_id = NEW.revision_id
     AND snapshot.status = 'ready'
     AND snapshot.analyzer_version = NEW.analyzer_version
     AND snapshot.snapshot->>'headSha' = NEW.head_sha
     AND snapshot.snapshot->>'baseSha' = NEW.context->>'baseSha'
     AND revision.head_sha = NEW.head_sha
     AND revision.base_sha = NEW.context->>'baseSha'
     AND source.head_sha = NEW.head_sha
     AND source.base_sha = NEW.context->>'baseSha'
     AND source.source_hash = NEW.source_hash
     AND pull_request.state = 'open'
     AND source.source->>'githubPullRequestId' = pull_request.github_pull_request_id
     AND (source.source->>'number')::integer = pull_request.number
     AND source.source->>'authorId' = pull_request.author_id
     AND source.source->>'state' = pull_request.state;

  IF expected_anchor_ids IS NULL
     OR expected_anchor_ids IS DISTINCT FROM NEW.allowed_anchor_ids THEN
    RAISE EXCEPTION 'Generation context binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', anchor.item->>'id',
               'filename', jsonb_build_object(
                 'trust', 'untrusted',
                 'source', 'pull_request_filename',
                 'content', anchor.item->>'file'
               ),
               'hunkHeader', jsonb_build_object(
                 'trust', 'untrusted',
                 'source', 'analysis_hunk_header',
                 'content', anchor.item->>'hunkHeader'
               ),
               'oldStart', anchor.item->'oldStart',
               'newStart', anchor.item->'newStart',
               'changedLines', anchor.item->'changedLines',
               'evidence', jsonb_build_object(
                 'trust', 'untrusted',
                 'source', 'analysis_anchor_evidence',
                 'content', anchor.item->>'evidence'
               )
             ) ORDER BY anchor.ordinality
           ),
           '[]'::jsonb
         )
    INTO expected_context_anchors
    FROM analysis_snapshots snapshot
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.snapshot->'anchors')
      WITH ORDINALITY AS anchor(item, ordinality)
   WHERE snapshot.id = NEW.analysis_snapshot_id;

  IF expected_context_anchors IS DISTINCT FROM NEW.context->'anchors' THEN
    RAISE EXCEPTION 'Generation context anchor material is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer, count(DISTINCT anchor_id)::integer
    INTO anchor_count, distinct_anchor_count
    FROM jsonb_array_elements_text(NEW.allowed_anchor_ids) AS anchor(anchor_id)
   WHERE anchor_id ~ '^a[0-9]+$';

  IF anchor_count <> jsonb_array_length(NEW.allowed_anchor_ids)
     OR distinct_anchor_count <> anchor_count THEN
    RAISE EXCEPTION 'Generation context anchors are invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer,
         count(DISTINCT anchor.anchor_id)::integer,
         count(*) FILTER (
           WHERE NOT NEW.allowed_anchor_ids @> jsonb_build_array(anchor.anchor_id)
         )::integer
    INTO referenced_anchor_count, distinct_referenced_anchor_count,
         unknown_referenced_anchor_count
    FROM jsonb_array_elements(NEW.context->'files') AS context_file(file_data)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      context_file.file_data->'anchorIds'
    ) AS anchor(anchor_id);

  IF referenced_anchor_count <> anchor_count
     OR distinct_referenced_anchor_count <> anchor_count
     OR unknown_referenced_anchor_count <> 0 THEN
    RAISE EXCEPTION 'Generation context file anchors are invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_contexts_validate_v1
BEFORE INSERT ON generation_contexts
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_generation_context_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_generation_context_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Generation context is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER generation_contexts_immutable
BEFORE UPDATE OR DELETE ON generation_contexts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_generation_context_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_bound_analysis_snapshot_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM generation_contexts
     WHERE analysis_snapshot_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Bound analysis snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER analysis_snapshots_generation_context_immutable
BEFORE UPDATE OR DELETE ON analysis_snapshots
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_bound_analysis_snapshot_v1();

CREATE OR REPLACE FUNCTION slopproof_guard_bound_revision_tuple_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM generation_contexts WHERE revision_id = OLD.id
  ) AND (
    NEW.pull_request_id IS DISTINCT FROM OLD.pull_request_id
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
  ) THEN
    RAISE EXCEPTION 'Bound revision tuple is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pull_request_revisions_generation_context_immutable
BEFORE UPDATE ON pull_request_revisions
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_bound_revision_tuple_v1();

ALTER TABLE proof_plans ADD COLUMN generation_context_id uuid;
ALTER TABLE proof_plans ADD CONSTRAINT proof_plans_generation_context_fk
  FOREIGN KEY (generation_context_id) REFERENCES generation_contexts(id)
  ON DELETE restrict ON UPDATE no action;
CREATE INDEX proof_plans_generation_context_idx
  ON proof_plans(generation_context_id);

CREATE OR REPLACE FUNCTION slopproof_validate_proof_context_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.generation_context_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM github_revision_sources
       WHERE revision_id = NEW.revision_id
    ) THEN
      RAISE EXCEPTION 'Production proof plan requires a generation context'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM generation_contexts
     WHERE id = NEW.generation_context_id
       AND revision_id = NEW.revision_id
  ) THEN
    RAISE EXCEPTION 'Proof plan generation context binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_plans_generation_context_binding
BEFORE INSERT OR UPDATE OF revision_id, generation_context_id ON proof_plans
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_proof_context_v1();

CREATE OR REPLACE FUNCTION slopproof_validate_proof_question_anchor_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_context jsonb;
BEGIN
  SELECT generation_context.context
    INTO bound_context
    FROM proof_plans plan
    JOIN generation_contexts generation_context
      ON generation_context.id = plan.generation_context_id
   WHERE plan.id = NEW.proof_plan_id;

  IF bound_context IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM proof_plans plan
        JOIN github_revision_sources source
          ON source.revision_id = plan.revision_id
       WHERE plan.id = NEW.proof_plan_id
    ) THEN
      RAISE EXCEPTION 'Production proof question requires a generation context'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(bound_context->'anchors') AS anchor(item)
     WHERE anchor.item->>'id' = NEW.diff_anchor->>'id'
       AND anchor.item->'filename'->>'content' = NEW.diff_anchor->>'file'
       AND anchor.item->'hunkHeader'->>'content' = NEW.diff_anchor->>'hunkHeader'
       AND (anchor.item->>'oldStart')::integer =
         (NEW.diff_anchor->>'oldStart')::integer
       AND (anchor.item->>'newStart')::integer =
         (NEW.diff_anchor->>'newStart')::integer
       AND (anchor.item->>'changedLines')::integer =
         (NEW.diff_anchor->>'changedLines')::integer
  ) THEN
    RAISE EXCEPTION 'Proof question anchor is outside the generation context'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_questions_generation_context_anchor
BEFORE INSERT OR UPDATE OF proof_plan_id, diff_anchor ON proof_questions
FOR EACH ROW EXECUTE FUNCTION slopproof_validate_proof_question_anchor_v1();
