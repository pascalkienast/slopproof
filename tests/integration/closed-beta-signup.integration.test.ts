import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistClosedBetaSignup } from "../../apps/web/lib/closed-beta-signup";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe("closed beta signup queue", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
    await migrateDatabase(connection.pool);
  });

  beforeEach(async () => {
    await connection.pool.query(
      `TRUNCATE TABLE closed_beta_signups, installations,
         github_app_account_allowlist CASCADE`,
    );
  });

  afterAll(async () => {
    await connection.pool.query(
      `TRUNCATE TABLE closed_beta_signups, installations,
         github_app_account_allowlist CASCADE`,
    );
    await connection.close();
  });

  it("stores one non-enumerating queue row per email and GitHub login", async () => {
    const first = await persistClosedBetaSignup(connection.pool, {
      email: "Pascal@Example.COM",
      githubUsername: "@Pascal-Kienast",
      contactConsent: true,
    });
    const duplicate = await persistClosedBetaSignup(connection.pool, {
      email: "pascal@example.com",
      githubUsername: "pascal-kienast",
      contactConsent: true,
    });

    expect(first).toEqual({ accepted: true, stored: true });
    expect(duplicate).toEqual({ accepted: true, stored: false });
    await expect(
      connection.pool.query(
        `SELECT email, github_username, status, contact_consent_version,
                github_account_id, decided_at
           FROM closed_beta_signups`,
      ),
    ).resolves.toMatchObject({
      rowCount: 1,
      rows: [
        {
          email: "pascal@example.com",
          github_username: "pascal-kienast",
          status: "pending",
          contact_consent_version: "closed-beta-v1",
          github_account_id: null,
          decided_at: null,
        },
      ],
    });
  });

  it("binds an admitted queue row to the immutable GitHub account id", async () => {
    await persistClosedBetaSignup(connection.pool, {
      email: "pascal@example.com",
      githubUsername: "pascal-kienast",
      contactConsent: true,
    });

    await expect(
      connection.pool.query(
        `UPDATE closed_beta_signups
            SET status = 'admitted', github_account_id = '6682526',
                decided_at = now(), updated_at = now()
          WHERE github_username = 'pascal-kienast'`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      connection.pool.query(
        `UPDATE closed_beta_signups
            SET status = 'pending'
          WHERE github_username = 'pascal-kienast'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.pool.query(
        `UPDATE closed_beta_signups
            SET github_account_id = 'mutable-login'
          WHERE github_username = 'pascal-kienast'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("activates personal and organization installs created by the admitted user", async () => {
    await persistClosedBetaSignup(connection.pool, {
      email: "pascal@example.com",
      githubUsername: "pascal-kienast",
      contactConsent: true,
    });
    await connection.pool.query(
      `INSERT INTO installations
         (github_installation_id, account_id, account_login,
          installer_account_id, status)
       VALUES
         ('101', '6682526', 'pascalkienast', '6682526', 'pending'),
         ('102', '7000001', 'example-org', '6682526', 'pending'),
         ('103', '7000002', 'other-org', '9000001', 'pending')`,
    );

    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      const admission = await client.query<{
        admitted_signup_count: string;
        activated_installation_count: string;
      }>(
        `WITH admitted AS (
           UPDATE closed_beta_signups
              SET github_account_id = '6682526', status = 'admitted',
                  decided_at = now(), updated_at = now()
            WHERE github_username = 'pascal-kienast'
              AND status IN ('pending', 'contacted')
           RETURNING github_account_id
         ), allowlisted AS (
           INSERT INTO github_app_account_allowlist
             (github_account_id, status)
           SELECT github_account_id, 'active' FROM admitted
           ON CONFLICT (github_account_id) DO UPDATE SET
             status = 'active', updated_at = now()
           RETURNING github_account_id
         ), activated AS (
           UPDATE installations
              SET status = 'active', suspended_at = NULL, removed_at = NULL,
                  updated_at = now()
            WHERE status = 'pending'
              AND EXISTS (
                SELECT 1 FROM allowlisted
                 WHERE installations.account_id = allowlisted.github_account_id
                    OR installations.installer_account_id = allowlisted.github_account_id
              )
           RETURNING github_installation_id
         )
         SELECT (SELECT count(*) FROM admitted)::text AS admitted_signup_count,
                (SELECT count(*) FROM activated)::text AS activated_installation_count`,
      );
      expect(admission.rows[0]).toEqual({
        admitted_signup_count: "1",
        activated_installation_count: "2",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(
      connection.pool.query(
        `SELECT github_installation_id, status
           FROM installations
          ORDER BY github_installation_id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { github_installation_id: "101", status: "active" },
        { github_installation_id: "102", status: "active" },
        { github_installation_id: "103", status: "pending" },
      ],
    });
  });
});
