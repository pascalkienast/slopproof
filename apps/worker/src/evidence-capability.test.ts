import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WorkerEvidenceCapabilityError,
  verifyWorkerEvidenceCapability,
} from "./evidence-capability";

const secret = "worker-capability-test-secret-000000000";
const now = new Date("2026-08-12T12:00:00.000Z");

function tokenFor(document: string): string {
  const signature = createHmac("sha256", secret)
    .update(document, "utf8")
    .digest("base64url");
  return `${Buffer.from(document).toString("base64url")}.${signature}`;
}

function canonicalDocument(expiresAt = "2026-08-12T12:00:30.000Z"): string {
  return JSON.stringify({
    version: 1,
    attemptId: "53000000-0000-4000-8000-000000000001",
    repositoryId: "50000000-0000-4000-8000-000000000002",
    actorId: "demo-maintainer",
    jti: "54000000-0000-4000-8000-000000000001",
    expiresAt,
  });
}

describe("worker evidence capability", () => {
  it("accepts the canonical web-worker contract within sixty seconds", () => {
    const payload = verifyWorkerEvidenceCapability(
      tokenFor(canonicalDocument()),
      secret,
      now,
    );

    expect(payload.actorId).toBe("demo-maintainer");
    expect(payload.attemptId).toBe("53000000-0000-4000-8000-000000000001");
  });

  it("rejects a validly signed but non-canonical document", () => {
    const reordered = JSON.stringify({
      actorId: "demo-maintainer",
      version: 1,
      attemptId: "53000000-0000-4000-8000-000000000001",
      repositoryId: "50000000-0000-4000-8000-000000000002",
      jti: "54000000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-12T12:00:30.000Z",
    });

    expect(() =>
      verifyWorkerEvidenceCapability(tokenFor(reordered), secret, now),
    ).toThrowError(WorkerEvidenceCapabilityError);
  });

  it("rejects expiry, overlong TTL, and signature tampering", () => {
    for (const expiresAt of [
      "2026-08-12T12:00:00.000Z",
      "2026-08-12T12:01:00.001Z",
    ]) {
      expect(() =>
        verifyWorkerEvidenceCapability(
          tokenFor(canonicalDocument(expiresAt)),
          secret,
          now,
        ),
      ).toThrowError(WorkerEvidenceCapabilityError);
    }
    const token = tokenFor(canonicalDocument());
    expect(() =>
      verifyWorkerEvidenceCapability(`${token.slice(0, -1)}A`, secret, now),
    ).toThrowError(WorkerEvidenceCapabilityError);
  });
});
