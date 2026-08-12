import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CAPABILITY_MAX_TTL_MS,
  EvidenceCapabilityError,
  EvidenceCapabilityPayloadSchema,
  issueEvidenceCapability,
  verifyEvidenceCapability,
} from "./evidence-capability";

const secret = "s".repeat(32);
const now = new Date("2026-08-12T08:00:00.000Z");
const input = {
  attemptId: "10000000-0000-4000-8000-000000000001",
  repositoryId: "10000000-0000-4000-8000-000000000002",
  actorId: "demo-maintainer",
};

describe("maintainer evidence capabilities", () => {
  it("round-trips canonical, evidence-free payloads for at most 60 seconds", () => {
    const issued = issueEvidenceCapability(input, secret, {
      now,
      nextJti: () => "10000000-0000-4000-8000-000000000003",
    });
    expect(issued.payload).toEqual({
      version: 1,
      ...input,
      jti: "10000000-0000-4000-8000-000000000003",
      expiresAt: "2026-08-12T08:01:00.000Z",
    });
    expect(verifyEvidenceCapability(issued.token, secret, now)).toEqual(
      issued.payload,
    );
    expect(issued.token).not.toContain("object");
    expect(issued.token).not.toContain("video");
    expect(issued.token).not.toContain("transcript");
  });

  it("rejects tampering, the wrong secret, expiry and excessive TTL", () => {
    const issued = issueEvidenceCapability(input, secret, {
      now,
      nextJti: () => "10000000-0000-4000-8000-000000000003",
    });
    expect(() =>
      verifyEvidenceCapability(`${issued.token.slice(0, -1)}A`, secret, now),
    ).toThrow(EvidenceCapabilityError);
    expect(() =>
      verifyEvidenceCapability(issued.token, "x".repeat(32), now),
    ).toThrow(EvidenceCapabilityError);
    expect(() =>
      verifyEvidenceCapability(
        issued.token,
        secret,
        new Date("2026-08-12T08:01:00.000Z"),
      ),
    ).toThrow(EvidenceCapabilityError);
    expect(() =>
      issueEvidenceCapability(
        { ...input, ttlMs: EVIDENCE_CAPABILITY_MAX_TTL_MS + 1 },
        secret,
        { now },
      ),
    ).toThrow(EvidenceCapabilityError);
  });

  it("rejects unknown fields at the shared worker boundary", () => {
    expect(() =>
      EvidenceCapabilityPayloadSchema.parse({
        version: 1,
        ...input,
        jti: "10000000-0000-4000-8000-000000000003",
        expiresAt: "2026-08-12T08:01:00.000Z",
        objectKey: "must-never-be-in-the-token",
      }),
    ).toThrow();
  });
});
