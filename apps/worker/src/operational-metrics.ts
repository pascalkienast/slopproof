import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  JOB_NAMES,
  JobNameSchema,
  type DatabaseConnection,
} from "@slopproof/db";
import type { PoolClient } from "pg";
import { z } from "zod";

const OPERATIONAL_METRICS_PATH = "/internal/metrics";
const OPERATIONAL_WINDOW_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_METRIC_COUNT = 2_147_483_647;

const ProviderPurposeSchema = z.enum([
  "learning_material",
  "practice_feedback",
  "proof_questions",
]);
const ProviderOutcomeSchema = z.enum(["generated", "repaired", "fallback"]);
const PrivateProviderStageSchema = z.enum([
  "speech_to_text",
  "multimodal_judge",
]);
const PrivateProviderOutcomeSchema = z.literal("artifact_persisted");
const LatencyBucketSchema = z.union([
  z.literal(1_000),
  z.literal(5_000),
  z.literal(15_000),
  z.literal(60_000),
  z.literal(300_000),
  z.literal(900_000),
]);
const MetricCountSchema = z.number().int().min(0).max(MAX_METRIC_COUNT);

const QueueMetricSchema = z
  .object({
    name: JobNameSchema,
    depth: MetricCountSchema,
    failed: MetricCountSchema,
    due: MetricCountSchema,
  })
  .strict();
const ProviderOutcomeMetricSchema = z
  .object({
    purpose: ProviderPurposeSchema,
    outcome: ProviderOutcomeSchema,
    count: MetricCountSchema,
  })
  .strict();
const ProviderLatencyMetricSchema = z
  .object({
    purpose: ProviderPurposeSchema,
    leMs: LatencyBucketSchema,
    count: MetricCountSchema,
  })
  .strict();
const PrivateProviderOutcomeMetricSchema = z
  .object({
    stage: PrivateProviderStageSchema,
    outcome: PrivateProviderOutcomeSchema,
    count: MetricCountSchema,
  })
  .strict();

export const OperationalMetricsSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    generatedAt: z.iso.datetime(),
    windowSeconds: z.literal(OPERATIONAL_WINDOW_SECONDS),
    queue: z.array(QueueMetricSchema).length(JOB_NAMES.length),
    providers: z
      .object({
        outcomes: z.array(ProviderOutcomeMetricSchema).length(9),
        latencyBuckets: z.array(ProviderLatencyMetricSchema).length(18),
        privateOutcomes: z.array(PrivateProviderOutcomeMetricSchema).length(2),
      })
      .strict(),
    retention: z
      .object({
        due: MetricCountSchema,
        failed: MetricCountSchema,
        shredded: MetricCountSchema,
      })
      .strict(),
    githubCheckReconciliation: z
      .object({
        pending: MetricCountSchema,
        retry: MetricCountSchema,
        terminal: MetricCountSchema,
      })
      .strict(),
  })
  .strict();

export type OperationalMetricsSnapshotV1 = z.infer<
  typeof OperationalMetricsSnapshotV1Schema
>;

const QueueRowSchema = z
  .object({
    metric_group: z.literal("queue"),
    dimension_a: JobNameSchema,
    dimension_b: z.null(),
    bucket_le_ms: z.null(),
    value_a: MetricCountSchema,
    value_b: MetricCountSchema,
    value_c: MetricCountSchema,
  })
  .strict();
const ProviderOutcomeRowSchema = z
  .object({
    metric_group: z.literal("provider_outcome"),
    dimension_a: ProviderPurposeSchema,
    dimension_b: ProviderOutcomeSchema,
    bucket_le_ms: z.null(),
    value_a: MetricCountSchema,
    value_b: z.null(),
    value_c: z.null(),
  })
  .strict();
const ProviderLatencyRowSchema = z
  .object({
    metric_group: z.literal("provider_latency"),
    dimension_a: ProviderPurposeSchema,
    dimension_b: z.null(),
    bucket_le_ms: LatencyBucketSchema,
    value_a: MetricCountSchema,
    value_b: z.null(),
    value_c: z.null(),
  })
  .strict();
const PrivateProviderOutcomeRowSchema = z
  .object({
    metric_group: z.literal("private_provider_outcome"),
    dimension_a: PrivateProviderStageSchema,
    dimension_b: PrivateProviderOutcomeSchema,
    bucket_le_ms: z.null(),
    value_a: MetricCountSchema,
    value_b: z.null(),
    value_c: z.null(),
  })
  .strict();
const RetentionRowSchema = z
  .object({
    metric_group: z.literal("retention"),
    dimension_a: z.null(),
    dimension_b: z.null(),
    bucket_le_ms: z.null(),
    value_a: MetricCountSchema,
    value_b: MetricCountSchema,
    value_c: MetricCountSchema,
  })
  .strict();
const CheckReconciliationRowSchema = z
  .object({
    metric_group: z.literal("github_check_reconciliation"),
    dimension_a: z.null(),
    dimension_b: z.null(),
    bucket_le_ms: z.null(),
    value_a: MetricCountSchema,
    value_b: MetricCountSchema,
    value_c: MetricCountSchema,
  })
  .strict();
const OperationalMetricRowSchema = z.discriminatedUnion("metric_group", [
  QueueRowSchema,
  ProviderOutcomeRowSchema,
  ProviderLatencyRowSchema,
  PrivateProviderOutcomeRowSchema,
  RetentionRowSchema,
  CheckReconciliationRowSchema,
]);

type OperationalMetricRow = z.infer<typeof OperationalMetricRowSchema>;

export type OperationalMetricsDependencies = {
  database: DatabaseConnection;
  bearerSecret: string;
  now?: () => Date;
  monotonicNow?: () => number;
  timeoutMs?: number;
};

const OPERATIONAL_METRICS_SQL = `
WITH approved_jobs(name, ordinal) AS (
  SELECT name, ordinal::integer
  FROM unnest($1::text[]) WITH ORDINALITY AS approved(name, ordinal)
),
queue_metrics AS (
  SELECT
    'queue'::text AS metric_group,
    approved.name AS dimension_a,
    NULL::text AS dimension_b,
    NULL::integer AS bucket_le_ms,
    LEAST(COUNT(job.id) FILTER (
      WHERE job.state IN ('created', 'retry')
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    LEAST(COUNT(job.id) FILTER (
      WHERE job.state = 'failed'
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_b,
    LEAST(COUNT(job.id) FILTER (
      WHERE job.state IN ('created', 'retry')
        AND job.start_after <= $2
        AND NOT job.blocked
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_c,
    1::integer AS group_order,
    approved.ordinal AS metric_order
  FROM approved_jobs approved
  LEFT JOIN pgboss.job job ON job.name = approved.name
  GROUP BY approved.name, approved.ordinal
),
provider_outcome_dimensions(purpose, outcome, ordinal) AS (
  VALUES
    ('learning_material'::text, 'generated'::text, 1),
    ('learning_material'::text, 'repaired'::text, 2),
    ('learning_material'::text, 'fallback'::text, 3),
    ('practice_feedback'::text, 'generated'::text, 4),
    ('practice_feedback'::text, 'repaired'::text, 5),
    ('practice_feedback'::text, 'fallback'::text, 6),
    ('proof_questions'::text, 'generated'::text, 7),
    ('proof_questions'::text, 'repaired'::text, 8),
    ('proof_questions'::text, 'fallback'::text, 9)
),
provider_outcome_metrics AS (
  SELECT
    'provider_outcome'::text AS metric_group,
    dimension.purpose AS dimension_a,
    dimension.outcome AS dimension_b,
    NULL::integer AS bucket_le_ms,
    LEAST(COUNT(invocation.call_id), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    NULL::integer AS value_b,
    NULL::integer AS value_c,
    2::integer AS group_order,
    dimension.ordinal AS metric_order
  FROM provider_outcome_dimensions dimension
  LEFT JOIN public.semantic_provider_invocations invocation
    ON invocation.purpose = dimension.purpose
   AND invocation.outcome = dimension.outcome
   AND invocation.completed_at >= $3
   AND invocation.completed_at <= $2
  GROUP BY dimension.purpose, dimension.outcome, dimension.ordinal
),
provider_latency_dimensions(purpose, bucket_le_ms, ordinal) AS (
  VALUES
    ('learning_material'::text, 1000, 1),
    ('learning_material'::text, 5000, 2),
    ('learning_material'::text, 15000, 3),
    ('learning_material'::text, 60000, 4),
    ('learning_material'::text, 300000, 5),
    ('learning_material'::text, 900000, 6),
    ('practice_feedback'::text, 1000, 7),
    ('practice_feedback'::text, 5000, 8),
    ('practice_feedback'::text, 15000, 9),
    ('practice_feedback'::text, 60000, 10),
    ('practice_feedback'::text, 300000, 11),
    ('practice_feedback'::text, 900000, 12),
    ('proof_questions'::text, 1000, 13),
    ('proof_questions'::text, 5000, 14),
    ('proof_questions'::text, 15000, 15),
    ('proof_questions'::text, 60000, 16),
    ('proof_questions'::text, 300000, 17),
    ('proof_questions'::text, 900000, 18)
),
provider_latency_metrics AS (
  SELECT
    'provider_latency'::text AS metric_group,
    dimension.purpose AS dimension_a,
    NULL::text AS dimension_b,
    dimension.bucket_le_ms::integer,
    LEAST(COUNT(invocation.call_id) FILTER (
      WHERE invocation.latency_ms <= dimension.bucket_le_ms
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    NULL::integer AS value_b,
    NULL::integer AS value_c,
    3::integer AS group_order,
    dimension.ordinal AS metric_order
  FROM provider_latency_dimensions dimension
  LEFT JOIN public.semantic_provider_invocations invocation
    ON invocation.purpose = dimension.purpose
   AND invocation.completed_at >= $3
   AND invocation.completed_at <= $2
  GROUP BY dimension.purpose, dimension.bucket_le_ms, dimension.ordinal
),
private_provider_dimensions(stage, outcome, ordinal) AS (
  VALUES
    ('speech_to_text'::text, 'artifact_persisted'::text, 1),
    ('multimodal_judge'::text, 'artifact_persisted'::text, 2)
),
private_provider_events AS (
  SELECT
    'speech_to_text'::text AS stage,
    transcript.created_at AS persisted_at
  FROM public.transcripts transcript
  WHERE transcript.provider = 'openrouter'
  UNION ALL
  SELECT
    'multimodal_judge'::text AS stage,
    sidecar.created_at AS persisted_at
  FROM public.multimodal_evaluation_sidecars_v1 sidecar
  WHERE sidecar.provider = 'hetzner-inference'
),
private_provider_outcome_metrics AS (
  SELECT
    'private_provider_outcome'::text AS metric_group,
    dimension.stage AS dimension_a,
    dimension.outcome AS dimension_b,
    NULL::integer AS bucket_le_ms,
    LEAST(COUNT(event.stage), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    NULL::integer AS value_b,
    NULL::integer AS value_c,
    4::integer AS group_order,
    dimension.ordinal AS metric_order
  FROM private_provider_dimensions dimension
  LEFT JOIN private_provider_events event
    ON event.stage = dimension.stage
   AND event.persisted_at >= $3
   AND event.persisted_at <= $2
  GROUP BY dimension.stage, dimension.outcome, dimension.ordinal
),
retention_metrics AS (
  SELECT
    'retention'::text AS metric_group,
    NULL::text AS dimension_a,
    NULL::text AS dimension_b,
    NULL::integer AS bucket_le_ms,
    LEAST(COUNT(*) FILTER (
      WHERE state IN ('pending', 'running') AND deadline <= $2
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    LEAST(COUNT(*) FILTER (
      WHERE state = 'failed'
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_b,
    LEAST(COUNT(*) FILTER (
      WHERE state = 'completed'
        AND completed_at >= $3
        AND completed_at <= $2
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_c,
    5::integer AS group_order,
    1::integer AS metric_order
  FROM public.deletion_jobs
),
check_reconciliation_metrics AS (
  SELECT
    'github_check_reconciliation'::text AS metric_group,
    NULL::text AS dimension_a,
    NULL::text AS dimension_b,
    NULL::integer AS bucket_le_ms,
    LEAST(COUNT(*) FILTER (
      WHERE sync_status = 'pending'
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_a,
    LEAST(COUNT(*) FILTER (
      WHERE sync_status = 'retry_required'
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_b,
    LEAST(COUNT(*) FILTER (
      WHERE sync_status = 'permanent_failure'
    ), ${String(MAX_METRIC_COUNT)}::bigint)::integer AS value_c,
    6::integer AS group_order,
    1::integer AS metric_order
  FROM public.check_runs
),
all_metrics AS (
  SELECT * FROM queue_metrics
  UNION ALL SELECT * FROM provider_outcome_metrics
  UNION ALL SELECT * FROM provider_latency_metrics
  UNION ALL SELECT * FROM private_provider_outcome_metrics
  UNION ALL SELECT * FROM retention_metrics
  UNION ALL SELECT * FROM check_reconciliation_metrics
)
SELECT
  metric_group,
  dimension_a,
  dimension_b,
  bucket_le_ms,
  value_a,
  value_b,
  value_c
FROM all_metrics
ORDER BY group_order, metric_order
`;

export async function collectOperationalMetricsSnapshot(
  dependencies: Omit<OperationalMetricsDependencies, "bearerSecret">,
): Promise<OperationalMetricsSnapshotV1> {
  const timeoutMs = parseTimeout(dependencies.timeoutMs);
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + timeoutMs;
  const generatedAt = dependencies.now?.() ?? new Date();
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error("Operational metrics clock returned an invalid date");
  }
  const windowStart = new Date(
    generatedAt.getTime() - OPERATIONAL_WINDOW_SECONDS * 1_000,
  );

  const client = await acquireClientBeforeDeadline(
    dependencies.database,
    deadline,
    monotonicNow,
  );
  let releaseAsBroken = true;
  try {
    await queryBeforeDeadline(
      client,
      "BEGIN READ ONLY",
      deadline,
      monotonicNow,
    );
    const statementTimeout = `${String(remainingMilliseconds(deadline, monotonicNow))}ms`;
    await queryBeforeDeadline(
      client,
      {
        text: `SELECT
          set_config('statement_timeout', $1, true),
          set_config('lock_timeout', $1, true)`,
        values: [statementTimeout],
      },
      deadline,
      monotonicNow,
    );
    const result = await queryBeforeDeadline<OperationalMetricRow>(
      client,
      {
        text: OPERATIONAL_METRICS_SQL,
        values: [JOB_NAMES, generatedAt, windowStart],
      },
      deadline,
      monotonicNow,
    );
    await queryBeforeDeadline(client, "COMMIT", deadline, monotonicNow);
    releaseAsBroken = false;
    return buildSnapshot(result.rows, generatedAt);
  } finally {
    client.release(releaseAsBroken);
  }
}

export async function handleOperationalMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: OperationalMetricsDependencies,
): Promise<boolean> {
  if (request.url !== OPERATIONAL_METRICS_PATH) return false;

  if (
    !authenticateBearer(
      request.headers.authorization,
      dependencies.bearerSecret,
    )
  ) {
    jsonResponse(response, 401, { error: "unauthorized" }, true);
    return true;
  }
  if (request.method !== "GET") {
    jsonResponse(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (hasRequestBody(request)) {
    jsonResponse(response, 400, { error: "invalid_request" });
    return true;
  }

  try {
    const snapshot = await collectOperationalMetricsSnapshot(dependencies);
    jsonResponse(response, 200, snapshot);
  } catch {
    jsonResponse(response, 503, { error: "metrics_unavailable" });
  }
  return true;
}

function buildSnapshot(
  rawRows: readonly unknown[],
  generatedAt: Date,
): OperationalMetricsSnapshotV1 {
  const rows = rawRows.map((row) => OperationalMetricRowSchema.parse(row));
  const queue = rows
    .filter(
      (row): row is z.infer<typeof QueueRowSchema> =>
        row.metric_group === "queue",
    )
    .map((row) => ({
      name: row.dimension_a,
      depth: row.value_a,
      failed: row.value_b,
      due: row.value_c,
    }));
  const outcomes = rows
    .filter(
      (row): row is z.infer<typeof ProviderOutcomeRowSchema> =>
        row.metric_group === "provider_outcome",
    )
    .map((row) => ({
      purpose: row.dimension_a,
      outcome: row.dimension_b,
      count: row.value_a,
    }));
  const latencyBuckets = rows
    .filter(
      (row): row is z.infer<typeof ProviderLatencyRowSchema> =>
        row.metric_group === "provider_latency",
    )
    .map((row) => ({
      purpose: row.dimension_a,
      leMs: row.bucket_le_ms,
      count: row.value_a,
    }));
  const privateOutcomes = rows
    .filter(
      (row): row is z.infer<typeof PrivateProviderOutcomeRowSchema> =>
        row.metric_group === "private_provider_outcome",
    )
    .map((row) => ({
      stage: row.dimension_a,
      outcome: row.dimension_b,
      count: row.value_a,
    }));
  const retentionRows = rows.filter(
    (row): row is z.infer<typeof RetentionRowSchema> =>
      row.metric_group === "retention",
  );
  const checkRows = rows.filter(
    (row): row is z.infer<typeof CheckReconciliationRowSchema> =>
      row.metric_group === "github_check_reconciliation",
  );
  if (retentionRows.length !== 1 || checkRows.length !== 1) {
    throw new Error("Operational metrics aggregate cardinality is invalid");
  }
  const retention = retentionRows[0];
  const checks = checkRows[0];
  if (!retention || !checks) {
    throw new Error("Operational metrics aggregates are unavailable");
  }
  assertExactDimensions(queue, outcomes, latencyBuckets, privateOutcomes);

  return OperationalMetricsSnapshotV1Schema.parse({
    schemaVersion: "1",
    generatedAt: generatedAt.toISOString(),
    windowSeconds: OPERATIONAL_WINDOW_SECONDS,
    queue,
    providers: { outcomes, latencyBuckets, privateOutcomes },
    retention: {
      due: retention.value_a,
      failed: retention.value_b,
      shredded: retention.value_c,
    },
    githubCheckReconciliation: {
      pending: checks.value_a,
      retry: checks.value_b,
      terminal: checks.value_c,
    },
  });
}

function assertExactDimensions(
  queue: readonly z.infer<typeof QueueMetricSchema>[],
  outcomes: readonly z.infer<typeof ProviderOutcomeMetricSchema>[],
  latencyBuckets: readonly z.infer<typeof ProviderLatencyMetricSchema>[],
  privateOutcomes: readonly z.infer<
    typeof PrivateProviderOutcomeMetricSchema
  >[],
): void {
  const queueNames = new Set(queue.map((metric) => metric.name));
  if (
    queueNames.size !== JOB_NAMES.length ||
    JOB_NAMES.some((name) => !queueNames.has(name))
  ) {
    throw new Error("Operational queue metrics dimensions are incomplete");
  }

  const outcomeDimensions = new Set(
    outcomes.map((metric) => `${metric.purpose}:${metric.outcome}`),
  );
  const expectedOutcomes = ProviderPurposeSchema.options.flatMap((purpose) =>
    ProviderOutcomeSchema.options.map((outcome) => `${purpose}:${outcome}`),
  );
  if (
    outcomeDimensions.size !== expectedOutcomes.length ||
    expectedOutcomes.some((dimension) => !outcomeDimensions.has(dimension))
  ) {
    throw new Error("Operational provider outcome dimensions are incomplete");
  }

  const latencyDimensions = new Set(
    latencyBuckets.map((metric) => `${metric.purpose}:${String(metric.leMs)}`),
  );
  const expectedLatency = ProviderPurposeSchema.options.flatMap((purpose) =>
    LatencyBucketSchema.options.map(
      (bucket) => `${purpose}:${String(bucket.value)}`,
    ),
  );
  if (
    latencyDimensions.size !== expectedLatency.length ||
    expectedLatency.some((dimension) => !latencyDimensions.has(dimension))
  ) {
    throw new Error("Operational provider latency dimensions are incomplete");
  }

  const privateOutcomeDimensions = new Set(
    privateOutcomes.map((metric) => `${metric.stage}:${metric.outcome}`),
  );
  const expectedPrivateOutcomes = PrivateProviderStageSchema.options.map(
    (stage) => `${stage}:${PrivateProviderOutcomeSchema.value}`,
  );
  if (
    privateOutcomeDimensions.size !== expectedPrivateOutcomes.length ||
    expectedPrivateOutcomes.some(
      (dimension) => !privateOutcomeDimensions.has(dimension),
    )
  ) {
    throw new Error(
      "Operational private provider outcome dimensions are incomplete",
    );
  }
}

function parseTimeout(timeoutMs: number | undefined): number {
  const parsed = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 10 || parsed > MAX_TIMEOUT_MS) {
    throw new Error("Operational metrics timeout is invalid");
  }
  return parsed;
}

async function acquireClientBeforeDeadline(
  database: DatabaseConnection,
  deadline: number,
  monotonicNow: () => number,
): Promise<DatabaseClient> {
  const pending = database.pool.connect();
  const remaining = remainingMilliseconds(deadline, monotonicNow);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Operational metrics database acquisition timed out"),
            ),
          remaining,
        );
      }),
    ]);
  } catch (error) {
    void pending
      .then((lateClient) => lateClient.release(true))
      .catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type QueryInput = string | { text: string; values?: readonly unknown[] };
type DatabaseClient = PoolClient;

async function queryBeforeDeadline<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  client: DatabaseClient,
  input: QueryInput,
  deadline: number,
  monotonicNow: () => number,
) {
  const queryTimeout = remainingMilliseconds(deadline, monotonicNow);
  const config =
    typeof input === "string"
      ? { text: input, query_timeout: queryTimeout }
      : { ...input, query_timeout: queryTimeout };
  const result = await client.query<Row>(config);
  remainingMilliseconds(deadline, monotonicNow);
  return result;
}

function remainingMilliseconds(
  deadline: number,
  monotonicNow: () => number,
): number {
  const remaining = Math.floor(deadline - monotonicNow());
  if (remaining < 1) {
    throw new Error("Operational metrics collection timed out");
  }
  return remaining;
}

function authenticateBearer(
  authorization: string | undefined,
  secret: string,
): boolean {
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    authorization.length > 4_096 ||
    secret.length < 32 ||
    secret.length > 4_096
  ) {
    return false;
  }
  const candidate = authorization.slice("Bearer ".length);
  if (candidate.length === 0) return false;
  const expectedDigest = createHmac("sha256", secret)
    .update("slopproof:operational-metrics-bearer:v1:", "utf8")
    .update(secret, "utf8")
    .digest();
  const candidateDigest = createHmac("sha256", secret)
    .update("slopproof:operational-metrics-bearer:v1:", "utf8")
    .update(candidate, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];
  return (
    transferEncoding !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown,
  authenticate = false,
): void {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Operational metrics response exceeded its fixed bound");
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...(authenticate ? { "www-authenticate": "Bearer" } : {}),
  });
  response.end(body);
}
