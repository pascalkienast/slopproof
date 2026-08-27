import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  loadSealedMaintainerDirectory,
  resolveProductionIdentifyDirectory,
} from "../../apps/web/lib/maintainer-directory";
import type { WebRuntime } from "../../apps/web/lib/runtime";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const SESSION_SECRET = "production-session-secret-that-is-at-least-32-bytes";
const NOW = new Date("2026-08-27T12:00:00.000Z");
const KEPT_REPOSITORY_ID = "91000000-0000-4000-8000-000000000001";
const KEPT_INSTALLATION_ID = "91000000-0000-4000-8000-000000000010";
const KEPT_INSTALLATION_GITHUB_ID = "91001";

databaseDescribe("inverted maintainer Identify", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
  });

  afterAll(async () => {
    if (connection) await connection.close();
  });

  beforeEach(async () => {
    await connection.pool.query(`
      TRUNCATE TABLE
        github_oauth_flows, auth_sessions, repositories, installations,
        github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
  });

  it("identifies one maintained repo when the host has more than 32 active tenants", async () => {
    for (let index = 0; index < 40; index += 1) {
      const githubInstallationId = String(91_001 + index);
      const githubRepositoryId = String(92_001 + index);
      const accountId = String(93_001 + index);
      const installation = await connection.pool.query<{ id: string }>(
        index === 0
          ? `INSERT INTO installations
               (id, github_installation_id, account_id, account_login, status)
             VALUES ($1, $2, $3, $4, 'active')
             RETURNING id`
          : `INSERT INTO installations
               (github_installation_id, account_id, account_login, status)
             VALUES ($1, $2, $3, 'active')
             RETURNING id`,
        index === 0
          ? [
              KEPT_INSTALLATION_ID,
              githubInstallationId,
              accountId,
              `tenant-${index}`,
            ]
          : [githubInstallationId, accountId, `tenant-${index}`],
      );
      await connection.pool.query(
        index === 0
          ? `INSERT INTO repositories
               (id, installation_id, github_repository_id, owner, name,
                default_branch, status)
             VALUES ($1, $2, $3, $4, $5, 'main', 'active')`
          : `INSERT INTO repositories
               (installation_id, github_repository_id, owner, name,
                default_branch, status)
             VALUES ($1, $2, $3, $4, 'main', 'active')`,
        index === 0
          ? [
              KEPT_REPOSITORY_ID,
              installation.rows[0]!.id,
              githubRepositoryId,
              `tenant-${index}`,
              "kept-repo",
            ]
          : [
              installation.rows[0]!.id,
              githubRepositoryId,
              `tenant-${index}`,
              `other-${index}`,
            ],
      );
    }

    const hostActive = await connection.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM repositories repository
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE repository.status = 'active'
          AND installation.status = 'active'`,
    );
    expect(hostActive.rows[0]?.count).toBeGreaterThan(32);

    const app = {
      config: {
        DEPLOYMENT_PROFILE: "production",
        GITHUB_ADAPTER: "octokit",
        DEMO_MODE: false,
        SESSION_SECRET,
      },
      database: { pool: connection.pool },
    } as unknown as WebRuntime;

    const identified = await resolveProductionIdentifyDirectory(
      app,
      {
        user: { githubUserId: "94001", login: "maintainer" },
        accessToken: "request-scoped-user-token",
        now: NOW,
      },
      {
        authorizationPort: {
          getAuthenticatedUser: vi.fn(async () => ({
            id: "94001",
            login: "maintainer",
          })),
          getCollaboratorPermission: vi.fn(async (input) => {
            if (input.repositoryName === "kept-repo") {
              return { permission: "admin" as const, roleName: "admin" };
            }
            throw new Error("must not walk every host tenant");
          }),
          listAccessibleAppInstallations: vi.fn(async () => [
            KEPT_INSTALLATION_GITHUB_ID,
          ]),
        },
      },
    );

    expect(identified).not.toBeNull();
    await expect(
      loadSealedMaintainerDirectory(app, identified!.sealedCookie, NOW),
    ).resolves.toEqual([
      {
        id: KEPT_REPOSITORY_ID,
        owner: "tenant-0",
        name: "kept-repo",
      },
    ]);
  });

  it("identifies a late-sorted maintained repo when one install has more than 32 active repos", async () => {
    const installation = await connection.pool.query<{ id: string }>(
      `INSERT INTO installations
         (id, github_installation_id, account_id, account_login, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [KEPT_INSTALLATION_ID, KEPT_INSTALLATION_GITHUB_ID, "93001", "acme"],
    );
    const kept = {
      id: KEPT_REPOSITORY_ID,
      owner: "acme",
      name: "zzz-kept",
    };
    for (let index = 0; index < 39; index += 1) {
      await connection.pool.query(
        `INSERT INTO repositories
           (installation_id, github_repository_id, owner, name,
            default_branch, status)
         VALUES ($1, $2, $3, $4, 'main', 'active')`,
        [
          installation.rows[0]!.id,
          String(92_001 + index),
          "acme",
          `aaa-${String(index).padStart(2, "0")}`,
        ],
      );
    }
    await connection.pool.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name,
          default_branch, status)
       VALUES ($1, $2, $3, $4, $5, 'main', 'active')`,
      [kept.id, installation.rows[0]!.id, "92040", kept.owner, kept.name],
    );

    const app = {
      config: {
        DEPLOYMENT_PROFILE: "production",
        GITHUB_ADAPTER: "octokit",
        DEMO_MODE: false,
        SESSION_SECRET,
      },
      database: { pool: connection.pool },
    } as unknown as WebRuntime;

    const identified = await resolveProductionIdentifyDirectory(
      app,
      {
        user: { githubUserId: "94001", login: "maintainer" },
        accessToken: "request-scoped-user-token",
        now: NOW,
      },
      {
        authorizationPort: {
          getAuthenticatedUser: vi.fn(async () => ({
            id: "94001",
            login: "maintainer",
          })),
          getCollaboratorPermission: vi.fn(async (input) => {
            if (input.repositoryName === kept.name) {
              return { permission: "admin" as const, roleName: "admin" };
            }
            return { permission: "read" as const, roleName: "read" };
          }),
          listAccessibleAppInstallations: vi.fn(async () => [
            KEPT_INSTALLATION_GITHUB_ID,
          ]),
        },
      },
    );

    expect(identified).not.toBeNull();
    await expect(
      loadSealedMaintainerDirectory(app, identified!.sealedCookie, NOW),
    ).resolves.toEqual([kept]);
  });
});
