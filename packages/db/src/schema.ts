import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const attemptStatusEnum = pgEnum("attempt_status", [
  "preparing",
  "ready",
  "active",
  "uploading",
  "processing",
  "review_required",
  "passed",
  "retry_required",
  "technical_retry",
  "expired",
  "invalidated",
]);

export const checkStatusEnum = pgEnum("check_status", [
  "queued",
  "in_progress",
  "completed",
]);
export const checkConclusionEnum = pgEnum("check_conclusion", [
  "action_required",
  "success",
  "neutral",
  "cancelled",
]);
export const reviewDecisionEnum = pgEnum("review_decision", ["pass", "retry"]);
export const jobStateEnum = pgEnum("deletion_job_state", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const githubLifecycleStatusEnum = pgEnum("github_lifecycle_status", [
  "active",
  "suspended",
  "removed",
]);
export const githubOauthPurposeEnum = pgEnum("github_oauth_purpose", [
  "contributor_login",
  "maintainer_reauth",
]);
export const githubCheckIntentReasonEnum = pgEnum(
  "github_check_intent_reason",
  [
    "webhook_ingested",
    "analysis_ready",
    "proof_started",
    "review_required",
    "maintainer_decision",
    "revision_invalidated",
    "manual_reconcile",
    "technical_retry",
    "attempt_expired",
    "contributor_retry",
  ],
);
export const githubCheckSyncStatusEnum = pgEnum("github_check_sync_status", [
  "pending",
  "syncing",
  "synchronized",
  "retry_required",
  "permanent_failure",
]);

export const installations = pgTable("installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  githubInstallationId: text("github_installation_id").notNull().unique(),
  accountId: text("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  status: githubLifecycleStatusEnum("status").notNull().default("active"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  ...timestamps,
});

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "restrict" }),
    githubRepositoryId: text("github_repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch"),
    activePolicyVersion: integer("active_policy_version").notNull().default(1),
    status: githubLifecycleStatusEnum("status").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("repositories_github_id_uq").on(table.githubRepositoryId),
    uniqueIndex("repositories_owner_name_uq").on(table.owner, table.name),
  ],
);

export const githubOauthFlows = pgTable(
  "github_oauth_flows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stateHash: text("state_hash").notNull(),
    purpose: githubOauthPurposeEnum("purpose").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    redirectPath: text("redirect_path").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("github_oauth_flows_state_hash_uq").on(table.stateHash),
    index("github_oauth_flows_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    index("github_oauth_flows_cleanup_idx").on(table.expiresAt, table.id),
    index("github_oauth_flows_created_idx").on(table.createdAt),
    index("github_oauth_flows_repository_active_idx")
      .on(table.repositoryId, table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    index("github_oauth_flows_repository_created_idx").on(
      table.repositoryId,
      table.createdAt,
    ),
    check(
      "github_oauth_flows_state_hash_format",
      sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_oauth_flows_redirect_allowlist",
      sql`${table.redirectPath} ~ '^/(review(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?|revisions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(/contribute(/practice)?)?)$'`,
    ),
    check(
      "github_oauth_flows_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "github_oauth_flows_consumption_window",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} < ${table.expiresAt})`,
    ),
  ],
);

export const oauthStartRateLimits = pgTable(
  "oauth_start_rate_limits",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    clientKeyHash: text("client_key_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("oauth_start_rate_limits_client_window_idx").on(
      table.clientKeyHash,
      table.occurredAt,
    ),
    index("oauth_start_rate_limits_cleanup_idx").on(table.expiresAt, table.id),
    check(
      "oauth_start_rate_limits_client_key_hash_format",
      sql`${table.clientKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "oauth_start_rate_limits_expiry_after_occurrence",
      sql`${table.expiresAt} > ${table.occurredAt}`,
    ),
  ],
);

export const repositoryPolicies = pgTable(
  "repository_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    policyHash: text("policy_hash").notNull(),
    createdBy: text("created_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("repository_policies_version_uq").on(
      table.repositoryId,
      table.version,
    ),
    uniqueIndex("repository_policies_hash_uq").on(
      table.repositoryId,
      table.policyHash,
    ),
    check("repository_policies_version_positive", sql`${table.version} > 0`),
  ],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    githubPullRequestId: text("github_pull_request_id").notNull(),
    number: integer("number").notNull(),
    authorId: text("author_id").notNull(),
    state: text("state").notNull(),
    nextGithubRefreshAt: timestamp("next_github_refresh_at", {
      withTimezone: true,
    }),
    githubRecoveryBinding: jsonb("github_recovery_binding"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pull_requests_repo_number_uq").on(
      table.repositoryId,
      table.number,
    ),
    index("pull_requests_github_refresh_due_idx")
      .on(table.nextGithubRefreshAt, table.id)
      .where(
        sql`${table.state} = 'open' AND ${table.nextGithubRefreshAt} IS NOT NULL`,
      ),
    uniqueIndex("pull_requests_github_id_uq").on(table.githubPullRequestId),
    check("pull_requests_number_positive", sql`${table.number} > 0`),
  ],
);

export const githubRecoveryCandidates = pgTable(
  "github_recovery_candidates",
  {
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    githubInstallationId: text("github_installation_id").notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    owner: text("owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.githubInstallationId] }),
    index("github_recovery_candidates_installation_idx").on(
      table.githubInstallationId,
      table.pullRequestId,
    ),
  ],
);

export const pullRequestRevisions = pgTable(
  "pull_request_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("pull_request_revisions_sha_uq").on(
      table.pullRequestId,
      table.headSha,
      table.baseSha,
    ),
    uniqueIndex("pull_request_revisions_one_current_uq")
      .on(table.pullRequestId)
      .where(sql`${table.isCurrent} = true`),
    index("pull_request_revisions_current_idx").on(
      table.pullRequestId,
      table.isCurrent,
    ),
    check(
      "pull_request_revisions_head_sha_format",
      sql`${table.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "pull_request_revisions_base_sha_format",
      sql`${table.baseSha} ~ '^[0-9a-f]{40}$'`,
    ),
  ],
);

export const githubRevisionSources = pgTable(
  "github_revision_sources",
  {
    revisionId: uuid("revision_id")
      .primaryKey()
      .references(() => pullRequestRevisions.id, { onDelete: "restrict" }),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    source: jsonb("source").$type<Record<string, unknown>>().notNull(),
    sourceHash: text("source_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "github_revision_sources_head_sha_format",
      sql`${table.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "github_revision_sources_base_sha_format",
      sql`${table.baseSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "github_revision_sources_hash_format",
      sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_revision_sources_object",
      sql`jsonb_typeof(${table.source}) = 'object'`,
    ),
    check(
      "github_revision_sources_sha_binding",
      sql`${table.source}->>'headSha' = ${table.headSha} AND ${table.source}->>'baseSha' = ${table.baseSha}`,
    ),
    check(
      "github_revision_sources_size_bound",
      sql`octet_length(${table.source}::text) <= 3145728`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    eventName: text("event_name").notNull(),
    payloadHash: text("payload_hash").notNull(),
    processingStatus: text("processing_status").notNull().default("reserved"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    retryAttempts: integer("retry_attempts").default(0).notNull(),
    jobPayload: jsonb("job_payload").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_stale_queue_idx")
      .on(
        sql`COALESCE(${table.nextRetryAt}, ${table.queuedAt})`,
        table.deliveryId,
      )
      .where(
        sql`${table.processingStatus} = 'queued' AND ${table.jobPayload} IS NOT NULL`,
      ),
    check(
      "webhook_deliveries_retry_attempts_nonnegative",
      sql`${table.retryAttempts} >= 0`,
    ),
    check(
      "webhook_deliveries_pr_job_payload_shape",
      sql`${table.jobPayload} IS NULL OR (${table.eventName} = 'pull_request' AND jsonb_typeof(${table.jobPayload}) = 'object' AND octet_length(${table.jobPayload}::text) <= 8192)`,
    ),
    check(
      "webhook_deliveries_retry_schedule_state",
      sql`${table.nextRetryAt} IS NULL OR ${table.processingStatus} = 'queued'`,
    ),
    check(
      "webhook_deliveries_processing_status",
      sql`${table.processingStatus} IN ('reserved', 'queued', 'processed', 'ignored', 'permanent_failure')`,
    ),
  ],
);

export const analysisSnapshots = pgTable(
  "analysis_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pullRequestRevisions.id, { onDelete: "cascade" }),
    analyzerVersion: text("analyzer_version").notNull(),
    diffHash: text("diff_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("analysis_snapshots_version_uq").on(
      table.revisionId,
      table.analyzerVersion,
      table.diffHash,
    ),
  ],
);

export const generationContexts = pgTable(
  "generation_contexts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pullRequestRevisions.id, { onDelete: "restrict" }),
    analysisSnapshotId: uuid("analysis_snapshot_id")
      .notNull()
      .references(() => analysisSnapshots.id, { onDelete: "restrict" }),
    headSha: text("head_sha").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    contextVersion: text("context_version").notNull(),
    contextHash: text("context_hash").notNull(),
    canonicalMaterial: text("canonical_material").notNull(),
    providerMaterial: text("provider_material").notNull(),
    sourceHash: text("source_hash").notNull(),
    allowedAnchorIds: jsonb("allowed_anchor_ids").$type<string[]>().notNull(),
    limits: jsonb("limits").$type<Record<string, unknown>>().notNull(),
    exclusions: jsonb("exclusions").$type<unknown[]>().notNull(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("generation_contexts_snapshot_version_uq").on(
      table.analysisSnapshotId,
      table.contextVersion,
    ),
    uniqueIndex("generation_contexts_revision_hash_uq").on(
      table.revisionId,
      table.contextHash,
    ),
    index("generation_contexts_revision_idx").on(
      table.revisionId,
      table.createdAt,
    ),
  ],
);

export const practiceSessions = pgTable("practice_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => pullRequestRevisions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  version: text("version").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const proofPlans = pgTable(
  "proof_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pullRequestRevisions.id, { onDelete: "cascade" }),
    generationContextId: uuid("generation_context_id").references(
      () => generationContexts.id,
      { onDelete: "restrict" },
    ),
    repositoryPolicyId: uuid("repository_policy_id")
      .notNull()
      .references(() => repositoryPolicies.id, { onDelete: "restrict" }),
    planVersion: text("plan_version").notNull(),
    deterministicSeed: text("deterministic_seed").notNull(),
    riskExplanation: jsonb("risk_explanation")
      .$type<Record<string, unknown>>()
      .notNull(),
    questionBudget: integer("question_budget").notNull(),
    planHash: text("plan_hash").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("proof_plans_hash_uq").on(table.revisionId, table.planHash),
    index("proof_plans_generation_context_idx").on(table.generationContextId),
    index("proof_plans_repository_policy_idx").on(table.repositoryPolicyId),
    check(
      "proof_plans_question_budget",
      sql`${table.questionBudget} BETWEEN 1 AND 5`,
    ),
  ],
);

export const proofQuestions = pgTable(
  "proof_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    proofPlanId: uuid("proof_plan_id")
      .notNull()
      .references(() => proofPlans.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    type: text("type").notNull(),
    prompt: text("prompt").notNull(),
    diffAnchor: jsonb("diff_anchor").$type<Record<string, unknown>>().notNull(),
    rubric: jsonb("rubric").$type<Record<string, unknown>>().notNull(),
    required: boolean("required").notNull().default(true),
  },
  (table) => [
    uniqueIndex("proof_questions_ordinal_uq").on(
      table.proofPlanId,
      table.ordinal,
    ),
    check("proof_questions_ordinal_nonnegative", sql`${table.ordinal} >= 0`),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pullRequestRevisions.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull(),
    proofPlanId: uuid("proof_plan_id")
      .notNull()
      .references(() => proofPlans.id, { onDelete: "restrict" }),
    headSha: text("head_sha").notNull(),
    status: attemptStatusEnum("status").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    evidenceDeleteAfter: timestamp("evidence_delete_after", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attempts_one_active_per_author_revision_uq")
      .on(table.revisionId, table.authorId)
      .where(
        sql`${table.status} IN ('preparing','ready','active','uploading','processing','review_required')`,
      ),
    index("attempts_review_queue_idx")
      .on(table.repositoryId, table.createdAt)
      .where(sql`${table.status} = 'review_required'`),
    index("attempts_evidence_delete_after_idx")
      .on(table.evidenceDeleteAfter)
      .where(sql`${table.evidenceDeleteAfter} IS NOT NULL`),
    check("attempts_head_sha_format", sql`${table.headSha} ~ '^[0-9a-f]{40}$'`),
    check(
      "attempts_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const attemptTransitions = pgTable(
  "attempt_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    fromStatus: attemptStatusEnum("from_status").notNull(),
    toStatus: attemptStatusEnum("to_status").notNull(),
    expectedHeadSha: text("expected_head_sha").notNull(),
    currentHeadSha: text("current_head_sha").notNull(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("attempt_transitions_idempotency_uq").on(
      table.attemptId,
      table.idempotencyKey,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    csrfHash: text("csrf_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_uq").on(table.tokenHash),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const handoffTokens = pgTable(
  "handoff_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    desktopSessionId: uuid("desktop_session_id")
      .notNull()
      .references(() => authSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("handoff_tokens_token_hash_uq").on(table.tokenHash),
    uniqueIndex("handoff_tokens_one_open_attempt_uq")
      .on(table.attemptId)
      .where(sql`${table.consumedAt} IS NULL`),
    index("handoff_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const wrappingMaterials = pgTable(
  "wrapping_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").notNull(),
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").notNull(),
    spkiSha256: text("spki_sha256").notNull(),
    usableUntil: timestamp("usable_until", { withTimezone: true }).notNull(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("wrapping_materials_attempt_object_uq").on(
      table.attemptId,
      table.objectId,
    ),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").notNull(),
    objectKey: text("object_key").notNull(),
    providerUploadId: text("provider_upload_id").notNull(),
    state: text("state").notNull(),
    nextPartNumber: integer("next_part_number").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    manifestDigest: text("manifest_digest"),
    finalizeEnvelope:
      jsonb("finalize_envelope").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("upload_sessions_attempt_uq").on(table.attemptId),
    uniqueIndex("upload_sessions_object_key_uq").on(table.objectKey),
    uniqueIndex("upload_sessions_provider_upload_uq").on(
      table.providerUploadId,
    ),
    uniqueIndex("upload_sessions_manifest_digest_uq")
      .on(table.manifestDigest)
      .where(sql`${table.manifestDigest} IS NOT NULL`),
    check(
      "upload_sessions_next_part_positive",
      sql`${table.nextPartNumber} > 0`,
    ),
  ],
);

export const recordingParts = pgTable(
  "recording_parts",
  {
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    firstChunkIndex: integer("first_chunk_index").notNull(),
    lastChunkIndex: integer("last_chunk_index").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.uploadSessionId, table.partNumber] }),
    uniqueIndex("recording_parts_chunk_range_uq").on(
      table.uploadSessionId,
      table.firstChunkIndex,
      table.lastChunkIndex,
    ),
    check("recording_parts_part_positive", sql`${table.partNumber} > 0`),
    check(
      "recording_parts_chunk_range",
      sql`${table.firstChunkIndex} >= 0 AND ${table.lastChunkIndex} >= ${table.firstChunkIndex}`,
    ),
    check("recording_parts_bytes_positive", sql`${table.byteLength} > 0`),
  ],
);

export const recordingObjects = pgTable(
  "recording_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    wrappedDataKey: text("wrapped_data_key").notNull(),
    wrappedKeySha256: text("wrapped_key_sha256").notNull(),
    wrappingMaterialId: uuid("wrapping_material_id")
      .notNull()
      .references(() => wrappingMaterials.id, { onDelete: "restrict" }),
    protocolVersion: text("protocol_version").notNull(),
    algorithm: text("algorithm").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    codec: text("codec").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("recording_objects_attempt_uq").on(table.attemptId),
    uniqueIndex("recording_objects_object_key_uq").on(table.objectKey),
    uniqueIndex("recording_objects_wrapped_key_hash_uq").on(
      table.wrappedKeySha256,
    ),
    index("recording_objects_deletion_deadline_idx").on(
      table.deleteAfter,
      table.deletedAt,
    ),
    check("recording_objects_bytes_positive", sql`${table.byteLength} > 0`),
    check("recording_objects_duration_positive", sql`${table.durationMs} > 0`),
  ],
);

export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  schemaVersion: text("schema_version").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const frameSelections = pgTable("frame_selections", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" }),
  timestampMs: integer("timestamp_ms").notNull(),
  reasonCode: text("reason_code").notNull(),
  objectKey: text("object_key").notNull().unique(),
  deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    recommendation: text("recommendation").notNull(),
    deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("evaluations_version_tuple_uq").on(
      table.attemptId,
      table.provider,
      table.model,
      table.promptVersion,
      table.schemaVersion,
      table.rubricVersion,
    ),
  ],
);

export const reviewDecisions = pgTable("review_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" }),
  maintainerId: text("maintainer_id").notNull(),
  decision: reviewDecisionEnum("decision").notNull(),
  reasonCode: text("reason_code").notNull(),
  explanation: text("explanation"),
  headSha: text("head_sha").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const checkRuns = pgTable(
  "check_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pullRequestRevisions.id, { onDelete: "cascade" }),
    githubCheckRunId: text("github_check_run_id"),
    name: text("name").notNull(),
    status: checkStatusEnum("status").notNull(),
    conclusion: checkConclusionEnum("conclusion"),
    publicSummary: text("public_summary").notNull(),
    detailsUrl: text("details_url").notNull(),
    lastSynchronizedAt: timestamp("last_synchronized_at", {
      withTimezone: true,
    }),
    syncStatus: githubCheckSyncStatusEnum("sync_status")
      .default("synchronized")
      .notNull(),
    syncAttempts: integer("sync_attempts").default(0).notNull(),
    lastSyncErrorClass: text("last_sync_error_class"),
    syncRequestedAt: timestamp("sync_requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    nextSyncAfter: timestamp("next_sync_after", { withTimezone: true }),
    intentIdempotencyKey: text("intent_idempotency_key"),
    intentHash: text("intent_hash"),
    intentReason: githubCheckIntentReasonEnum("intent_reason"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("check_runs_revision_uq").on(table.revisionId),
    uniqueIndex("check_runs_github_id_uq").on(table.githubCheckRunId),
    index("check_runs_pending_sync_idx")
      .on(table.syncStatus, table.nextSyncAfter, table.syncRequestedAt)
      .where(sql`${table.syncStatus} IN ('pending', 'retry_required')`),
    check(
      "check_runs_sync_attempts_nonnegative",
      sql`${table.syncAttempts} >= 0`,
    ),
    check(
      "check_runs_error_class_format",
      sql`${table.lastSyncErrorClass} IS NULL OR ${table.lastSyncErrorClass} ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'`,
    ),
    check(
      "check_runs_next_sync_after_state",
      sql`${table.nextSyncAfter} IS NULL OR ${table.syncStatus} = 'retry_required'`,
    ),
    check(
      "check_runs_intent_pair",
      sql`(${table.intentIdempotencyKey} IS NULL AND ${table.intentHash} IS NULL AND ${table.intentReason} IS NULL) OR (${table.intentIdempotencyKey} IS NOT NULL AND ${table.intentHash} IS NOT NULL AND ${table.intentReason} IS NOT NULL)`,
    ),
    check(
      "check_runs_intent_key_format",
      sql`${table.intentIdempotencyKey} IS NULL OR ${table.intentIdempotencyKey} ~ '^[A-Za-z0-9._:-]{8,200}$'`,
    ),
    check(
      "check_runs_intent_hash_format",
      sql`${table.intentHash} IS NULL OR ${table.intentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "check_runs_status_conclusion_consistent",
      sql`(${table.status} = 'completed' AND ${table.conclusion} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.conclusion} IS NULL)`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_object_idx").on(
      table.objectType,
      table.objectId,
      table.occurredAt,
    ),
  ],
);

export const deletionJobs = pgTable(
  "deletion_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    objectClass: text("object_class").notNull(),
    objectId: text("object_id").notNull(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    state: jobStateEnum("state").notNull().default("pending"),
    lastErrorClass: text("last_error_class"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("deletion_jobs_object_uq").on(
      table.objectClass,
      table.objectId,
    ),
    index("deletion_jobs_deadline_idx").on(table.state, table.deadline),
    check("deletion_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);
