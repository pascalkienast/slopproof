import { describe, expect, it } from "vitest";
import {
  RetentionContractError,
  createRetentionService,
  deleteEvidenceJob,
  sweepOverdueEvidence,
  type EvidenceDeletionPlan,
  type EvidenceDeletionStorage,
  type RetentionRetryableError,
  type RetentionClock,
  type RetentionPersistence,
} from "./retention";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const DELETION_JOB_ID = "10000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000002";
const RESERVED_FRAME_KEY = `provider-frame/20000000-0000-4000-8000-000000000001/${"a".repeat(64)}/320x180`;

class FixedClock implements RetentionClock {
  constructor(readonly value: Date) {}

  now(): Date {
    return this.value;
  }
}

class FakePersistence implements RetentionPersistence {
  readonly sweeps: {
    now: Date;
    staleBefore: Date;
    limit: number;
  }[] = [];
  readonly failures: {
    plan: EvidenceDeletionPlan;
    errorClass: string;
    now: Date;
  }[] = [];
  readonly completions: { plan: EvidenceDeletionPlan; now: Date }[] = [];
  plan: EvidenceDeletionPlan | null = {
    deletionJobId: DELETION_JOB_ID,
    attemptId: ATTEMPT_ID,
    objectKeys: ["evidence/original", RESERVED_FRAME_KEY, "evidence/original"],
    multipartUploads: [
      { objectKey: "evidence/original", uploadId: "upload-1" },
      { objectKey: "evidence/original", uploadId: "upload-1" },
    ],
  };

  async enqueueDueDeletions(input: {
    now: Date;
    staleBefore: Date;
    limit: number;
  }): Promise<readonly string[]> {
    this.sweeps.push(input);
    return [DELETION_JOB_ID];
  }

  async claimDeletion(): Promise<EvidenceDeletionPlan | null> {
    return this.plan;
  }

  async completeDeletion(plan: EvidenceDeletionPlan, now: Date): Promise<void> {
    this.completions.push({ plan, now });
    this.plan = null;
  }

  async failDeletion(
    plan: EvidenceDeletionPlan,
    errorClass: string,
    now: Date,
  ): Promise<void> {
    this.failures.push({ plan, errorClass, now });
  }
}

class FakeStorage implements EvidenceDeletionStorage {
  readonly aborted: string[] = [];
  readonly deleted: string[] = [];
  readonly multipartCutoffs: Date[] = [];
  failDeleteOnce = false;

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    this.aborted.push(`${objectKey}:${uploadId}`);
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false;
      throw new StorageUnavailableError();
    }
  }

  async abortIncompleteMultipartUploadsOlderThan(
    cutoff: Date,
  ): Promise<number> {
    this.multipartCutoffs.push(cutoff);
    return 0;
  }
}

class StorageUnavailableError extends Error {
  constructor() {
    super("synthetic outage");
    this.name = "StorageUnavailableError";
  }
}

const job = {
  schemaVersion: "1",
  idempotencyKey: `evidence-delete:${DELETION_JOB_ID}`,
  deletionJobId: DELETION_JOB_ID,
} as const;

describe("retention worker", () => {
  it("uses the injected clock and bounds a sweep without real waiting", async () => {
    const persistence = new FakePersistence();
    const clock = new FixedClock(NOW);

    const queued = await sweepOverdueEvidence(
      persistence,
      clock,
      7,
      5 * 60_000,
    );

    expect(queued).toEqual([DELETION_JOB_ID]);
    expect(persistence.sweeps).toEqual([
      {
        now: NOW,
        staleBefore: new Date("2026-08-12T09:55:00.000Z"),
        limit: 7,
      },
    ]);
  });

  it("aborts multipart state, deletes original and derivatives once, then completes", async () => {
    const persistence = new FakePersistence();
    const storage = new FakeStorage();

    await deleteEvidenceJob(job, {
      persistence,
      storage,
      clock: new FixedClock(NOW),
    });
    await deleteEvidenceJob(job, {
      persistence,
      storage,
      clock: new FixedClock(NOW),
    });

    expect(storage.aborted).toEqual(["evidence/original:upload-1"]);
    expect(storage.deleted).toEqual(["evidence/original", RESERVED_FRAME_KEY]);
    expect(persistence.completions).toHaveLength(1);
    expect(persistence.failures).toEqual([]);
  });

  it("records only the technical error class and rethrows a retryable error", async () => {
    const persistence = new FakePersistence();
    const storage = new FakeStorage();
    storage.failDeleteOnce = true;

    await expect(
      deleteEvidenceJob(job, {
        persistence,
        storage,
        clock: new FixedClock(NOW),
      }),
    ).rejects.toMatchObject({
      code: "RETENTION_RETRYABLE",
      errorClass: "StorageUnavailableError",
    } satisfies Partial<RetentionRetryableError>);
    expect(persistence.failures).toEqual([
      {
        plan: expect.objectContaining({
          deletionJobId: DELETION_JOB_ID,
          attemptId: ATTEMPT_ID,
        }),
        errorClass: "StorageUnavailableError",
        now: NOW,
      },
    ]);

    await deleteEvidenceJob(job, {
      persistence,
      storage,
      clock: new FixedClock(NOW),
    });
    expect(persistence.completions).toHaveLength(1);
  });

  it("treats an already absent multipart upload as an idempotent success", async () => {
    const persistence = new FakePersistence();
    const storage: EvidenceDeletionStorage = {
      async abortMultipartUpload() {
        const error = new Error("missing");
        error.name = "NoSuchUpload";
        throw error;
      },
      async deleteObject() {},
    };

    await expect(
      deleteEvidenceJob(job, {
        persistence,
        storage,
        clock: new FixedClock(NOW),
      }),
    ).resolves.toBeUndefined();
    expect(persistence.completions).toHaveLength(1);
  });

  it("exposes handlers for direct pg-boss wiring and rejects invalid limits", async () => {
    const persistence = new FakePersistence();
    const storage = new FakeStorage();
    const service = createRetentionService({
      persistence,
      storage,
      clock: new FixedClock(NOW),
    });

    await expect(
      service.auditRetention({
        schemaVersion: "1",
        idempotencyKey: "retention-audit:run-1",
        auditRunId: "10000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toEqual([DELETION_JOB_ID]);
    expect(storage.multipartCutoffs).toEqual([
      new Date("2026-08-11T10:00:00.000Z"),
    ]);
    await expect(
      service.auditRetention({
        schemaVersion: "1",
        idempotencyKey: "retention-audit:run-2",
        auditRunId: "10000000-0000-4000-8000-000000000004",
        unexpected: true,
      } as never),
    ).rejects.toThrow();
    await expect(service.sweep(0)).rejects.toBeInstanceOf(
      RetentionContractError,
    );
  });

  it("starts DB retention even when the provider orphan sweep fails", async () => {
    const persistence = new FakePersistence();
    const storage = new FakeStorage();
    storage.abortIncompleteMultipartUploadsOlderThan = async () => {
      throw new StorageUnavailableError();
    };
    const service = createRetentionService({
      persistence,
      storage,
      clock: new FixedClock(NOW),
    });

    await expect(
      service.auditRetention({
        schemaVersion: "1",
        idempotencyKey: "retention-audit:provider-outage",
        auditRunId: "10000000-0000-4000-8000-000000000005",
      }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(persistence.sweeps).toHaveLength(1);
  });
});
