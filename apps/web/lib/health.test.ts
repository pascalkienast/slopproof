import { describe, expect, it, vi } from "vitest";
import {
  checkReadiness,
  healthJsonResponse,
  type ReadinessRuntime,
} from "./health";

type ReadinessClient = Awaited<
  ReturnType<ReadinessRuntime["database"]["pool"]["connect"]>
>;

function queryResult(rows: unknown[]) {
  return { rows, rowCount: rows.length };
}

function databaseFixture(
  override?: (sql: string) => Promise<unknown>,
): Readonly<{
  client: ReadinessClient;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}> {
  const query = vi.fn(async (rawSql: string) => {
    const sql = String(rawSql);
    if (override) {
      const overridden = await override(sql);
      if (overridden !== undefined) return overridden;
    }
    if (sql === "SELECT 1::integer AS database_ok") {
      return queryResult([{ database_ok: 1 }]);
    }
    if (sql.includes("to_regclass('pgboss.version')")) {
      return queryResult([{ queue_version_table: "pgboss.version" }]);
    }
    if (sql.includes("FROM pgboss.version")) {
      return queryResult([{ version: 41 }]);
    }
    return queryResult([]);
  });
  const release = vi.fn();
  return {
    client: {
      query: query as unknown as ReadinessClient["query"],
      release,
    },
    query,
    release,
  };
}

function runtimeFixture(
  overrides: Partial<{
    connect: ReadinessRuntime["database"]["pool"]["connect"];
    storage: ReadinessRuntime["storage"]["assertBucketAccessible"];
  }> = {},
): ReadinessRuntime {
  const database = databaseFixture();
  return {
    config: {
      DEPLOYMENT_PROFILE: "local",
      GITHUB_CONTROL_INTERNAL_URL: undefined,
    },
    database: {
      pool: {
        connect: overrides.connect ?? (async () => database.client),
      },
    },
    storage: {
      assertBucketAccessible: overrides.storage ?? vi.fn(async () => undefined),
    },
  };
}

describe("health responses", () => {
  it("returns a strict, non-cacheable and detail-free JSON contract", async () => {
    const response = healthJsonResponse("unavailable", 503);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("readiness capability checks", () => {
  it("bounds DB and pg-boss checks in one dedicated transaction", async () => {
    const database = databaseFixture();
    const connect = vi.fn(async () => database.client);
    const storage = vi.fn<
      ReadinessRuntime["storage"]["assertBucketAccessible"]
    >(async () => undefined);

    await expect(
      checkReadiness({
        loadRuntime: async () => runtimeFixture({ connect, storage }),
        timeoutMs: 100,
      }),
    ).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(database.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringMatching(/^SET LOCAL statement_timeout = '\d+ms'$/u),
      expect.stringMatching(/^SET LOCAL lock_timeout = '\d+ms'$/u),
      "SELECT 1::integer AS database_ok",
      "SELECT to_regclass('pgboss.version')::text AS queue_version_table",
      "SELECT version::integer AS version FROM pgboss.version LIMIT 1",
      "ROLLBACK",
    ]);
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith(false);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(storage.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
  });

  it("fails closed on database acquisition, queue schema, or storage failure", async () => {
    const acquisitionFailure = runtimeFixture({
      connect: vi.fn(async () => Promise.reject(new Error("database secret"))),
    });
    await expect(
      checkReadiness({
        loadRuntime: async () => acquisitionFailure,
        timeoutMs: 100,
      }),
    ).resolves.toBe(false);

    const missingQueue = databaseFixture(async (sql) =>
      sql.includes("to_regclass('pgboss.version')")
        ? queryResult([{ queue_version_table: null }])
        : undefined,
    );
    await expect(
      checkReadiness({
        loadRuntime: async () =>
          runtimeFixture({ connect: async () => missingQueue.client }),
        timeoutMs: 100,
      }),
    ).resolves.toBe(false);
    expect(missingQueue.release).toHaveBeenCalledWith(true);

    await expect(
      checkReadiness({
        loadRuntime: async () =>
          runtimeFixture({
            storage: vi.fn(async () =>
              Promise.reject(new Error("bucket secret")),
            ),
          }),
        timeoutMs: 100,
      }),
    ).resolves.toBe(false);
  });

  it("requires the exact value-free GitHub Control contract in production", async () => {
    const runtime = runtimeFixture();
    runtime.config = {
      DEPLOYMENT_PROFILE: "production",
      GITHUB_CONTROL_INTERNAL_URL: "http://github-control:4002/healthz",
    };
    const fetchInternal = vi.fn(async () =>
      Promise.resolve(
        new Response('{"status":"ok"}', {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 200,
        }),
      ),
    );

    await expect(
      checkReadiness({
        fetchInternal,
        loadRuntime: async () => runtime,
        timeoutMs: 100,
      }),
    ).resolves.toBe(true);
    expect(fetchInternal).toHaveBeenCalledOnce();
    expect(fetchInternal).toHaveBeenCalledWith(
      "http://github-control:4002/healthz",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );

    for (const response of [
      new Response('{"status":"starting"}', {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      new Response('{"status":"ok"}', {
        headers: { "content-type": "text/plain" },
        status: 200,
      }),
      new Response('{"status":"ok"}', {
        headers: { "content-type": "application/json" },
        status: 503,
      }),
      new Response("x".repeat(65), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ]) {
      await expect(
        checkReadiness({
          fetchInternal: vi.fn(async () => response),
          loadRuntime: async () => runtime,
          timeoutMs: 100,
        }),
      ).resolves.toBe(false);
    }
  });

  it("aborts a stalled GitHub Control fetch at the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const runtime = runtimeFixture();
      runtime.config = {
        DEPLOYMENT_PROFILE: "production",
        GITHUB_CONTROL_INTERNAL_URL: "http://github-control:4002/healthz",
      };
      let observedSignal: AbortSignal | undefined;
      const fetchInternal = vi.fn<typeof fetch>(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        await new Promise(() => undefined);
        throw new Error("unreachable");
      });
      const result = checkReadiness({
        fetchInternal,
        loadRuntime: async () => runtime,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe(false);
      expect(observedSignal?.aborted).toBe(true);
      expect(fetchInternal).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled GitHub Control body reader at the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const runtime = runtimeFixture();
      runtime.config = {
        DEPLOYMENT_PROFILE: "production",
        GITHUB_CONTROL_INTERNAL_URL: "http://github-control:4002/healthz",
      };
      let cancelCalled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelCalled = true;
        },
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{"status":'));
        },
      });
      const result = checkReadiness({
        fetchInternal: vi.fn(async () =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
          ),
        ),
        loadRuntime: async () => runtime,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelCalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled runtime and does not start late capability probes", async () => {
    vi.useFakeTimers();
    try {
      let resolveRuntime: ((runtime: ReadinessRuntime) => void) | undefined;
      const lateRuntime = new Promise<ReadinessRuntime>((resolve) => {
        resolveRuntime = resolve;
      });
      const connect = vi.fn(async () => databaseFixture().client);
      const storage = vi.fn(async () => undefined);
      const result = checkReadiness({
        loadRuntime: async () => lateRuntime,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe(false);
      resolveRuntime?.(runtimeFixture({ connect, storage }));
      await Promise.resolve();

      expect(connect).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates stalled acquisition and destroys a client that arrives late", async () => {
    vi.useFakeTimers();
    try {
      let resolveClient: ((client: ReadinessClient) => void) | undefined;
      const acquisition = new Promise<ReadinessClient>((resolve) => {
        resolveClient = resolve;
      });
      const connect = vi.fn(async () => acquisition);
      const runtime = runtimeFixture({ connect });
      const first = checkReadiness({
        loadRuntime: async () => runtime,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toBe(false);
      await expect(
        checkReadiness({ loadRuntime: async () => runtime, timeoutMs: 25 }),
      ).resolves.toBe(false);
      expect(connect).toHaveBeenCalledTimes(1);

      const late = databaseFixture();
      resolveClient?.(late.client);
      await Promise.resolve();
      await Promise.resolve();

      expect(late.query).not.toHaveBeenCalled();
      expect(late.release).toHaveBeenCalledOnce();
      expect(late.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a stalled query, suppresses overlap, and resumes after late settlement", async () => {
    vi.useFakeTimers();
    try {
      let resolveDatabaseQuery:
        ((value: ReturnType<typeof queryResult>) => void) | undefined;
      const stalledQuery = new Promise<ReturnType<typeof queryResult>>(
        (resolve) => {
          resolveDatabaseQuery = resolve;
        },
      );
      const stalled = databaseFixture(async (sql) =>
        sql === "SELECT 1::integer AS database_ok" ? stalledQuery : undefined,
      );
      const healthy = databaseFixture();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(stalled.client)
        .mockResolvedValueOnce(healthy.client);
      const runtime = runtimeFixture({ connect });
      const first = checkReadiness({
        loadRuntime: async () => runtime,
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        stalled.query.mock.calls.some(
          ([sql]) => String(sql) === "SELECT 1::integer AS database_ok",
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toBe(false);
      expect(stalled.release).toHaveBeenCalledOnce();
      expect(stalled.release).toHaveBeenCalledWith(true);
      await expect(
        checkReadiness({ loadRuntime: async () => runtime, timeoutMs: 25 }),
      ).resolves.toBe(false);
      expect(connect).toHaveBeenCalledTimes(1);

      resolveDatabaseQuery?.(queryResult([{ database_ok: 1 }]));
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        checkReadiness({ loadRuntime: async () => runtime, timeoutMs: 25 }),
      ).resolves.toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(stalled.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts storage when the overall readiness deadline expires", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const result = checkReadiness({
        loadRuntime: async () =>
          runtimeFixture({
            storage: vi.fn(async (signal) => {
              observedSignal = signal;
              await new Promise(() => undefined);
            }),
          }),
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe(false);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid internal deadline configuration", async () => {
    await expect(
      checkReadiness({
        loadRuntime: async () => runtimeFixture(),
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
