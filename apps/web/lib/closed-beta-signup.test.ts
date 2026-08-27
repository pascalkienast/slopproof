import { describe, expect, it, vi } from "vitest";
import {
  ClosedBetaSignupInputSchema,
  persistClosedBetaSignup,
} from "./closed-beta-signup";

describe("closed beta signup persistence", () => {
  it("normalizes and parameterizes the two admission coordinates", async () => {
    const query = vi.fn(
      async (_statement: string, _parameters?: unknown[]) => ({
        rows: [{ id: "10000000-0000-4000-8000-000000000001" }],
        rowCount: 1,
      }),
    );

    await expect(
      persistClosedBetaSignup({ query } as never, {
        email: "  Pascal@Example.COM ",
        githubUsername: " @Pascal-Kienast ",
        contactConsent: true,
      }),
    ).resolves.toEqual({ accepted: true, stored: true });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT DO NOTHING"),
      ["pascal@example.com", "pascal-kienast"],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain("pascal@example.com");
  });

  it("returns the same accepted result for an existing signup", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await expect(
      persistClosedBetaSignup({ query } as never, {
        email: "pascal@example.com",
        githubUsername: "pascal-kienast",
        contactConsent: true,
      }),
    ).resolves.toEqual({ accepted: true, stored: false });
  });

  it("silently accepts the honeypot without persisting personal data", async () => {
    const query = vi.fn();

    await expect(
      persistClosedBetaSignup({ query } as never, {
        email: "bot@example.com",
        githubUsername: "definitely-a-bot",
        contactConsent: true,
        website: "https://spam.invalid",
      }),
    ).resolves.toEqual({ accepted: true, stored: false });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    {
      email: "not-an-email",
      githubUsername: "pascal-kienast",
      contactConsent: true,
    },
    {
      email: "pascal@example.com",
      githubUsername: "-starts-with-a-dash",
      contactConsent: true,
    },
    {
      email: "pascal@example.com",
      githubUsername: "double--dash",
      contactConsent: true,
    },
    {
      email: "pascal@example.com",
      githubUsername: "pascal-kienast",
      contactConsent: false,
    },
  ])("rejects invalid or unconsented input", (input) => {
    expect(() => ClosedBetaSignupInputSchema.parse(input)).toThrow();
  });
});
