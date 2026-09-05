import { timingSafeEqual } from "node:crypto";
import type { Clock, IdGenerator } from "@understandproof/domain";
import { CryptoUuidGenerator, SystemClock } from "@understandproof/domain";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createOpaqueCredential, hashOpaqueCredential } from "./token";

export const ActorRoleSchema = z.enum(["author", "maintainer", "support"]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

export type AuthenticatedSession = {
  id: string;
  actorId: string;
  actorRole: ActorRole;
  repositoryId: string | null;
  csrfHash: string;
  expiresAt: Date;
};

export type IssuedSession = {
  session: AuthenticatedSession;
  sessionToken: string;
  csrfToken: string;
};

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function issueSession(
  executor: Queryable,
  input: {
    actorId: string;
    actorRole: ActorRole;
    repositoryId: string | null;
    ttlMs: number;
  },
  sessionSecret: string,
  dependencies: { clock?: Clock; ids?: IdGenerator } = {},
): Promise<IssuedSession> {
  const clock = dependencies.clock ?? new SystemClock();
  const ids = dependencies.ids ?? new CryptoUuidGenerator();
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("Session TTL must be a positive safe integer");
  }
  const sessionCredential = createOpaqueCredential(sessionSecret, "session");
  const csrfCredential = createOpaqueCredential(sessionSecret, "csrf");
  const session: AuthenticatedSession = {
    id: ids.nextId(),
    actorId: input.actorId,
    actorRole: ActorRoleSchema.parse(input.actorRole),
    repositoryId: input.repositoryId,
    csrfHash: csrfCredential.hash,
    expiresAt: new Date(clock.now().getTime() + input.ttlMs),
  };
  await executor.query(
    `INSERT INTO auth_sessions
      (id, token_hash, actor_id, actor_role, repository_id, csrf_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      session.id,
      sessionCredential.hash,
      session.actorId,
      session.actorRole,
      session.repositoryId,
      session.csrfHash,
      session.expiresAt,
    ],
  );
  return {
    session,
    sessionToken: sessionCredential.value,
    csrfToken: csrfCredential.value,
  };
}

export async function authenticateSession(
  executor: Queryable,
  sessionToken: string | undefined,
  sessionSecret: string,
  clock: Clock = new SystemClock(),
): Promise<AuthenticatedSession | null> {
  if (!sessionToken) return null;
  const tokenHash = hashOpaqueCredential(
    sessionSecret,
    "session",
    sessionToken,
  );
  const result = await executor.query<{
    id: string;
    actor_id: string;
    actor_role: string;
    repository_id: string | null;
    csrf_hash: string;
    expires_at: Date;
  }>(
    `SELECT id, actor_id, actor_role, repository_id, csrf_hash, expires_at
     FROM auth_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, clock.now()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    actorId: row.actor_id,
    actorRole: ActorRoleSchema.parse(row.actor_role),
    repositoryId: row.repository_id,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at,
  };
}

export function verifyCsrf(
  session: AuthenticatedSession,
  csrfToken: string | undefined,
  sessionSecret: string,
): boolean {
  if (!csrfToken) return false;
  const supplied = Buffer.from(
    hashOpaqueCredential(sessionSecret, "csrf", csrfToken),
    "hex",
  );
  const expected = Buffer.from(session.csrfHash, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export async function revokeSession(
  executor: Queryable,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  await executor.query(
    "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1",
    [sessionId, now],
  );
}
