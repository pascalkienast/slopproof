import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebRuntime } from "../../../../lib/runtime";
import { GET } from "./route";

vi.mock("../../../../lib/runtime", () => ({
  getWebRuntime: vi.fn(),
}));

const getWebRuntimeMock = vi.mocked(getWebRuntime);

function healthyRuntime() {
  const query = vi.fn(async (rawSql: string) => {
    const sql = String(rawSql);
    if (sql === "SELECT 1::integer AS database_ok") {
      return { rows: [{ database_ok: 1 }] };
    }
    if (sql.includes("to_regclass('pgboss.version')")) {
      return { rows: [{ queue_version_table: "pgboss.version" }] };
    }
    if (sql.includes("FROM pgboss.version")) {
      return { rows: [{ version: 41 }] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return {
    config: {
      DEPLOYMENT_PROFILE: "local",
      GITHUB_CONTROL_INTERNAL_URL: undefined,
    },
    database: { pool: { connect: vi.fn(async () => client) } },
    storage: { assertBucketAccessible: vi.fn(async () => undefined) },
  };
}

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    getWebRuntimeMock.mockReset();
  });

  it("returns only readiness state when every capability is healthy", async () => {
    getWebRuntimeMock.mockResolvedValue(healthyRuntime() as never);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ready"}');
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("fails closed without exposing runtime failure detail", async () => {
    getWebRuntimeMock.mockRejectedValue(
      new Error("postgres://user:password@private-host/secret-db"),
    );

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"status":"unavailable"}');
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
