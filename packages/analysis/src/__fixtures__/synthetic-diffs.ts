import type { PullRequestPatch } from "../schema";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

export const smallLocalFix: PullRequestPatch = {
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  files: [
    {
      path: "src/money/round-total.ts",
      kind: "text",
      additions: 1,
      deletions: 1,
      patch: [
        "@@ -8,1 +8,1 @@ export function roundTotal(value: number)",
        "-  return Math.floor(value * 100) / 100;",
        "+  return Math.round(value * 100) / 100;",
      ].join("\n"),
    },
  ],
};

export const mediumMultiComponentChange: PullRequestPatch = {
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  files: [
    {
      path: "apps/web/src/orders/route.ts",
      kind: "text",
      additions: 3,
      deletions: 1,
      patch: [
        "@@ -14,2 +14,4 @@ export async function POST(request: Request)",
        "-  return service.create(await request.json());",
        "+  const command = await request.json();",
        "+  const order = await service.create(command);",
        "+  return Response.json(order, { status: 201 });",
      ].join("\n"),
    },
    {
      path: "packages/orders/src/service.ts",
      kind: "text",
      additions: 3,
      deletions: 1,
      patch: [
        "@@ -20,2 +20,4 @@ export async function create(command: Command)",
        "-  return repository.insert(command);",
        "+  const normalized = normalize(command);",
        "+  await events.publish('order.requested');",
        "+  return repository.insert(normalized);",
      ].join("\n"),
    },
    {
      path: "packages/orders/src/service.test.ts",
      kind: "text",
      additions: 3,
      deletions: 0,
      patch: [
        "@@ -30,0 +31,3 @@ describe('create')",
        "+  it('normalizes the order before insertion', async () => {",
        "+    expect(await create(fixture)).toEqual(expected);",
        "+  });",
      ].join("\n"),
    },
  ],
};

export const highRiskAuthMigrationChange: PullRequestPatch = {
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  files: [
    {
      path: "apps/web/src/auth/session.ts",
      kind: "text",
      additions: 4,
      deletions: 1,
      patch: [
        "@@ -11,2 +11,5 @@ export async function authenticate(token: string)",
        "-  return sessions.find(token);",
        "+  return database.transaction(async (transaction) => {",
        "+    const session = await transaction.lockSession(token);",
        "+    return authorize(session, 'proof:start');",
        "+  });",
      ].join("\n"),
    },
    {
      path: "packages/db/migrations/0042_session_scope.sql",
      kind: "text",
      additions: 2,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,2 @@",
        "+ALTER TABLE auth_sessions ADD COLUMN scope text;",
        "+CREATE INDEX auth_sessions_scope_idx ON auth_sessions(scope);",
      ].join("\n"),
    },
    {
      path: "apps/web/src/auth/session.test.ts",
      kind: "text",
      additions: 2,
      deletions: 0,
      patch: [
        "@@ -20,0 +21,2 @@ describe('authenticate')",
        "+  it('rejects a session without the required scope', async () => {",
        "+    await expect(authenticate(token)).rejects.toThrow();",
      ].join("\n"),
    },
  ],
};

const generatedLines = Array.from(
  { length: 10_000 },
  (_, index) => `+export const generated_${String(index)} = ${String(index)};`,
).join("\n");

export const generatedOutputChange: PullRequestPatch = {
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  files: [
    {
      path: "tools/generate-colors.ts",
      kind: "text",
      additions: 1,
      deletions: 1,
      patch: [
        "@@ -8,1 +8,1 @@ export function emitColor(name: string)",
        "-  return name.toLowerCase();",
        "+  return name.trim().toLowerCase();",
      ].join("\n"),
    },
    {
      path: "src/generated/colors.generated.ts",
      kind: "text",
      additions: 10_000,
      deletions: 0,
      patch: `@@ -0,0 +1,10000 @@\n${generatedLines}`,
    },
  ],
};

export const megaUnreviewableChange: PullRequestPatch = {
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  files: Array.from({ length: 90 }, (_, index) => ({
    path: `services/service-${String(index)}/handler.ts`,
    kind: "text" as const,
    additions: 1,
    deletions: 1,
    patch: [
      "@@ -1,1 +1,1 @@",
      `-export const value = ${String(index)};`,
      `+export const value = ${String(index + 1)};`,
    ].join("\n"),
  })),
};
