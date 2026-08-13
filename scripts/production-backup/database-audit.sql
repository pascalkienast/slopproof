\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset pager off

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT regexp_replace(current_setting('server_version'), '\s.*$', '') AS postgres_version,
       count(DISTINCT class.oid) FILTER (WHERE class.relkind IN ('r', 'p'))::bigint AS table_count,
       count(DISTINCT constraint_row.oid)::bigint AS constraint_count,
       count(DISTINCT trigger_row.oid) FILTER (WHERE NOT trigger_row.tgisinternal)::bigint AS trigger_count
  FROM pg_catalog.pg_class class
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
  LEFT JOIN pg_catalog.pg_constraint constraint_row
    ON constraint_row.conrelid = class.oid
  LEFT JOIN pg_catalog.pg_trigger trigger_row
    ON trigger_row.tgrelid = class.oid
 WHERE namespace.nspname IN ('public', 'pgboss')
\gset

SELECT (to_regclass('public._slopproof_migrations') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS migration_count FROM public._slopproof_migrations
\gset
\else
\set migration_count 0
\endif

\set retention_invariant_violations 0

SELECT (to_regclass('public.attempts') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.attempts
 WHERE evidence_delete_after IS NOT NULL
   AND evidence_delete_after <= created_at
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.recording_objects') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.recording_objects artifact
  LEFT JOIN public.attempts attempt ON attempt.id = artifact.attempt_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR attempt.id IS NULL
    OR attempt.evidence_delete_after IS NULL
    OR artifact.delete_after IS DISTINCT FROM attempt.evidence_delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.transcripts') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.transcripts artifact
  LEFT JOIN public.attempts attempt ON attempt.id = artifact.attempt_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR attempt.id IS NULL
    OR attempt.evidence_delete_after IS NULL
    OR artifact.delete_after IS DISTINCT FROM attempt.evidence_delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.frame_selections') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.frame_selections artifact
  LEFT JOIN public.attempts attempt ON attempt.id = artifact.attempt_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR attempt.id IS NULL
    OR attempt.evidence_delete_after IS NULL
    OR artifact.delete_after IS DISTINCT FROM attempt.evidence_delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.evaluations') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.evaluations artifact
  LEFT JOIN public.attempts attempt ON attempt.id = artifact.attempt_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR attempt.id IS NULL
    OR attempt.evidence_delete_after IS NULL
    OR artifact.delete_after IS DISTINCT FROM attempt.evidence_delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.multimodal_evaluation_sidecars_v1') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.multimodal_evaluation_sidecars_v1 artifact
  LEFT JOIN public.attempts attempt ON attempt.id = artifact.attempt_id
  LEFT JOIN public.recording_objects recording ON recording.attempt_id = artifact.attempt_id
  LEFT JOIN public.transcripts transcript ON transcript.id = artifact.transcript_id
  LEFT JOIN public.evaluations evaluation ON evaluation.id = artifact.evaluation_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR attempt.id IS NULL
    OR recording.id IS NULL
    OR transcript.id IS NULL
    OR evaluation.id IS NULL
    OR artifact.delete_after IS DISTINCT FROM attempt.evidence_delete_after
    OR artifact.delete_after IS DISTINCT FROM recording.delete_after
    OR artifact.delete_after IS DISTINCT FROM transcript.delete_after
    OR artifact.delete_after IS DISTINCT FROM evaluation.delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.semantic_generation_runs') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.semantic_generation_runs
 WHERE delete_after <= created_at
    OR delete_after > created_at + interval '24 hours'
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.practice_sessions') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.practice_sessions
 WHERE generation_context_id IS NOT NULL
   AND (
     delete_after IS NULL
     OR delete_after <= started_at
     OR delete_after > started_at + interval '24 hours'
     OR (deleted_at IS NOT NULL AND deleted_at < started_at)
   )
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.semantic_learning_bundles') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.semantic_learning_bundles artifact
  LEFT JOIN public.semantic_generation_runs run ON run.id = artifact.run_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR run.id IS NULL
    OR artifact.delete_after IS DISTINCT FROM run.delete_after
    OR artifact.created_at IS DISTINCT FROM run.created_at
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.semantic_practice_answers') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.semantic_practice_answers artifact
  LEFT JOIN public.practice_sessions session ON session.id = artifact.practice_session_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR session.id IS NULL
    OR artifact.delete_after IS DISTINCT FROM session.delete_after
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.semantic_practice_feedback') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.semantic_practice_feedback artifact
  LEFT JOIN public.semantic_generation_runs run ON run.id = artifact.run_id
 WHERE artifact.delete_after <= artifact.created_at
    OR (artifact.deleted_at IS NOT NULL AND artifact.deleted_at < artifact.created_at)
    OR run.id IS NULL
    OR artifact.delete_after IS DISTINCT FROM run.delete_after
    OR artifact.created_at IS DISTINCT FROM run.created_at
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT (to_regclass('public.semantic_proof_plans_v2') IS NOT NULL)::text AS relation_exists
\gset
\if :relation_exists
SELECT count(*)::bigint AS next_violations
  FROM public.semantic_proof_plans_v2 artifact
  LEFT JOIN public.semantic_generation_runs run ON run.id = artifact.run_id
 WHERE artifact.delete_after <= artifact.created_at
    OR run.id IS NULL
    OR artifact.delete_after IS DISTINCT FROM run.delete_after
    OR artifact.created_at IS DISTINCT FROM run.created_at
\gset
SELECT (:retention_invariant_violations::bigint + :next_violations::bigint)::bigint
  AS retention_invariant_violations
\gset
\endif

SELECT json_build_object(
  'schema', 'slopproof.database-audit.v1',
  'postgresVersion', :'postgres_version',
  'migrationCount', :migration_count::bigint,
  'tableCount', :table_count::bigint,
  'constraintCount', :constraint_count::bigint,
  'triggerCount', :trigger_count::bigint,
  'retentionInvariantViolations', :retention_invariant_violations::bigint
)::text;

ROLLBACK;
