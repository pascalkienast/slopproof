import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALLOWED_ATTEMPT_TRANSITIONS,
  AttemptSchema,
  AttemptTransitionCommandSchema,
  AttemptTransitionError,
  CreateAttemptInputSchema,
  TERMINAL_ATTEMPT_STATUSES,
  canTransitionAttempt,
  createAttempt,
  transitionAttempt,
  type Attempt,
  type AttemptArtifactRefs,
  type AttemptStatus,
  type AuthorizationScope,
  type AuthorizedActor,
  type Clock,
  type IdGenerator,
} from "./index";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
  "00000000-0000-4000-8000-000000000015",
] as const;

const REPOSITORY_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const PLAN_ID = "10000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

class MutableClock implements Clock {
  constructor(public value: Date) {}

  now(): Date {
    return this.value;
  }
}

class SequenceIds implements IdGenerator {
  private index = 0;

  nextId(): string {
    const id = IDS[this.index];
    if (id === undefined) {
      throw new Error("Test ID sequence exhausted");
    }
    this.index += 1;
    return id;
  }
}

function makeFixture() {
  const clock = new MutableClock(new Date("2026-08-11T10:00:00.000Z"));
  const ids = new SequenceIds();
  const attempt = createAttempt(
    {
      repositoryId: REPOSITORY_ID,
      revisionId: REVISION_ID,
      proofPlanId: PLAN_ID,
      authorId: "github-user-42",
      headSha: SHA,
      expiresAt: new Date("2026-08-11T11:00:00.000Z"),
    },
    { clock, ids },
  );
  return { attempt, clock, ids };
}

function actor(
  role: AuthorizedActor["role"],
  scope: AuthorizationScope,
  now: Date,
  overrides: Partial<AuthorizedActor> = {},
): AuthorizedActor {
  return {
    actorId: role === "author" ? "github-user-42" : `${role}-1`,
    role,
    authorization: {
      authorized: true,
      repositoryId: REPOSITORY_ID,
      scopes: [scope],
      checkedAt: new Date(now.getTime() - 1_000),
      expiresAt: new Date(now.getTime() + 60_000),
    },
    ...overrides,
  };
}

const transitionActors: Record<
  AttemptStatus,
  { role: AuthorizedActor["role"]; scope: AuthorizationScope }
> = {
  preparing: { role: "system", scope: "attempt:prepare" },
  ready: { role: "worker", scope: "attempt:prepare" },
  active: { role: "author", scope: "attempt:start" },
  uploading: { role: "author", scope: "attempt:upload" },
  processing: { role: "worker", scope: "attempt:process" },
  review_required: { role: "worker", scope: "attempt:request_review" },
  passed: { role: "maintainer", scope: "attempt:decide" },
  retry_required: { role: "maintainer", scope: "attempt:decide" },
  technical_retry: {
    role: "worker",
    scope: "attempt:mark_technical_retry",
  },
  expired: { role: "system", scope: "attempt:expire" },
  invalidated: { role: "system", scope: "attempt:invalidate" },
};

function artifactsFor(target: AttemptStatus): AttemptArtifactRefs {
  const refs: Partial<Record<keyof AttemptArtifactRefs, string>> = {
    handoffTokenId: "20000000-0000-4000-8000-000000000001",
    mobileSessionId: "20000000-0000-4000-8000-000000000002",
    uploadSessionId: "20000000-0000-4000-8000-000000000003",
    recordingManifestId: "20000000-0000-4000-8000-000000000004",
    recordingObjectId: "20000000-0000-4000-8000-000000000005",
    wrappedKeyRef: "20000000-0000-4000-8000-000000000006",
    transcriptId: "20000000-0000-4000-8000-000000000007",
    evaluationId: "20000000-0000-4000-8000-000000000008",
    reviewDecisionId: "20000000-0000-4000-8000-000000000009",
    technicalEventId: "20000000-0000-4000-8000-000000000010",
  };

  switch (target) {
    case "active":
      return {
        handoffTokenId: refs.handoffTokenId,
        mobileSessionId: refs.mobileSessionId,
      };
    case "uploading":
      return { uploadSessionId: refs.uploadSessionId };
    case "processing":
      return {
        recordingManifestId: refs.recordingManifestId,
        recordingObjectId: refs.recordingObjectId,
        wrappedKeyRef: refs.wrappedKeyRef,
      };
    case "review_required":
      return {
        transcriptId: refs.transcriptId,
        evaluationId: refs.evaluationId,
      };
    case "passed":
    case "retry_required":
      return { reviewDecisionId: refs.reviewDecisionId };
    case "technical_retry":
      return { technicalEventId: refs.technicalEventId };
    default:
      return {};
  }
}

function move(
  attempt: Attempt,
  targetStatus: AttemptStatus,
  fixture: ReturnType<typeof makeFixture>,
  idempotencyKey: string,
  overrides: {
    actor?: AuthorizedActor;
    artifacts?: AttemptArtifactRefs;
    expectedStatus?: AttemptStatus;
    expectedHeadSha?: string;
    currentHeadSha?: string;
  } = {},
) {
  const rule = transitionActors[targetStatus];
  return transitionAttempt(
    {
      attempt,
      expectedStatus: overrides.expectedStatus ?? attempt.status,
      targetStatus,
      expectedHeadSha: overrides.expectedHeadSha ?? SHA,
      currentHeadSha:
        overrides.currentHeadSha ??
        (targetStatus === "invalidated" ? NEW_SHA : SHA),
      actor:
        overrides.actor ?? actor(rule.role, rule.scope, fixture.clock.value),
      artifacts: overrides.artifacts ?? artifactsFor(targetStatus),
      idempotencyKey,
    },
    { clock: fixture.clock, ids: fixture.ids },
  );
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected transition to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AttemptTransitionError);
    expect((error as AttemptTransitionError).code).toBe(code);
  }
}

describe("Attempt state machine", () => {
  it("uses only the injected clock and ID source when creating an attempt", () => {
    const { attempt, clock } = makeFixture();

    expect(attempt.id).toBe(IDS[0]);
    expect(attempt.status).toBe("preparing");
    expect(attempt.createdAt).toEqual(clock.value);
    expect(attempt.updatedAt).toEqual(clock.value);
    expect(attempt.transitionReceipts).toEqual([]);
  });

  it("executes the complete successful proof path with required artifacts", () => {
    const fixture = makeFixture();
    let attempt = fixture.attempt;
    const path: AttemptStatus[] = [
      "ready",
      "active",
      "uploading",
      "processing",
      "review_required",
      "passed",
    ];

    for (const [index, target] of path.entries()) {
      fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);
      attempt = move(
        attempt,
        target,
        fixture,
        `proof-path:${String(index)}`,
      ).attempt;
    }

    expect(attempt.status).toBe("passed");
    expect(attempt.startedAt).toEqual(new Date("2026-08-11T10:00:02.000Z"));
    expect(attempt.completedAt).toEqual(new Date("2026-08-11T10:00:06.000Z"));
    expect(attempt.transitionReceipts).toHaveLength(6);
    expect(attempt.artifacts).toMatchObject({
      recordingObjectId: "20000000-0000-4000-8000-000000000005",
      evaluationId: "20000000-0000-4000-8000-000000000008",
      reviewDecisionId: "20000000-0000-4000-8000-000000000009",
    });
  });

  it("declares every transition explicitly and has no exits from terminals", () => {
    const statuses = Object.keys(
      ALLOWED_ATTEMPT_TRANSITIONS,
    ) as AttemptStatus[];
    expect(statuses).toHaveLength(11);

    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionAttempt(from, to)).toBe(
          ALLOWED_ATTEMPT_TRANSITIONS[from].includes(to as never),
        );
      }
    }
    for (const terminal of TERMINAL_ATTEMPT_STATUSES) {
      expect(ALLOWED_ATTEMPT_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("replays an identical idempotency key without generating an ID or transition", () => {
    const fixture = makeFixture();
    const first = move(fixture.attempt, "ready", fixture, "attempt:ready:1");

    const replay = move(first.attempt, "ready", fixture, "attempt:ready:1", {
      expectedStatus: "preparing",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.attempt).toEqual(first.attempt);
  });

  it("rejects reuse of an idempotency key for a different command", () => {
    const fixture = makeFixture();
    const first = move(fixture.attempt, "ready", fixture, "attempt:collision");

    expectCode(
      () =>
        move(first.attempt, "active", fixture, "attempt:collision", {
          artifacts: artifactsFor("active"),
        }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("requires expected and current SHA bindings and only invalidates on a new SHA", () => {
    const fixture = makeFixture();
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "sha:expected", {
          expectedHeadSha: NEW_SHA,
        }),
      "EXPECTED_SHA_MISMATCH",
    );
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "sha:current", {
          currentHeadSha: NEW_SHA,
        }),
      "REVISION_INVALIDATED",
    );
    expectCode(
      () =>
        move(fixture.attempt, "invalidated", fixture, "sha:same", {
          currentHeadSha: SHA,
        }),
      "INVALIDATION_REQUIRES_NEW_SHA",
    );

    const invalidated = move(
      fixture.attempt,
      "invalidated",
      fixture,
      "sha:changed",
    ).attempt;
    expect(invalidated.status).toBe("invalidated");
    expect(invalidated.invalidatedAt).toEqual(fixture.clock.value);
  });

  it("uses server time for expiry and rejects attempts that are not yet due", () => {
    const fixture = makeFixture();
    expectCode(
      () => move(fixture.attempt, "expired", fixture, "expiry:early"),
      "EXPIRATION_NOT_DUE",
    );

    fixture.clock.value = new Date("2026-08-11T11:00:00.000Z");
    expectCode(
      () => move(fixture.attempt, "ready", fixture, "expiry:late"),
      "ATTEMPT_EXPIRED",
    );

    const expired = move(
      fixture.attempt,
      "expired",
      fixture,
      "expiry:due",
    ).attempt;
    expect(expired.status).toBe("expired");
  });

  it("checks repository, freshness, role, author identity and scope", () => {
    const fixture = makeFixture();
    const now = fixture.clock.value;
    const valid = actor("worker", "attempt:prepare", now);

    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "auth:repository", {
          actor: {
            ...valid,
            authorization: {
              ...valid.authorization,
              repositoryId: "30000000-0000-4000-8000-000000000001",
            },
          },
        }),
      "AUTHORIZATION_REPOSITORY_MISMATCH",
    );
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "auth:expired", {
          actor: {
            ...valid,
            authorization: {
              ...valid.authorization,
              expiresAt: new Date(now.getTime() - 1),
            },
          },
        }),
      "AUTHORIZATION_EXPIRED",
    );
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "auth:stale", {
          actor: {
            ...valid,
            authorization: {
              ...valid.authorization,
              checkedAt: new Date(now.getTime() - 301_000),
            },
          },
        }),
      "AUTHORIZATION_STALE",
    );
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "auth:role", {
          actor: actor("author", "attempt:prepare", now),
        }),
      "ACTOR_NOT_ALLOWED",
    );
    expectCode(
      () =>
        move(fixture.attempt, "ready", fixture, "auth:scope", {
          actor: actor("worker", "attempt:process", now),
        }),
      "MISSING_SCOPE",
    );

    const ready = move(fixture.attempt, "ready", fixture, "auth:ready").attempt;
    expectCode(
      () =>
        move(ready, "active", fixture, "auth:author", {
          actor: actor("author", "attempt:start", now, {
            actorId: "some-other-author",
          }),
        }),
      "AUTHOR_MISMATCH",
    );
  });

  it("rejects missing transition artifacts and any terminal overwrite", () => {
    const fixture = makeFixture();
    const ready = move(
      fixture.attempt,
      "ready",
      fixture,
      "artifact:ready",
    ).attempt;
    expectCode(
      () =>
        move(ready, "active", fixture, "artifact:missing", {
          artifacts: {},
        }),
      "MISSING_ARTIFACT",
    );

    const terminal = move(
      ready,
      "technical_retry",
      fixture,
      "terminal:first",
    ).attempt;
    expectCode(
      () => move(terminal, "invalidated", fixture, "terminal:overwrite"),
      "TERMINAL_STATUS",
    );
  });
});

describe("strict boundary schemas", () => {
  it("rejects unknown input and nested authorization fields", () => {
    expect(() =>
      CreateAttemptInputSchema.parse({
        repositoryId: REPOSITORY_ID,
        revisionId: REVISION_ID,
        proofPlanId: PLAN_ID,
        authorId: "github-user-42",
        headSha: SHA,
        expiresAt: new Date("2026-08-11T11:00:00.000Z"),
        clientTime: "untrusted",
      }),
    ).toThrow(z.ZodError);

    const fixture = makeFixture();
    const validActor = actor("worker", "attempt:prepare", fixture.clock.value);
    expect(() =>
      AttemptTransitionCommandSchema.parse({
        attempt: fixture.attempt,
        expectedStatus: "preparing",
        targetStatus: "ready",
        expectedHeadSha: SHA,
        currentHeadSha: SHA,
        actor: {
          ...validActor,
          authorization: {
            ...validActor.authorization,
            installationToken: "must-not-cross-domain-boundary",
          },
        },
        artifacts: {},
        idempotencyKey: "strict-schema:1",
      }),
    ).toThrow(z.ZodError);
  });

  it("rejects malformed persisted attempts", () => {
    const { attempt } = makeFixture();
    expect(() =>
      AttemptSchema.parse({ ...attempt, status: "auto_passed" }),
    ).toThrow(z.ZodError);
  });
});
