import { describe, expect, it } from "vitest";
import {
  PRACTICE_CAPABILITY_MAX_TTL_MS,
  PracticeCapabilityError,
  PracticeCapabilityPayloadSchema,
  issuePracticeCapability,
  verifyPracticeCapability,
} from "./practice-capability";

const secret = "p".repeat(32);
const now = new Date("2026-08-13T00:00:00.000Z");
const input = {
  revisionId: "10000000-0000-4000-8000-000000000001",
  repositoryId: "10000000-0000-4000-8000-000000000002",
  actorId: "42001",
  action: "practice.submit" as const,
};

describe("private practice capabilities", () => {
  it("round-trips one content-free, action-bound capability", () => {
    const issued = issuePracticeCapability(input, secret, {
      now,
      nextJti: () => "10000000-0000-4000-8000-000000000003",
    });
    expect(verifyPracticeCapability(issued.token, secret, now)).toEqual(
      issued.payload,
    );
    expect(issued.payload.action).toBe("practice.submit");
    expect(issued.token).not.toContain("answer");
    expect(issued.token).not.toContain("prompt");
    expect(issued.token).not.toContain("rubric");
  });

  it("rejects tampering, expiry, excessive TTL and action widening", () => {
    const issued = issuePracticeCapability(input, secret, {
      now,
      nextJti: () => "10000000-0000-4000-8000-000000000003",
    });
    expect(() =>
      verifyPracticeCapability(`${issued.token.slice(0, -1)}A`, secret, now),
    ).toThrow(PracticeCapabilityError);
    expect(() =>
      verifyPracticeCapability(
        issued.token,
        secret,
        new Date(now.getTime() + PRACTICE_CAPABILITY_MAX_TTL_MS),
      ),
    ).toThrow(PracticeCapabilityError);
    expect(() =>
      issuePracticeCapability(
        { ...input, ttlMs: PRACTICE_CAPABILITY_MAX_TTL_MS + 1 },
        secret,
        { now },
      ),
    ).toThrow(PracticeCapabilityError);
    expect(() =>
      PracticeCapabilityPayloadSchema.parse({
        ...issued.payload,
        action: "practice.admin",
      }),
    ).toThrow();
  });

  it("rejects unknown fields at the web-worker boundary", () => {
    expect(() =>
      PracticeCapabilityPayloadSchema.parse({
        version: 1,
        ...input,
        jti: "10000000-0000-4000-8000-000000000003",
        expiresAt: "2026-08-13T00:00:30.000Z",
        contributorAnswer: "must never enter a capability",
      }),
    ).toThrow();
  });
});
