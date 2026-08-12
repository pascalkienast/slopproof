import { describe, expect, it } from "vitest";
import { createOpaqueCredential, hashOpaqueCredential } from "./token";

describe("opaque credentials", () => {
  it("creates URL-safe credentials with at least 256 bits by default", () => {
    const first = createOpaqueCredential("s".repeat(32), "handoff");
    const second = createOpaqueCredential("s".repeat(32), "handoff");
    expect(first.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.value).not.toBe(second.value);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("domain-separates hashes and rejects weak entropy requests", () => {
    const secret = "s".repeat(32);
    expect(hashOpaqueCredential(secret, "session", "value")).not.toBe(
      hashOpaqueCredential(secret, "handoff", "value"),
    );
    expect(() => createOpaqueCredential(secret, "session", 15)).toThrow(
      /128 bits/,
    );
  });
});
