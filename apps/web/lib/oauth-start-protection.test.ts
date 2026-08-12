import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  consumeOAuthStartRateLimit,
  enforceProductionOAuthStartProtection,
  OAuthStartProtectionError,
  OAuthStartProtectionUnavailableError,
  OAuthStartRateLimitExceededError,
  trustedProxyHeaders,
  TRUSTED_PROXY_AUTHENTICATOR_HEADER,
} from "./oauth-start-protection";
import type { WebRuntime } from "./runtime";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const PROXY_SECRET = "proxy_authenticator_with_at_least_32_chars_12345";
const CLIENT_ADDRESS = "203.0.113.17";

type QueryHandler = (
  sql: string,
  parameters: readonly unknown[],
) => Promise<Partial<QueryResult<never>>>;

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
) {
  return { rows, rowCount } as unknown as QueryResult<never>;
}

function fakePool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) =>
    handler(sql, parameters),
  );
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, query, client };
}

function app(pool: Pool, profile: "local" | "production"): WebRuntime {
  return {
    config: {
      DEPLOYMENT_PROFILE: profile,
      APP_BASE_URL:
        profile === "production"
          ? "https://slopproof.example/"
          : "http://localhost:3000/",
      OAUTH_TRUSTED_PROXY_SECRET: PROXY_SECRET,
    },
    database: { pool },
  } as unknown as WebRuntime;
}

function startRequest(headers: Readonly<Record<string, string>> = {}): Request {
  return new Request("https://slopproof.example/api/auth/github/start", {
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      referer: "https://slopproof.example/review",
      ...trustedProxyHeaders(PROXY_SECRET, CLIENT_ADDRESS),
      ...headers,
    },
  });
}

describe("production OAuth start protection", () => {
  it("leaves the local/demo profile usable without proxy or browser metadata", async () => {
    const database = fakePool(async () => {
      throw new Error("local bypass must not access the database");
    });

    await expect(
      enforceProductionOAuthStartProtection(
        app(database.pool, "local"),
        new Request("http://localhost:3000/api/auth/github/start"),
        NOW,
      ),
    ).resolves.toBeUndefined();
    expect(database.pool.connect).not.toHaveBeenCalled();
  });

  it("accepts only same-origin traffic from the authenticated proxy and ignores spoofed XFF", async () => {
    const admittedParameters: Array<readonly unknown[]> = [];
    const database = fakePool(async (sql, parameters) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql.includes("pg_advisory_xact_lock") ||
        sql.includes("DELETE FROM oauth_start_rate_limits")
      ) {
        return result();
      }
      if (sql.includes("INSERT INTO oauth_start_rate_limits")) {
        admittedParameters.push(parameters);
        return result();
      }
      throw new Error("unexpected SQL in test");
    });

    await enforceProductionOAuthStartProtection(
      app(database.pool, "production"),
      startRequest({ "x-forwarded-for": "198.51.100.1" }),
      NOW,
    );
    await enforceProductionOAuthStartProtection(
      app(database.pool, "production"),
      startRequest({ "x-forwarded-for": "192.0.2.99, 10.0.0.1" }),
      NOW,
    );

    expect(admittedParameters).toHaveLength(2);
    expect(admittedParameters[0]?.[0]).toBe(admittedParameters[1]?.[0]);
    expect(admittedParameters[0]?.[0]).toMatch(/^[a-f0-9]{64}$/u);
    const persistedMaterial = JSON.stringify(admittedParameters);
    expect(persistedMaterial).not.toContain(CLIENT_ADDRESS);
    expect(persistedMaterial).not.toContain(PROXY_SECRET);
    expect(persistedMaterial).not.toContain("198.51.100.1");
    expect(persistedMaterial).not.toContain("192.0.2.99");
  });

  it.each([
    ["missing Fetch Metadata", { "sec-fetch-site": "" }],
    ["cross-site navigation", { "sec-fetch-site": "cross-site" }],
    ["foreign referrer", { referer: "https://evil.example/" }],
    ["missing proxy proof", { [TRUSTED_PROXY_AUTHENTICATOR_HEADER]: "" }],
    [
      "wrong proxy proof",
      { [TRUSTED_PROXY_AUTHENTICATOR_HEADER]: "w".repeat(48) },
    ],
    [
      "multi-valued client address",
      { "x-slopproof-client-ip": "1.2.3.4, 5.6.7.8" },
    ],
  ])("rejects %s before database access", async (_label, headers) => {
    const database = fakePool(async () => {
      throw new Error("rejected input must not access the database");
    });

    await expect(
      enforceProductionOAuthStartProtection(
        app(database.pool, "production"),
        startRequest(headers),
        NOW,
      ),
    ).rejects.toBeInstanceOf(OAuthStartProtectionError);
    expect(database.pool.connect).not.toHaveBeenCalled();
  });

  it("commits cleanup while returning a bounded retry interval at the client quota", async () => {
    const database = fakePool(async (sql, parameters) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql.includes("pg_advisory_xact_lock")
      ) {
        return result();
      }
      if (sql.includes("DELETE FROM oauth_start_rate_limits")) {
        expect(parameters).toEqual([NOW, 500]);
        return result([], 500);
      }
      if (sql.includes("INSERT INTO oauth_start_rate_limits")) {
        expect(parameters.slice(2, 4)).toEqual([4, 600]);
        return result([
          {
            client_count: 4,
            client_oldest: new Date(NOW.getTime() - 30_000),
            global_count: 4,
            global_oldest: new Date(NOW.getTime() - 30_000),
          },
        ]);
      }
      throw new Error("unexpected SQL in test");
    });

    await expect(
      consumeOAuthStartRateLimit(database.pool, "a".repeat(64), NOW),
    ).rejects.toMatchObject({
      name: "OAuthStartRateLimitExceededError",
      retryAfterSeconds: 270,
    });
    expect(database.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("DELETE FROM oauth_start_rate_limits"),
      expect.stringContaining("INSERT INTO oauth_start_rate_limits"),
      "COMMIT",
    ]);
    expect(database.query.mock.calls.map(([sql]) => sql)).not.toContain(
      "ROLLBACK",
    );
  });

  it("fails unavailable and rolls back when PostgreSQL cannot enforce the gate", async () => {
    const database = fakePool(async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return result();
      throw new Error("database unavailable");
    });

    await expect(
      consumeOAuthStartRateLimit(database.pool, "b".repeat(64), NOW),
    ).rejects.toBeInstanceOf(OAuthStartProtectionUnavailableError);
    expect(database.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  });

  it("exposes distinct policy and quota error classes", () => {
    expect(new OAuthStartProtectionError().code).toBe(
      "OAUTH_START_PROTECTION_REJECTED",
    );
    expect(new OAuthStartRateLimitExceededError(1).code).toBe(
      "OAUTH_START_RATE_LIMIT_EXCEEDED",
    );
  });
});
