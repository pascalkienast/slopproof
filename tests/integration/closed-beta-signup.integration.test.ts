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
    await connection.pool.query("DELETE FROM closed_beta_signups");
  });

  afterAll(async () => {
    await connection.pool.query("DELETE FROM closed_beta_signups");
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
});
