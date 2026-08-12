import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WorkerPracticeCapabilityError,
  verifyWorkerPracticeCapability,
} from "./practice-capability";

const secret = "worker-practice-capability-secret-00000";
const now = new Date("2026-08-13T00:00:00.000Z");

function document(expiresAt = "2026-08-13T00:00:30.000Z"): string {
  return JSON.stringify({
    version: 1,
    revisionId: "10000000-0000-4000-8000-000000000001",
    repositoryId: "10000000-0000-4000-8000-000000000002",
    actorId: "42001",
    action: "practice.read",
    jti: "10000000-0000-4000-8000-000000000003",
    expiresAt,
  });
}

function token(rawDocument: string): string {
  const signature = createHmac("sha256", secret)
    .update("slopproof:practice-capability:v1:", "utf8")
    .update(rawDocument, "utf8")
    .digest("base64url");
  return `${Buffer.from(rawDocument, "utf8").toString("base64url")}.${signature}`;
}

describe("worker private practice capabilities", () => {
  it("accepts the exact canonical web-worker contract", () => {
    const payload = verifyWorkerPracticeCapability(
      token(document()),
      secret,
      now,
    );
    expect(payload.action).toBe("practice.read");
    expect(payload.actorId).toBe("42001");
  });

  it("rejects non-canonical, expired and tampered capabilities", () => {
    const reordered = JSON.stringify({
      actorId: "42001",
      version: 1,
      revisionId: "10000000-0000-4000-8000-000000000001",
      repositoryId: "10000000-0000-4000-8000-000000000002",
      action: "practice.read",
      jti: "10000000-0000-4000-8000-000000000003",
      expiresAt: "2026-08-13T00:00:30.000Z",
    });
    expect(() =>
      verifyWorkerPracticeCapability(token(reordered), secret, now),
    ).toThrow(WorkerPracticeCapabilityError);
    expect(() =>
      verifyWorkerPracticeCapability(
        token(document("2026-08-13T00:00:00.000Z")),
        secret,
        now,
      ),
    ).toThrow(WorkerPracticeCapabilityError);
    const valid = token(document());
    expect(() =>
      verifyWorkerPracticeCapability(`${valid.slice(0, -1)}A`, secret, now),
    ).toThrow(WorkerPracticeCapabilityError);
  });
});
