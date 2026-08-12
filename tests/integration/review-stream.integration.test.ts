import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import { writeEvidenceStreamAudit } from "../../apps/worker/src/review-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe("review evidence audit persistence", () => {
  let database: DatabaseConnection;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  it("binds capability metadata as PostgreSQL text", async () => {
    const attemptId = randomUUID();
    const capabilityJti = randomUUID();
    await writeEvidenceStreamAudit(
      (sql, values) => database.pool.query(sql, values),
      {
        actorId: "integration-reviewer",
        action: "evidence.stream.started",
        attemptId,
        capabilityJti,
      },
    );

    const result = await database.pool.query<{
      actor_id: string;
      capability_jti: string;
    }>(
      `SELECT actor_id, metadata ->> 'capabilityJti' AS capability_jti
         FROM audit_events
        WHERE action = 'evidence.stream.started'
          AND object_id = $1`,
      [attemptId],
    );
    expect(result.rows).toEqual([
      { actor_id: "integration-reviewer", capability_jti: capabilityJti },
    ]);
  });
});
