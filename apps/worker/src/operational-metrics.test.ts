import type { IncomingMessage, ServerResponse } from "node:http";
import { JOB_NAMES, type DatabaseConnection } from "@understandproof/db";
import { describe, expect, it, vi } from "vitest";
import {
  collectOperationalMetricsSnapshot,
  handleOperationalMetricsRequest,
} from "./operational-metrics";

const SECRET = "operational-metrics-test-secret-000000000000";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const PURPOSES = [
  "learning_material",
  "practice_feedback",
  "proof_questions",
] as const;
const OUTCOMES = ["generated", "repaired", "fallback"] as const;
const BUCKETS = [1_000, 5_000, 15_000, 60_000, 300_000, 900_000] as const;
const PRIVATE_STAGES = ["speech_to_text", "multimodal_judge"] as const;

describe("evidence-free operational metrics", () => {
  it("collects only fixed-cardinality aggregate dimensions inside a bounded read-only transaction", async () => {
    const fixture = databaseFixture(metricRows());

    const snapshot = await collectOperationalMetricsSnapshot({
      database: fixture.database,
      now: () => NOW,
      timeoutMs: 1_000,
    });

    expect(snapshot.schemaVersion).toBe("1");
    expect(snapshot.generatedAt).toBe(NOW.toISOString());
    expect(snapshot.windowSeconds).toBe(3_600);
    expect(snapshot.queue).toHaveLength(JOB_NAMES.length);
    expect(snapshot.providers.outcomes).toHaveLength(9);
    expect(snapshot.providers.latencyBuckets).toHaveLength(18);
    expect(snapshot.providers.privateOutcomes).toEqual([
      {
        stage: "speech_to_text",
        outcome: "artifact_persisted",
        count: 3,
      },
      {
        stage: "multimodal_judge",
        outcome: "artifact_persisted",
        count: 3,
      },
    ]);
    expect(snapshot.retention).toEqual({ due: 2, failed: 1, shredded: 7 });
    expect(snapshot.githubCheckReconciliation).toEqual({
      pending: 3,
      retry: 4,
      terminal: 1,
    });
    expect(fixture.release).toHaveBeenCalledWith(false);

    const calls = fixture.query.mock.calls;
    expect(calls[0]?.[0]).toEqual(
      expect.objectContaining({ text: "BEGIN READ ONLY" }),
    );
    const aggregate = calls.find(
      (call) =>
        typeof call[0] === "object" && call[0].text.includes("approved_jobs"),
    )?.[0];
    expect(aggregate).toEqual(
      expect.objectContaining({
        values: [JOB_NAMES, NOW, new Date("2026-08-13T11:00:00.000Z")],
        query_timeout: expect.any(Number),
      }),
    );
    const sql = typeof aggregate === "object" ? aggregate.text : "";
    expect(sql).not.toMatch(
      /\b(?:data|metadata|object_key|object_id|head_sha|repository_id|actor_id|input_hash|output_hash|encrypted_payload)\b/iu,
    );
    expect(sql).toContain("transcript.provider = 'openrouter'");
    expect(sql).toContain("sidecar.provider = 'hetzner-inference'");
    expect(sql).not.toMatch(/(?:transcript|sidecar)\.encrypted_payload/iu);
  });

  it("requires the internal bearer before touching PostgreSQL", async () => {
    const connect = vi.fn();
    const output = responseFixture();

    await expect(
      handleOperationalMetricsRequest(
        requestFixture("GET", "/internal/metrics", "Bearer wrong-secret"),
        output.response,
        {
          database: { pool: { connect } } as unknown as DatabaseConnection,
          bearerSecret: SECRET,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(true);

    expect(output.status).toBe(401);
    expect(output.headers["cache-control"]).toBe("no-store");
    expect(output.headers["www-authenticate"]).toBe("Bearer");
    expect(JSON.parse(output.body)).toEqual({ error: "unauthorized" });
    expect(connect).not.toHaveBeenCalled();
    expect(output.body).not.toContain(SECRET);
  });

  it("returns a no-store bounded snapshot with no evidence, identity, repository, SHA, content or secret fields", async () => {
    const fixture = databaseFixture(metricRows());
    const output = responseFixture();

    await handleOperationalMetricsRequest(
      requestFixture("GET", "/internal/metrics", `Bearer ${SECRET}`),
      output.response,
      {
        database: fixture.database,
        bearerSecret: SECRET,
        now: () => NOW,
      },
    );

    expect(output.status).toBe(200);
    expect(output.headers["cache-control"]).toBe("no-store");
    expect(output.headers["x-content-type-options"]).toBe("nosniff");
    expect(Number(output.headers["content-length"])).toBeLessThan(64 * 1_024);
    const body = JSON.parse(output.body) as unknown;
    expect(body).toEqual(
      expect.objectContaining({
        schemaVersion: "1",
        generatedAt: NOW.toISOString(),
      }),
    );
    const keys = allKeys(body);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        "evidence",
        "sha",
        "headSha",
        "repository",
        "repositoryId",
        "actor",
        "actorId",
        "user",
        "content",
        "payload",
        "data",
        "request",
        "response",
        "model",
        "secret",
        "token",
        "url",
      ]),
    );
    expect(keys.join("\n")).not.toMatch(
      /(?:evidence|sha|repo|actor|identity|user|content|payload|data|request|response|transcript|frame|video|answer|model|secret|token|url)/iu,
    );
    expect(output.body).not.toContain(SECRET);
    expect(output.body).not.toMatch(/[0-9a-f]{40}/u);
    expect(output.body).not.toContain("private transcript content");
  });

  it("fails closed when PostgreSQL returns a label outside the allowlist", async () => {
    const rows = metricRows();
    const provider = rows.find(
      (row) => row.metric_group === "provider_outcome",
    );
    if (!provider) throw new Error("provider fixture is missing");
    provider.dimension_b = "unknown_upstream_outcome";
    const fixture = databaseFixture(rows);
    const output = responseFixture();

    await handleOperationalMetricsRequest(
      requestFixture("GET", "/internal/metrics", `Bearer ${SECRET}`),
      output.response,
      {
        database: fixture.database,
        bearerSecret: SECRET,
        now: () => NOW,
      },
    );

    expect(output.status).toBe(503);
    expect(JSON.parse(output.body)).toEqual({ error: "metrics_unavailable" });
    expect(output.body).not.toContain("unknown_upstream_outcome");
    // The read-only transaction committed before the untrusted row shape was
    // rejected, so the connection itself remains safe to reuse.
    expect(fixture.release).toHaveBeenCalledWith(false);
  });

  it("bounds pool acquisition and returns only a generic availability error", async () => {
    const connect = vi.fn(() => new Promise<never>(() => undefined));
    const output = responseFixture();
    const started = performance.now();

    await handleOperationalMetricsRequest(
      requestFixture("GET", "/internal/metrics", `Bearer ${SECRET}`),
      output.response,
      {
        database: { pool: { connect } } as unknown as DatabaseConnection,
        bearerSecret: SECRET,
        now: () => NOW,
        timeoutMs: 20,
      },
    );

    expect(performance.now() - started).toBeLessThan(250);
    expect(output.status).toBe(503);
    expect(JSON.parse(output.body)).toEqual({ error: "metrics_unavailable" });
  });

  it("does not claim requests outside the exact internal route", async () => {
    const connect = vi.fn();
    const output = responseFixture();
    await expect(
      handleOperationalMetricsRequest(
        requestFixture(
          "GET",
          "/internal/metrics?attemptId=private",
          `Bearer ${SECRET}`,
        ),
        output.response,
        {
          database: { pool: { connect } } as unknown as DatabaseConnection,
          bearerSecret: SECRET,
        },
      ),
    ).resolves.toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});

type MutableMetricRow = {
  metric_group: string;
  dimension_a: string | null;
  dimension_b: string | null;
  bucket_le_ms: number | null;
  value_a: number;
  value_b: number | null;
  value_c: number | null;
};

function metricRows(): MutableMetricRow[] {
  const queue = JOB_NAMES.map((name, index) => ({
    metric_group: "queue",
    dimension_a: name,
    dimension_b: null,
    bucket_le_ms: null,
    value_a: index,
    value_b: index === 1 ? 1 : 0,
    value_c: index === 2 ? 1 : 0,
  }));
  const outcomes = PURPOSES.flatMap((purpose) =>
    OUTCOMES.map((outcome, index) => ({
      metric_group: "provider_outcome",
      dimension_a: purpose,
      dimension_b: outcome,
      bucket_le_ms: null,
      value_a: index,
      value_b: null,
      value_c: null,
    })),
  );
  const latency = PURPOSES.flatMap((purpose) =>
    BUCKETS.map((bucket, index) => ({
      metric_group: "provider_latency",
      dimension_a: purpose,
      dimension_b: null,
      bucket_le_ms: bucket,
      value_a: index,
      value_b: null,
      value_c: null,
    })),
  );
  const privateOutcomes = PRIVATE_STAGES.map((stage) => ({
    metric_group: "private_provider_outcome",
    dimension_a: stage,
    dimension_b: "artifact_persisted",
    bucket_le_ms: null,
    value_a: 3,
    value_b: null,
    value_c: null,
  }));
  return [
    ...queue,
    ...outcomes,
    ...latency,
    ...privateOutcomes,
    {
      metric_group: "retention",
      dimension_a: null,
      dimension_b: null,
      bucket_le_ms: null,
      value_a: 2,
      value_b: 1,
      value_c: 7,
    },
    {
      metric_group: "github_check_reconciliation",
      dimension_a: null,
      dimension_b: null,
      bucket_le_ms: null,
      value_a: 3,
      value_b: 4,
      value_c: 1,
    },
  ];
}

function databaseFixture(rows: MutableMetricRow[]) {
  const query = vi.fn(async (input: { text: string }) => ({
    rows: input.text.includes("approved_jobs") ? rows : [],
    rowCount: input.text.includes("approved_jobs") ? rows.length : 0,
  }));
  const release = vi.fn();
  const database = {
    pool: {
      connect: vi.fn(async () => ({ query, release })),
    },
  } as unknown as DatabaseConnection;
  return { database, query, release };
}

function requestFixture(
  method: string,
  url: string,
  authorization?: string,
): IncomingMessage {
  return {
    method,
    url,
    headers: authorization ? { authorization } : {},
  } as IncomingMessage;
}

function responseFixture() {
  let status = 0;
  let body = "";
  let headers: Record<string, string> = {};
  const response = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
      status = nextStatus;
      headers = nextHeaders;
      return response;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      return response;
    },
  } as unknown as ServerResponse;
  return {
    response,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => allKeys(entry));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...allKeys(entry),
  ]);
}
