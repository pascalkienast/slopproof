import { connectDatabase } from "@understandproof/db";

export async function teardown(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return;

  const database = connectDatabase(databaseUrl);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      TRUNCATE TABLE
        audit_events, deletion_jobs, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, generation_contexts, analysis_snapshots,
        github_revision_sources,
        github_recovery_candidates,
        github_oauth_flows, oauth_start_rate_limits, web_request_rate_limits,
        closed_beta_signups,
        webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    await client.query(`
      DO $cleanup$
      DECLARE
        relation_name text;
      BEGIN
        FOR relation_name IN
          SELECT class.relname
          FROM pg_catalog.pg_class class
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = 'pgboss'
            AND class.relname = ANY (
              ARRAY['job', 'archive', 'schedule', 'job_dependency']
            )
            AND class.relkind IN ('r', 'p')
        LOOP
          EXECUTE format(
            'TRUNCATE TABLE %I.%I CASCADE',
            'pgboss',
            relation_name
          );
        END LOOP;
      END
      $cleanup$;
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await database.close();
  }
}
