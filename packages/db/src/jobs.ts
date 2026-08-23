import {
  GitShaSchema,
  IdempotencyKeySchema,
  UuidSchema,
} from "@slopproof/domain";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import {
  PgBoss,
  fromDrizzle,
  type ConstructorOptions,
  type Db,
  type DrizzleTransactionLike,
  type Job,
  type Queue,
  type SendOptions,
  type WorkOptions,
} from "pg-boss";
import { z } from "zod";

export const JOB_NAMES = [
  "github.ingest-pr",
  "github.reconcile-check",
  "analysis.prepare-revision",
  "semantic.generate-learning",
  "semantic.generate-practice-feedback",
  "semantic.generate-proof-questions",
  "semantic.expire-private",
  "proof.expire-attempt",
  "media.finalize-upload",
  "media.extract-transcript",
  "media.select-frames",
  "evaluation.run",
  "evaluation.apply-policy",
  "evidence.delete",
  "evidence.audit-retention",
] as const;

export const JobNameSchema = z.enum(JOB_NAMES);

export type JobName = z.infer<typeof JobNameSchema>;

const JOB_ENVELOPE = {
  schemaVersion: z.literal("1"),
  idempotencyKey: IdempotencyKeySchema,
} as const;

const GitHubNumericIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "Expected a positive GitHub numeric ID")
  .max(32);
const GitHubOwnerSchema = z.string().trim().min(1).max(100);
const GitHubRepositoryNameSchema = z.string().trim().min(1).max(100);
const GitHubBranchSchema = z.string().trim().min(1).max(255);

export const GithubWebhookIngestPrJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    deliveryId: UuidSchema,
    eventName: z.literal("pull_request"),
    action: z.enum([
      "opened",
      "reopened",
      "ready_for_review",
      "synchronize",
      "closed",
    ]),
    installation: z
      .object({
        githubInstallationId: GitHubNumericIdSchema,
        accountId: GitHubNumericIdSchema,
        accountLogin: GitHubOwnerSchema,
      })
      .strict(),
    repository: z
      .object({
        githubRepositoryId: GitHubNumericIdSchema,
        owner: GitHubOwnerSchema,
        name: GitHubRepositoryNameSchema,
        defaultBranch: GitHubBranchSchema,
      })
      .strict(),
    pullRequest: z
      .object({
        githubPullRequestId: GitHubNumericIdSchema,
        number: z.number().int().positive(),
        authorId: GitHubNumericIdSchema,
        state: z.enum(["open", "closed"]),
        headSha: GitShaSchema,
        baseSha: GitShaSchema,
      })
      .strict(),
  })
  .strict();

export const GithubRefreshPrJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    eventName: z.literal("pull_request_refresh"),
    installationId: GitHubNumericIdSchema,
    repositoryId: GitHubNumericIdSchema,
    owner: GitHubOwnerSchema,
    repositoryName: GitHubRepositoryNameSchema,
    pullNumber: z.number().int().positive().max(2_147_483_647),
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const GithubIngestPrJobSchema = z.union([
  GithubWebhookIngestPrJobSchema,
  GithubRefreshPrJobSchema,
]);

export const GithubReconcileCheckJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    revisionId: UuidSchema,
    expectedHeadSha: GitShaSchema,
    reason: z.enum([
      "webhook_ingested",
      "analysis_ready",
      "preparation_failed",
      "proof_started",
      "review_required",
      "maintainer_decision",
      "revision_invalidated",
      "manual_reconcile",
      "technical_retry",
      "attempt_expired",
      "contributor_retry",
    ]),
  })
  .strict();

export const AnalysisPrepareRevisionJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    revisionId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const ProofExpireAttemptJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

const SemanticGenerationJobBaseSchema = z
  .object({
    ...JOB_ENVELOPE,
    revisionId: UuidSchema,
    generationContextId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const SemanticGenerateLearningJobSchema =
  SemanticGenerationJobBaseSchema.extend({
    artifactKind: z.literal("learning_bundle_v1"),
  }).strict();

export const SemanticGeneratePracticeFeedbackJobSchema =
  SemanticGenerationJobBaseSchema.extend({
    artifactKind: z.literal("practice_feedback_v1"),
    practiceSessionId: UuidSchema,
    practiceQuestionId: UuidSchema,
    practiceAnswerId: UuidSchema,
  }).strict();

export const SemanticGenerateProofQuestionsJobSchema =
  SemanticGenerationJobBaseSchema.extend({
    artifactKind: z.literal("proof_question_plan_v2"),
  }).strict();

export const SemanticExpirePrivateJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    revisionId: UuidSchema,
    artifactId: UuidSchema,
    artifactKind: z.enum([
      "learning_bundle_v1",
      "practice_answer_v1",
      "practice_feedback_v1",
    ]),
  })
  .strict();

export const MediaFinalizeUploadJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    uploadSessionId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const MediaExtractTranscriptJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    recordingObjectId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const MediaSelectFramesJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    recordingObjectId: UuidSchema,
    transcriptId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const EvaluationRunJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    transcriptId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const EvaluationApplyPolicyJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    attemptId: UuidSchema,
    evaluationId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export const EvidenceDeleteJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    deletionJobId: UuidSchema,
  })
  .strict();

export const EvidenceAuditRetentionJobSchema = z
  .object({
    ...JOB_ENVELOPE,
    auditRunId: UuidSchema,
  })
  .strict();

export const JobPayloadSchemas = {
  "github.ingest-pr": GithubIngestPrJobSchema,
  "github.reconcile-check": GithubReconcileCheckJobSchema,
  "analysis.prepare-revision": AnalysisPrepareRevisionJobSchema,
  "semantic.generate-learning": SemanticGenerateLearningJobSchema,
  "semantic.generate-practice-feedback":
    SemanticGeneratePracticeFeedbackJobSchema,
  "semantic.generate-proof-questions": SemanticGenerateProofQuestionsJobSchema,
  "semantic.expire-private": SemanticExpirePrivateJobSchema,
  "proof.expire-attempt": ProofExpireAttemptJobSchema,
  "media.finalize-upload": MediaFinalizeUploadJobSchema,
  "media.extract-transcript": MediaExtractTranscriptJobSchema,
  "media.select-frames": MediaSelectFramesJobSchema,
  "evaluation.run": EvaluationRunJobSchema,
  "evaluation.apply-policy": EvaluationApplyPolicyJobSchema,
  "evidence.delete": EvidenceDeleteJobSchema,
  "evidence.audit-retention": EvidenceAuditRetentionJobSchema,
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayloadByName = {
  [Name in JobName]: z.infer<(typeof JobPayloadSchemas)[Name]>;
};

export type JobPayload<Name extends JobName> = JobPayloadByName[Name];

export function parseJobPayload<Name extends JobName>(
  name: Name,
  payload: unknown,
): JobPayload<Name> {
  return JobPayloadSchemas[name].parse(payload) as JobPayload<Name>;
}

/**
 * Serializes jobs that can mutate the same business aggregate. The key is not
 * the idempotency key: repeated deliveries remain visible and handlers still
 * have to enforce idempotency against the SlopProof tables.
 */
export function getJobSingletonKey<Name extends JobName>(
  name: Name,
  payload: JobPayload<Name>,
): string {
  switch (name) {
    case "github.ingest-pr": {
      const ingest = payload as JobPayload<"github.ingest-pr">;
      return ingest.eventName === "pull_request"
        ? `${ingest.repository.githubRepositoryId}:${ingest.pullRequest.number}`
        : `${ingest.repositoryId}:${ingest.pullNumber}`;
    }
    case "github.reconcile-check":
    case "analysis.prepare-revision":
      return (payload as JobPayload<"github.reconcile-check">).revisionId;
    case "semantic.generate-learning":
      return `${(payload as JobPayload<"semantic.generate-learning">).generationContextId}:learning`;
    case "semantic.generate-practice-feedback":
      return (payload as JobPayload<"semantic.generate-practice-feedback">)
        .practiceAnswerId;
    case "semantic.generate-proof-questions":
      return `${(payload as JobPayload<"semantic.generate-proof-questions">).generationContextId}:proof-v2`;
    case "semantic.expire-private": {
      const expiry = payload as JobPayload<"semantic.expire-private">;
      return `${expiry.artifactKind}:${expiry.artifactId}`;
    }
    case "proof.expire-attempt":
    case "media.finalize-upload":
    case "media.extract-transcript":
    case "media.select-frames":
    case "evaluation.run":
    case "evaluation.apply-policy":
      return (payload as JobPayload<"proof.expire-attempt">).attemptId;
    case "evidence.delete":
      return (payload as JobPayload<"evidence.delete">).deletionJobId;
    case "evidence.audit-retention":
      return (payload as JobPayload<"evidence.audit-retention">).auditRunId;
  }
}

const COMMON_QUEUE_OPTIONS = {
  policy: "key_strict_fifo",
  notify: true,
  retryLimit: 5,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 5 * 60,
  retentionSeconds: 7 * 24 * 60 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
  warningQueueSize: 1_000,
} as const satisfies Omit<Queue, "name">;

export const JOB_QUEUE_DEFINITIONS = {
  "github.ingest-pr": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 5 * 60,
    heartbeatSeconds: 30,
  },
  "github.reconcile-check": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 5 * 60,
    heartbeatSeconds: 30,
  },
  "analysis.prepare-revision": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 5 * 60,
  },
  "semantic.generate-learning": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 10 * 60,
    heartbeatSeconds: 30,
  },
  "semantic.generate-practice-feedback": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 10 * 60,
    heartbeatSeconds: 30,
  },
  "semantic.generate-proof-questions": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 10 * 60,
    heartbeatSeconds: 30,
  },
  "semantic.expire-private": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 2 * 60,
    retryLimit: 10,
  },
  "proof.expire-attempt": { ...COMMON_QUEUE_OPTIONS, expireInSeconds: 60 },
  "media.finalize-upload": { ...COMMON_QUEUE_OPTIONS, expireInSeconds: 5 * 60 },
  "media.extract-transcript": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: 60,
  },
  "media.select-frames": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 10 * 60,
    heartbeatSeconds: 60,
  },
  "evaluation.run": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: 60,
  },
  "evaluation.apply-policy": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 2 * 60,
  },
  "evidence.delete": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 5 * 60,
    retryLimit: 10,
  },
  "evidence.audit-retention": {
    ...COMMON_QUEUE_OPTIONS,
    expireInSeconds: 5 * 60,
  },
} as const satisfies Record<JobName, Omit<Queue, "name">>;

export function createJobQueue(
  connection: string | ConstructorOptions,
): PgBoss {
  return typeof connection === "string"
    ? new PgBoss(connection)
    : new PgBoss(connection);
}

export async function registerJobQueues(queue: PgBoss): Promise<void> {
  for (const name of JOB_NAMES) {
    await queue.createQueue(name, JOB_QUEUE_DEFINITIONS[name]);
  }
}

export async function startJobQueue(
  connection: string | ConstructorOptions,
  onError: (error: unknown) => void = () => undefined,
): Promise<PgBoss> {
  const queue = createJobQueue(connection);
  // pg-boss is an EventEmitter; without a listener Node treats an emitted
  // error as uncaught and may print the full upstream error object to stderr.
  queue.on("error", onError);
  try {
    await queue.start();
    await registerJobQueues(queue);
    return queue;
  } catch (error) {
    // A partially started pg-boss instance owns timers and database clients.
    // Release them before surfacing startup failure so callers can retry or
    // terminate without leaving a deceptively live process behind.
    await queue
      .stop({ graceful: false, timeout: 1_000 })
      .catch(() => undefined);
    throw error;
  }
}

export type EnqueueJobOptions = Omit<SendOptions, "db" | "singletonKey">;

export async function enqueueJob<Name extends JobName>(
  queue: PgBoss,
  name: Name,
  rawPayload: unknown,
  options: EnqueueJobOptions = {},
): Promise<string> {
  const payload = parseJobPayload(name, rawPayload);
  const jobId = await queue.send(name, payload, {
    ...options,
    singletonKey: getJobSingletonKey(name, payload),
  });

  if (jobId === null) {
    throw new Error(
      `Queue rejected ${name} because its singleton slot is unavailable`,
    );
  }

  return jobId;
}

/**
 * Upserts one immediately runnable aggregate job without growing a backlog.
 * A terminal failed strict-FIFO singleton is retried in place so it cannot
 * permanently block later work for the same aggregate.
 */
export async function expediteJob<Name extends JobName>(
  queue: PgBoss,
  name: Name,
  rawPayload: unknown,
): Promise<string | null> {
  const payload = parseJobPayload(name, rawPayload);
  const singletonKey = getJobSingletonKey(name, payload);
  const existing = await queue.findJobs<unknown>(name, {
    key: singletonKey,
  });
  const failed = existing.filter((job) => job.state === "failed");
  if (failed.length > 1) {
    throw new Error(`Queue has multiple failed ${name} singleton jobs`);
  }
  if (failed[0]) {
    await queue.retry(name, failed[0].id);
    const updated = await queue.update(name, payload, {
      id: failed[0].id,
      startAfter: new Date(),
    });
    if (updated.updated !== 1) {
      throw new Error(`Queue could not recover failed ${name} singleton job`);
    }
    return failed[0].id;
  }
  const result = await queue.upsert(name, payload, {
    singletonKey,
    match: "oldest",
    startAfter: new Date(),
  });
  return result.jobs[0] ?? null;
}

export async function enqueueJobInTransaction<Name extends JobName>(
  queue: PgBoss,
  transaction: DrizzleTransactionLike,
  name: Name,
  rawPayload: unknown,
  options: EnqueueJobOptions = {},
): Promise<string> {
  const payload = parseJobPayload(name, rawPayload);
  const jobId = await queue.send(name, payload, {
    ...options,
    singletonKey: getJobSingletonKey(name, payload),
    db: fromDrizzle(transaction, sql),
  });

  if (jobId === null) {
    throw new Error(
      `Queue rejected ${name} because its singleton slot is unavailable`,
    );
  }

  return jobId;
}

/** Transactional Drizzle variant of `expediteJob`. */
export async function expediteJobInTransaction<Name extends JobName>(
  queue: PgBoss,
  transaction: DrizzleTransactionLike,
  name: Name,
  rawPayload: unknown,
): Promise<string | null> {
  const payload = parseJobPayload(name, rawPayload);
  const singletonKey = getJobSingletonKey(name, payload);
  const db = fromDrizzle(transaction, sql);
  const existing = await queue.findJobs<unknown>(name, {
    key: singletonKey,
    db,
  });
  const failed = existing.filter((job) => job.state === "failed");
  if (failed.length > 1) {
    throw new Error(`Queue has multiple failed ${name} singleton jobs`);
  }
  if (failed[0]) {
    await queue.retry(name, failed[0].id, { db });
    const updated = await queue.update(name, payload, {
      id: failed[0].id,
      startAfter: new Date(),
      db,
    });
    if (updated.updated !== 1) {
      throw new Error(`Queue could not recover failed ${name} singleton job`);
    }
    return failed[0].id;
  }
  const result = await queue.upsert(name, payload, {
    singletonKey,
    match: "oldest",
    startAfter: new Date(),
    db,
  });
  return result.jobs[0] ?? null;
}

/**
 * Publishes through the caller's PostgreSQL transaction. A `null` result is a
 * successful singleton replay: the durable business mutation may still
 * commit because an equivalent aggregate job is already pending or active.
 */
export async function enqueueJobInPgTransaction<Name extends JobName>(
  queue: PgBoss,
  client: PoolClient,
  name: Name,
  rawPayload: unknown,
  options: EnqueueJobOptions = {},
): Promise<string | null> {
  const payload = parseJobPayload(name, rawPayload);
  const db: Db = {
    async executeSql(text, values = []) {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
  return queue.send(name, payload, {
    ...options,
    singletonKey: getJobSingletonKey(name, payload),
    db,
  });
}

/** Moves the oldest pending aggregate job to the front, or inserts it if none exists. */
export async function expediteJobInPgTransaction<Name extends JobName>(
  queue: PgBoss,
  client: PoolClient,
  name: Name,
  rawPayload: unknown,
): Promise<string | null> {
  const payload = parseJobPayload(name, rawPayload);
  const db: Db = {
    async executeSql(text, values = []) {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
  const singletonKey = getJobSingletonKey(name, payload);
  const existing = await queue.findJobs<unknown>(name, {
    key: singletonKey,
    db,
  });
  const failed = existing.filter((job) => job.state === "failed");
  if (failed.length > 1) {
    throw new Error(`Queue has multiple failed ${name} singleton jobs`);
  }
  if (failed[0]) {
    await queue.retry(name, failed[0].id, { db });
    const updated = await queue.update(name, payload, {
      id: failed[0].id,
      startAfter: new Date(),
      db,
    });
    if (updated.updated !== 1) {
      throw new Error(`Queue could not recover failed ${name} singleton job`);
    }
    return failed[0].id;
  }
  const result = await queue.upsert(name, payload, {
    singletonKey,
    match: "oldest",
    startAfter: new Date(),
    db,
  });
  return result.jobs[0] ?? null;
}

/** Upserts one deferred aggregate job without growing a duplicate backlog. */
export async function scheduleJobInPgTransaction<Name extends JobName>(
  queue: PgBoss,
  client: PoolClient,
  name: Name,
  rawPayload: unknown,
  startAfter: Date,
): Promise<string | null> {
  const payload = parseJobPayload(name, rawPayload);
  const db: Db = {
    async executeSql(text, values = []) {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
  const result = await queue.upsert(name, payload, {
    singletonKey: getJobSingletonKey(name, payload),
    match: "oldest",
    startAfter,
    db,
  });
  return result.jobs[0] ?? null;
}

export type ValidatedJob<Name extends JobName> = Omit<
  Job<JobPayload<Name>>,
  "data"
> & {
  data: JobPayload<Name>;
};

export type JobHandler<Name extends JobName, Result = void> = (
  job: ValidatedJob<Name>,
) => Promise<Result>;

export type RegisterJobWorkerOptions = Omit<
  WorkOptions,
  "batchSize" | "includeMetadata" | "perJobResults"
>;

/** Registers a one-at-a-time worker and validates persisted queue data before use. */
export async function registerJobWorker<Name extends JobName, Result = void>(
  queue: PgBoss,
  name: Name,
  handler: JobHandler<Name, Result>,
  options: RegisterJobWorkerOptions = {},
): Promise<string> {
  return queue.work<unknown, Result>(
    name,
    { ...options, batchSize: 1 },
    async (jobs) => {
      const job = jobs[0];
      if (job === undefined) {
        throw new Error(`Queue returned an empty batch for ${name}`);
      }

      const validatedJob = {
        ...job,
        data: parseJobPayload(name, job.data),
      } satisfies ValidatedJob<Name>;

      return handler(validatedJob);
    },
  );
}
