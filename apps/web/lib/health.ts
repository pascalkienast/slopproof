import { NextResponse } from "next/server";
import type { WebConfig } from "@slopproof/config";
import type { PoolClient } from "pg";

export const HEALTH_RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
} as const;

export const READINESS_TIMEOUT_MS = 2_000;

type ReadinessDatabaseClient = Pick<PoolClient, "query" | "release">;
type ReadinessDatabasePool = {
  connect(): Promise<ReadinessDatabaseClient>;
};

export type ReadinessRuntime = {
  config: Pick<WebConfig, "DEPLOYMENT_PROFILE" | "GITHUB_CONTROL_INTERNAL_URL">;
  database: {
    pool: ReadinessDatabasePool;
  };
  storage: {
    assertBucketAccessible(abortSignal?: AbortSignal): Promise<void>;
  };
};

export type ReadinessDependencies = {
  loadRuntime(): Promise<ReadinessRuntime>;
  fetchInternal?: typeof fetch;
  timeoutMs?: number;
};

type ActiveDatabaseProbe = Readonly<{ cleanup: Promise<void> }>;

// A timed-out pool acquisition cannot be removed through node-postgres' public
// API. Keep one late-cleanup lease per pool so repeated health requests cannot
// accumulate pending acquisitions while the shared pool is exhausted.
const activeDatabaseProbes = new WeakMap<
  ReadinessDatabasePool,
  ActiveDatabaseProbe
>();

export function healthJsonResponse(
  status: "ok" | "ready" | "unavailable",
  httpStatus = 200,
): NextResponse {
  return NextResponse.json(
    { status },
    { status: httpStatus, headers: HEALTH_RESPONSE_HEADERS },
  );
}

/**
 * Performs evidence-free capability checks behind one absolute deadline.
 * Failure detail is deliberately collapsed to a boolean for the public route.
 */
export async function checkReadiness(
  dependencies: ReadinessDependencies,
): Promise<boolean> {
  const timeoutMs = dependencies.timeoutMs ?? READINESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new RangeError("Readiness timeout is outside the supported range");
  }

  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Readiness deadline exceeded"));
    }, timeoutMs);
  });

  const checks = (async () => {
    const runtime = await dependencies.loadRuntime();
    if (controller.signal.aborted) {
      throw new Error("Readiness deadline exceeded");
    }

    await Promise.all([
      checkDatabaseAndQueue(
        runtime.database.pool,
        controller.signal,
        deadlineAt,
      ),
      runtime.storage.assertBucketAccessible(controller.signal),
      checkGithubControl(
        runtime.config,
        controller.signal,
        dependencies.fetchInternal ?? fetch,
      ),
    ]);
  })();

  try {
    await Promise.race([checks, deadline]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function checkGithubControl(
  config: ReadinessRuntime["config"],
  signal: AbortSignal,
  fetchInternal: typeof fetch,
): Promise<void> {
  if (config.DEPLOYMENT_PROFILE !== "production") return;
  if (!config.GITHUB_CONTROL_INTERNAL_URL) {
    throw new Error("GitHub Control readiness capability is unavailable");
  }

  const response = await raceWithAbort(
    fetchInternal(config.GITHUB_CONTROL_INTERNAL_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      signal,
    }),
    signal,
  );
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
  ) {
    throw new Error("GitHub Control readiness capability is unavailable");
  }

  const bytes = await readBoundedBody(response, 64, signal);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (body !== '{"status":"ok"}') {
    throw new Error("GitHub Control readiness capability is unavailable");
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new Error("GitHub Control readiness capability is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal);
      if (result.done) {
        complete = true;
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        throw new Error("GitHub Control readiness capability is unavailable");
      }
      chunks.push(result.value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function checkDatabaseAndQueue(
  pool: ReadinessDatabasePool,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  if (activeDatabaseProbes.has(pool)) {
    throw new Error("Database readiness probe is still being released");
  }

  const probe = startDatabaseAndQueueProbe(pool, signal, deadlineAt);
  const active = Object.freeze({ cleanup: probe.cleanup });
  activeDatabaseProbes.set(pool, active);
  void probe.cleanup.then(() => {
    if (activeDatabaseProbes.get(pool) === active) {
      activeDatabaseProbes.delete(pool);
    }
  });
  await probe.result;
}

function startDatabaseAndQueueProbe(
  pool: ReadinessDatabasePool,
  signal: AbortSignal,
  deadlineAt: number,
): Readonly<{ result: Promise<void>; cleanup: Promise<void> }> {
  let client: ReadinessDatabaseClient | undefined;
  let released = false;

  const release = (destroy: boolean): void => {
    if (!client || released) return;
    released = true;
    try {
      client.release(destroy);
    } catch {
      // A duplicate/failed pool release must not escape a public health probe.
    }
  };

  const operation = (async () => {
    client = await pool.connect();
    if (signal.aborted) {
      release(true);
      throw new Error("Readiness deadline exceeded");
    }

    const abort = () => release(true);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.query("BEGIN");
      requireBeforeDeadline(signal, deadlineAt);

      const serverTimeoutMilliseconds = remainingMilliseconds(deadlineAt);
      await client.query(
        `SET LOCAL statement_timeout = '${String(serverTimeoutMilliseconds)}ms'`,
      );
      await client.query(
        `SET LOCAL lock_timeout = '${String(serverTimeoutMilliseconds)}ms'`,
      );
      requireBeforeDeadline(signal, deadlineAt);

      const database = await client.query<{ database_ok: number }>(
        "SELECT 1::integer AS database_ok",
      );
      requireBeforeDeadline(signal, deadlineAt);
      if (database.rows[0]?.database_ok !== 1) {
        throw new Error("Database readiness capability is unavailable");
      }

      const queueTable = await client.query<{
        queue_version_table: string | null;
      }>("SELECT to_regclass('pgboss.version')::text AS queue_version_table");
      requireBeforeDeadline(signal, deadlineAt);
      if (queueTable.rows[0]?.queue_version_table === null) {
        throw new Error("Queue schema is unavailable");
      }

      const queueVersion = await client.query<{ version: number }>(
        "SELECT version::integer AS version FROM pgboss.version LIMIT 1",
      );
      requireBeforeDeadline(signal, deadlineAt);
      if (!Number.isSafeInteger(queueVersion.rows[0]?.version)) {
        throw new Error("Queue schema is unavailable");
      }

      await client.query("ROLLBACK");
      requireBeforeDeadline(signal, deadlineAt);
    } catch (error) {
      release(true);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      release(false);
    }
  })();

  return Object.freeze({
    result: raceWithAbort(operation, signal),
    cleanup: operation.then(
      () => undefined,
      () => undefined,
    ),
  });
}

function remainingMilliseconds(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new Error("Readiness deadline exceeded");
  }
  return Math.min(remaining, 10_000);
}

function requireBeforeDeadline(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) {
    throw new Error("Readiness deadline exceeded");
  }
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Readiness deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Readiness deadline exceeded"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
