import { connectDatabase } from "@slopproof/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = connectDatabase(databaseUrl);
try {
  const result = await database.pool.query<{
    allowlist_count: number;
    installation_count: number;
    repository_count: number;
    policy_count: number;
    pull_request_count: number;
    revision_count: number;
    generation_context_count: number;
    semantic_budget_count: number;
    proof_plan_count: number;
    question_count: number;
    attempt_count: number;
    check_run_count: number;
    invalid_policy_binding_count: number;
    invalid_github_id_count: number;
  }>(`
    WITH demo_repository AS (
      SELECT repository.id
      FROM repositories repository
      JOIN installations installation
        ON installation.id = repository.installation_id
      WHERE installation.github_installation_id = '500001'
        AND installation.account_id = '500002'
        AND repository.github_repository_id = '500003'
        AND repository.owner = 'acme'
        AND repository.name = 'cachekit'
    ),
    demo_pull_requests AS (
      SELECT pull_request.id
      FROM pull_requests pull_request
      JOIN demo_repository repository
        ON repository.id = pull_request.repository_id
      WHERE pull_request.number IN (184, 185, 186)
        AND pull_request.author_id = '500004'
        AND pull_request.github_pull_request_id ~ '^[0-9]+$'
    ),
    demo_revisions AS (
      SELECT revision.id
      FROM pull_request_revisions revision
      JOIN demo_pull_requests pull_request
        ON pull_request.id = revision.pull_request_id
      WHERE revision.is_current = true
    ),
    demo_plans AS (
      SELECT plan.id, plan.repository_policy_id
      FROM proof_plans plan
      JOIN demo_revisions revision ON revision.id = plan.revision_id
      WHERE plan.status = 'ready'
    )
    SELECT
      (SELECT count(*)::int FROM github_app_account_allowlist
        WHERE github_account_id = '500002'
          AND status = 'active') AS allowlist_count,
      (SELECT count(*)::int FROM installations
        WHERE github_installation_id = '500001'
          AND account_id = '500002') AS installation_count,
      (SELECT count(*)::int FROM demo_repository) AS repository_count,
      (SELECT count(*)::int
         FROM repository_policies policy
         JOIN demo_repository repository
           ON repository.id = policy.repository_id) AS policy_count,
      (SELECT count(*)::int FROM demo_pull_requests) AS pull_request_count,
      (SELECT count(*)::int FROM demo_revisions) AS revision_count,
      (SELECT count(*)::int
         FROM generation_contexts context
         JOIN demo_revisions revision ON revision.id = context.revision_id)
        AS generation_context_count,
      (SELECT count(*)::int
         FROM semantic_generation_budgets budget
         JOIN demo_revisions revision ON revision.id = budget.revision_id)
        AS semantic_budget_count,
      (SELECT count(*)::int FROM demo_plans) AS proof_plan_count,
      (SELECT count(*)::int
         FROM proof_questions question
         JOIN demo_plans plan ON plan.id = question.proof_plan_id) AS question_count,
      (SELECT count(*)::int
         FROM attempts attempt
         JOIN demo_plans plan ON plan.id = attempt.proof_plan_id
         WHERE attempt.id IN (
           '53000000-0000-4000-8000-000000000001',
           '53000000-0000-4000-8000-000000000002',
           '53000000-0000-4000-8000-000000000003'
         )
           AND attempt.status = 'ready') AS attempt_count,
      (SELECT count(*)::int
         FROM check_runs check_run
         JOIN demo_revisions revision
           ON revision.id = check_run.revision_id) AS check_run_count,
      (SELECT count(*)::int
         FROM demo_plans plan
         LEFT JOIN repository_policies policy
           ON policy.id = plan.repository_policy_id
         LEFT JOIN demo_repository repository
           ON repository.id = policy.repository_id
         WHERE repository.id IS NULL) AS invalid_policy_binding_count,
      (SELECT count(*)::int
         FROM installations installation
         JOIN repositories repository
           ON repository.installation_id = installation.id
         JOIN pull_requests pull_request
           ON pull_request.repository_id = repository.id
         WHERE repository.id IN (SELECT id FROM demo_repository)
           AND (
             installation.github_installation_id !~ '^[0-9]+$'
             OR installation.account_id !~ '^[0-9]+$'
             OR repository.github_repository_id !~ '^[0-9]+$'
             OR pull_request.github_pull_request_id !~ '^[0-9]+$'
             OR pull_request.author_id !~ '^[0-9]+$'
           )) AS invalid_github_id_count
  `);

  const actual = result.rows[0];
  const expected = {
    allowlist_count: 1,
    installation_count: 1,
    repository_count: 1,
    policy_count: 1,
    pull_request_count: 3,
    revision_count: 3,
    generation_context_count: 3,
    semantic_budget_count: 3,
    proof_plan_count: 3,
    question_count: 8,
    attempt_count: 3,
    check_run_count: 3,
    invalid_policy_binding_count: 0,
    invalid_github_id_count: 0,
  } satisfies typeof actual;

  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Demo seed integrity check failed: ${JSON.stringify({ actual, expected })}`,
    );
  }

  process.stdout.write("Demo seed integrity verified.\n");
} finally {
  await database.close();
}
