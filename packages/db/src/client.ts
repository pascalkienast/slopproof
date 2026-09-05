import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type UnderstandProofDatabase = NodePgDatabase<typeof schema>;

export type DatabaseConnection = {
  pool: Pool;
  db: UnderstandProofDatabase;
  close(): Promise<void>;
};

export function connectDatabase(
  config: string | PoolConfig,
): DatabaseConnection {
  const pool = new Pool(
    typeof config === "string" ? { connectionString: config } : config,
  );
  return {
    pool,
    db: drizzle(pool, { schema }),
    async close() {
      await pool.end();
    },
  };
}

export async function migrateDatabase(
  pool: Pool,
  migrationsDirectory = join(process.cwd(), "packages", "db", "migrations"),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(736_567_001)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _slopproof_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const source = await readFile(join(migrationsDirectory, name), "utf8");
      const sha256 = createHash("sha256").update(source).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM _slopproof_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${name} has changed`);
        }
        continue;
      }
      await client.query(source);
      await client.query(
        "INSERT INTO _slopproof_migrations (name, sha256) VALUES ($1, $2)",
        [name, sha256],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
