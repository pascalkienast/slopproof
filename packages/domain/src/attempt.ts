import { z } from "zod";
import {
  GitShaSchema,
  IdempotencyKeySchema,
  NonEmptyIdentifierSchema,
  UuidSchema,
  type Clock,
  type IdGenerator,
} from "./primitives";

export const AttemptStatusSchema = z.enum([
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

export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const NONTERMINAL_ATTEMPT_STATUSES = [
  "preparing",
  "ready",
  "active",
  "uploading",
  "processing",
  "review_required",
] as const satisfies readonly AttemptStatus[];

export const TERMINAL_ATTEMPT_STATUSES = [
  "passed",
  "retry_required",
  "technical_retry",
  "expired",
  "invalidated",
] as const satisfies readonly AttemptStatus[];

export const ALLOWED_ATTEMPT_TRANSITIONS = {
  preparing: ["ready", "technical_retry", "expired", "invalidated"],
  ready: ["active", "technical_retry", "expired", "invalidated"],
  active: ["uploading", "technical_retry", "expired", "invalidated"],
  uploading: ["processing", "technical_retry", "expired", "invalidated"],
  processing: ["review_required", "technical_retry", "expired", "invalidated"],
  review_required: [
    "passed",
    "retry_required",
    "technical_retry",
    "expired",
    "invalidated",
  ],
  passed: [],
  retry_required: [],
  technical_retry: [],
  expired: [],
  invalidated: [],
} as const satisfies Record<AttemptStatus, readonly AttemptStatus[]>;

export const AttemptArtifactRefsSchema = z
  .object({
    handoffTokenId: UuidSchema.optional(),
    mobileSessionId: UuidSchema.optional(),
    uploadSessionId: UuidSchema.optional(),
    recordingManifestId: UuidSchema.optional(),
    recordingObjectId: UuidSchema.optional(),
    wrappedKeyRef: UuidSchema.optional(),
    transcriptId: UuidSchema.optional(),
    evaluationId: UuidSchema.optional(),
    reviewDecisionId: UuidSchema.optional(),
    technicalEventId: UuidSchema.optional(),
  })
  .strict();

export type AttemptArtifactRefs = z.infer<typeof AttemptArtifactRefsSchema>;

export const AuthorizationScopeSchema = z.enum([
  "attempt:prepare",
  "attempt:start",
  "attempt:upload",
  "attempt:process",
  "attempt:request_review",
  "attempt:decide",
  "attempt:mark_technical_retry",
  "attempt:expire",
  "attempt:invalidate",
]);

export type AuthorizationScope = z.infer<typeof AuthorizationScopeSchema>;

export const AuthorizedActorSchema = z
  .object({
    actorId: NonEmptyIdentifierSchema,
    role: z.enum(["author", "maintainer", "worker", "system"]),
    authorization: z
      .object({
        authorized: z.literal(true),
        repositoryId: UuidSchema,
        scopes: z.array(AuthorizationScopeSchema).min(1),
        checkedAt: z.date(),
        expiresAt: z.date(),
      })
      .strict(),
  })
  .strict();

export type AuthorizedActor = z.infer<typeof AuthorizedActorSchema>;

export const AttemptTransitionReceiptSchema = z
  .object({
    id: UuidSchema,
    attemptId: UuidSchema,
    idempotencyKey: IdempotencyKeySchema,
    from: AttemptStatusSchema,
    to: AttemptStatusSchema,
    expectedHeadSha: GitShaSchema,
    currentHeadSha: GitShaSchema,
    actorId: NonEmptyIdentifierSchema,
    actorRole: z.enum(["author", "maintainer", "worker", "system"]),
    occurredAt: z.date(),
  })
  .strict();

export type AttemptTransitionReceipt = z.infer<
  typeof AttemptTransitionReceiptSchema
>;

export const AttemptSchema = z
  .object({
    id: UuidSchema,
    repositoryId: UuidSchema,
    revisionId: UuidSchema,
    proofPlanId: UuidSchema,
    authorId: NonEmptyIdentifierSchema,
    headSha: GitShaSchema,
    status: AttemptStatusSchema,
    expiresAt: z.date(),
    createdAt: z.date(),
    updatedAt: z.date(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
    invalidatedAt: z.date().optional(),
    artifacts: AttemptArtifactRefsSchema,
    transitionReceipts: z.array(AttemptTransitionReceiptSchema),
  })
  .strict();

export type Attempt = z.infer<typeof AttemptSchema>;

export const CreateAttemptInputSchema = z
  .object({
    repositoryId: UuidSchema,
    revisionId: UuidSchema,
    proofPlanId: UuidSchema,
    authorId: NonEmptyIdentifierSchema,
    headSha: GitShaSchema,
    expiresAt: z.date(),
  })
  .strict();

export type CreateAttemptInput = z.infer<typeof CreateAttemptInputSchema>;

export const AttemptTransitionCommandSchema = z
  .object({
    attempt: AttemptSchema,
    expectedStatus: AttemptStatusSchema,
    targetStatus: AttemptStatusSchema,
    expectedHeadSha: GitShaSchema,
    currentHeadSha: GitShaSchema,
    actor: AuthorizedActorSchema,
    artifacts: AttemptArtifactRefsSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export type AttemptTransitionCommand = z.infer<
  typeof AttemptTransitionCommandSchema
>;

export type AttemptTransitionErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "TERMINAL_STATUS"
  | "INVALID_TRANSITION"
  | "STALE_STATUS"
  | "EXPECTED_SHA_MISMATCH"
  | "REVISION_INVALIDATED"
  | "INVALIDATION_REQUIRES_NEW_SHA"
  | "ATTEMPT_EXPIRED"
  | "EXPIRATION_NOT_DUE"
  | "AUTHORIZATION_REPOSITORY_MISMATCH"
  | "AUTHORIZATION_NOT_YET_VALID"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_STALE"
  | "ACTOR_NOT_ALLOWED"
  | "AUTHOR_MISMATCH"
  | "MISSING_SCOPE"
  | "MISSING_ARTIFACT";

export class AttemptTransitionError extends Error {
  constructor(
    readonly code: AttemptTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AttemptTransitionError";
  }
}

export type AttemptTransitionResult = {
  attempt: Attempt;
  receipt: AttemptTransitionReceipt;
  replayed: boolean;
};

export type AttemptDependencies = {
  clock: Clock;
  ids: IdGenerator;
};

export type TransitionDependencies = AttemptDependencies & {
  maxAuthorizationAgeMs?: number;
};

const FIVE_MINUTES_MS = 5 * 60 * 1_000;

const REQUIRED_ARTIFACTS: Readonly<
  Record<AttemptStatus, readonly (keyof AttemptArtifactRefs)[]>
> = {
  preparing: [],
  ready: [],
  active: ["handoffTokenId", "mobileSessionId"],
  uploading: ["uploadSessionId"],
  processing: ["recordingManifestId", "recordingObjectId", "wrappedKeyRef"],
  review_required: ["transcriptId", "evaluationId"],
  passed: ["reviewDecisionId"],
  retry_required: ["reviewDecisionId"],
  technical_retry: ["technicalEventId"],
  expired: [],
  invalidated: [],
};

const TRANSITION_AUTHORIZATION: Readonly<
  Record<
    AttemptStatus,
    { roles: readonly AuthorizedActor["role"][]; scope: AuthorizationScope }
  >
> = {
  preparing: {
    roles: ["worker", "system"],
    scope: "attempt:prepare",
  },
  ready: {
    roles: ["worker", "system"],
    scope: "attempt:prepare",
  },
  active: { roles: ["author"], scope: "attempt:start" },
  uploading: { roles: ["author"], scope: "attempt:upload" },
  processing: {
    roles: ["worker", "system"],
    scope: "attempt:process",
  },
  review_required: {
    roles: ["worker", "system"],
    scope: "attempt:request_review",
  },
  passed: { roles: ["maintainer"], scope: "attempt:decide" },
  retry_required: { roles: ["maintainer"], scope: "attempt:decide" },
  technical_retry: {
    roles: ["worker", "system"],
    scope: "attempt:mark_technical_retry",
  },
  expired: {
    roles: ["worker", "system"],
    scope: "attempt:expire",
  },
  invalidated: {
    roles: ["worker", "system"],
    scope: "attempt:invalidate",
  },
};

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly AttemptStatus[]).includes(
    status,
  );
}

export function canTransitionAttempt(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  return (
    ALLOWED_ATTEMPT_TRANSITIONS[from] as readonly AttemptStatus[]
  ).includes(to);
}

export function createAttempt(
  rawInput: CreateAttemptInput,
  dependencies: AttemptDependencies,
): Attempt {
  const input = CreateAttemptInputSchema.parse(rawInput);
  const now = dependencies.clock.now();
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new AttemptTransitionError(
      "ATTEMPT_EXPIRED",
      "A new attempt must expire after the current server time",
    );
  }

  return AttemptSchema.parse({
    id: UuidSchema.parse(dependencies.ids.nextId()),
    ...input,
    status: "preparing",
    createdAt: now,
    updatedAt: now,
    artifacts: {},
    transitionReceipts: [],
  });
}

function assertAuthorization(
  attempt: Attempt,
  targetStatus: AttemptStatus,
  actor: AuthorizedActor,
  now: Date,
  maxAuthorizationAgeMs: number,
): void {
  if (actor.authorization.repositoryId !== attempt.repositoryId) {
    throw new AttemptTransitionError(
      "AUTHORIZATION_REPOSITORY_MISMATCH",
      "Authorization is not bound to the attempt repository",
    );
  }
  if (actor.authorization.checkedAt.getTime() > now.getTime()) {
    throw new AttemptTransitionError(
      "AUTHORIZATION_NOT_YET_VALID",
      "Authorization check time is in the future",
    );
  }
  if (actor.authorization.expiresAt.getTime() <= now.getTime()) {
    throw new AttemptTransitionError(
      "AUTHORIZATION_EXPIRED",
      "Authorization has expired",
    );
  }
  if (
    now.getTime() - actor.authorization.checkedAt.getTime() >
    maxAuthorizationAgeMs
  ) {
    throw new AttemptTransitionError(
      "AUTHORIZATION_STALE",
      "Authorization is not fresh enough for this transition",
    );
  }

  const rule = TRANSITION_AUTHORIZATION[targetStatus];
  if (!rule.roles.includes(actor.role)) {
    throw new AttemptTransitionError(
      "ACTOR_NOT_ALLOWED",
      `Actor role ${actor.role} cannot transition an attempt to ${targetStatus}`,
    );
  }
  if (!actor.authorization.scopes.includes(rule.scope)) {
    throw new AttemptTransitionError(
      "MISSING_SCOPE",
      `Authorization lacks scope ${rule.scope}`,
    );
  }
  if (actor.role === "author" && actor.actorId !== attempt.authorId) {
    throw new AttemptTransitionError(
      "AUTHOR_MISMATCH",
      "Only the attempt author may start or upload this proof",
    );
  }
}

function assertArtifacts(
  targetStatus: AttemptStatus,
  artifacts: AttemptArtifactRefs,
): void {
  for (const artifact of REQUIRED_ARTIFACTS[targetStatus]) {
    if (artifacts[artifact] === undefined) {
      throw new AttemptTransitionError(
        "MISSING_ARTIFACT",
        `Transition to ${targetStatus} requires artifact ${artifact}`,
      );
    }
  }
}

function findIdempotentReplay(
  command: AttemptTransitionCommand,
): AttemptTransitionReceipt | undefined {
  const receipt = command.attempt.transitionReceipts.find(
    (candidate) => candidate.idempotencyKey === command.idempotencyKey,
  );
  if (receipt === undefined) {
    return undefined;
  }

  const matches =
    receipt.attemptId === command.attempt.id &&
    receipt.from === command.expectedStatus &&
    receipt.to === command.targetStatus &&
    receipt.expectedHeadSha === command.expectedHeadSha &&
    receipt.currentHeadSha === command.currentHeadSha &&
    receipt.actorId === command.actor.actorId &&
    receipt.actorRole === command.actor.role;

  if (!matches) {
    throw new AttemptTransitionError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different transition",
    );
  }
  return receipt;
}

export function transitionAttempt(
  rawCommand: AttemptTransitionCommand,
  dependencies: TransitionDependencies,
): AttemptTransitionResult {
  const command = AttemptTransitionCommandSchema.parse(rawCommand);
  const replayReceipt = findIdempotentReplay(command);
  if (replayReceipt !== undefined) {
    return {
      attempt: command.attempt,
      receipt: replayReceipt,
      replayed: true,
    };
  }

  const { attempt, targetStatus } = command;
  if (isTerminalAttemptStatus(attempt.status)) {
    throw new AttemptTransitionError(
      "TERMINAL_STATUS",
      `Terminal attempt status ${attempt.status} cannot be overwritten`,
    );
  }
  if (attempt.status !== command.expectedStatus) {
    throw new AttemptTransitionError(
      "STALE_STATUS",
      `Expected status ${command.expectedStatus}, found ${attempt.status}`,
    );
  }
  if (!canTransitionAttempt(attempt.status, targetStatus)) {
    throw new AttemptTransitionError(
      "INVALID_TRANSITION",
      `Transition ${attempt.status} -> ${targetStatus} is not allowed`,
    );
  }
  if (command.expectedHeadSha !== attempt.headSha) {
    throw new AttemptTransitionError(
      "EXPECTED_SHA_MISMATCH",
      "Command is not bound to the attempt head SHA",
    );
  }

  const currentShaMatches = command.currentHeadSha === attempt.headSha;
  if (targetStatus === "invalidated") {
    if (currentShaMatches) {
      throw new AttemptTransitionError(
        "INVALIDATION_REQUIRES_NEW_SHA",
        "An attempt can only be invalidated after the current head SHA changes",
      );
    }
  } else if (!currentShaMatches) {
    throw new AttemptTransitionError(
      "REVISION_INVALIDATED",
      "Current head SHA no longer matches the attempt revision",
    );
  }

  const now = dependencies.clock.now();
  const hasExpired = now.getTime() >= attempt.expiresAt.getTime();
  if (targetStatus === "expired") {
    if (!hasExpired) {
      throw new AttemptTransitionError(
        "EXPIRATION_NOT_DUE",
        "Attempt expiration is not due at the current server time",
      );
    }
  } else if (hasExpired && targetStatus !== "invalidated") {
    throw new AttemptTransitionError(
      "ATTEMPT_EXPIRED",
      "Attempt has expired according to server time",
    );
  }

  assertAuthorization(
    attempt,
    targetStatus,
    command.actor,
    now,
    dependencies.maxAuthorizationAgeMs ?? FIVE_MINUTES_MS,
  );

  const artifacts = AttemptArtifactRefsSchema.parse({
    ...attempt.artifacts,
    ...command.artifacts,
  });
  assertArtifacts(targetStatus, artifacts);

  const receipt = AttemptTransitionReceiptSchema.parse({
    id: dependencies.ids.nextId(),
    attemptId: attempt.id,
    idempotencyKey: command.idempotencyKey,
    from: attempt.status,
    to: targetStatus,
    expectedHeadSha: command.expectedHeadSha,
    currentHeadSha: command.currentHeadSha,
    actorId: command.actor.actorId,
    actorRole: command.actor.role,
    occurredAt: now,
  });

  const terminal = isTerminalAttemptStatus(targetStatus);
  const next = AttemptSchema.parse({
    ...attempt,
    status: targetStatus,
    updatedAt: now,
    artifacts,
    transitionReceipts: [...attempt.transitionReceipts, receipt],
    ...(targetStatus === "active" && attempt.startedAt === undefined
      ? { startedAt: now }
      : {}),
    ...(terminal ? { completedAt: now } : {}),
    ...(targetStatus === "invalidated" ? { invalidatedAt: now } : {}),
  });

  return { attempt: next, receipt, replayed: false };
}
