import type { Clock, IdGenerator } from "@slopproof/domain";
import { CryptoUuidGenerator, SystemClock } from "@slopproof/domain";
import type { Pool } from "pg";
import { z } from "zod";
import type { AuthenticatedSession, IssuedSession } from "./session";
import { issueSession } from "./session";
import { createOpaqueCredential, hashOpaqueCredential } from "./token";

export const PublicWrappingMaterialInputSchema = z
  .object({
    keyId: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
    algorithm: z.literal("RSA-OAEP-256"),
    spkiDer: z.string().regex(/^[A-Za-z0-9_-]+$/),
    spkiSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type PublicWrappingMaterialInput = z.infer<
  typeof PublicWrappingMaterialInputSchema
>;

export type HandoffGrant = {
  token: string;
  expiresAt: Date;
};

export type ExchangedHandoff = {
  mobileSession: IssuedSession;
  wrappingMaterial: PublicWrappingMaterialInput & {
    version: 1;
    materialId: string;
    attemptId: string;
    headSha: string;
    objectId: string;
    usableUntil: string;
  };
};

export class HandoffRejectedError extends Error {
  readonly code = "HANDOFF_REJECTED" as const;
}

export async function createHandoff(
  pool: Pool,
  input: {
    attemptId: string;
    session: AuthenticatedSession;
    ttlMs?: number;
  },
  sessionSecret: string,
  dependencies: { clock?: Clock; ids?: IdGenerator } = {},
): Promise<HandoffGrant> {
  const clock = dependencies.clock ?? new SystemClock();
  const ids = dependencies.ids ?? new CryptoUuidGenerator();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  if (input.session.actorRole !== "author") throw new HandoffRejectedError();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await client.query<{
      author_id: string;
      repository_id: string;
      status: string;
      expires_at: Date;
      is_current: boolean;
    }>(
      `SELECT attempt.author_id, attempt.repository_id, attempt.status,
              attempt.expires_at, revision.is_current
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       WHERE attempt.id = $1
       FOR UPDATE OF attempt`,
      [input.attemptId],
    );
    const row = attempt.rows[0];
    if (
      !row ||
      row.author_id !== input.session.actorId ||
      row.repository_id !== input.session.repositoryId ||
      row.status !== "ready" ||
      !row.is_current ||
      row.expires_at <= clock.now()
    ) {
      throw new HandoffRejectedError();
    }

    await client.query(
      `UPDATE handoff_tokens SET consumed_at = $2
       WHERE attempt_id = $1 AND consumed_at IS NULL`,
      [input.attemptId, clock.now()],
    );
    const credential = createOpaqueCredential(sessionSecret, "handoff");
    const expiresAt = new Date(
      Math.min(row.expires_at.getTime(), clock.now().getTime() + ttlMs),
    );
    await client.query(
      `INSERT INTO handoff_tokens
        (id, attempt_id, desktop_session_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.nextId(),
        input.attemptId,
        input.session.id,
        credential.hash,
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return { token: credential.value, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function exchangeHandoff(
  pool: Pool,
  input: { token: string; wrappingMaterial: PublicWrappingMaterialInput },
  sessionSecret: string,
  dependencies: { clock?: Clock; ids?: IdGenerator } = {},
): Promise<ExchangedHandoff> {
  const clock = dependencies.clock ?? new SystemClock();
  const ids = dependencies.ids ?? new CryptoUuidGenerator();
  const material = PublicWrappingMaterialInputSchema.parse(
    input.wrappingMaterial,
  );
  const tokenHash = hashOpaqueCredential(sessionSecret, "handoff", input.token);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const grant = await client.query<{
      handoff_id: string;
      attempt_id: string;
      author_id: string;
      repository_id: string;
      head_sha: string;
      attempt_expires_at: Date;
      handoff_expires_at: Date;
      consumed_at: Date | null;
      status: string;
      is_current: boolean;
      desktop_actor_id: string;
      desktop_expires_at: Date;
      desktop_revoked_at: Date | null;
    }>(
      `SELECT handoff.id AS handoff_id, attempt.id AS attempt_id,
              attempt.author_id, attempt.repository_id, attempt.head_sha,
              attempt.expires_at AS attempt_expires_at,
              handoff.expires_at AS handoff_expires_at, handoff.consumed_at,
              attempt.status, revision.is_current,
              desktop.actor_id AS desktop_actor_id,
              desktop.expires_at AS desktop_expires_at,
              desktop.revoked_at AS desktop_revoked_at
       FROM handoff_tokens handoff
       JOIN attempts attempt ON attempt.id = handoff.attempt_id
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN auth_sessions desktop ON desktop.id = handoff.desktop_session_id
       WHERE handoff.token_hash = $1
       FOR UPDATE OF handoff`,
      [tokenHash],
    );
    const row = grant.rows[0];
    const now = clock.now();
    if (
      !row ||
      row.consumed_at !== null ||
      row.handoff_expires_at <= now ||
      row.attempt_expires_at <= now ||
      row.desktop_expires_at <= now ||
      row.desktop_revoked_at !== null ||
      row.desktop_actor_id !== row.author_id ||
      row.status !== "ready" ||
      !row.is_current
    ) {
      throw new HandoffRejectedError();
    }

    await client.query(
      "UPDATE handoff_tokens SET consumed_at = $2 WHERE id = $1",
      [row.handoff_id, now],
    );
    const mobileSession = await issueSession(
      client,
      {
        actorId: row.author_id,
        actorRole: "author",
        repositoryId: row.repository_id,
        ttlMs: row.attempt_expires_at.getTime() - now.getTime(),
      },
      sessionSecret,
      { clock, ids },
    );
    const materialId = ids.nextId();
    const objectId = ids.nextId();
    await client.query(
      `INSERT INTO wrapping_materials
        (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        materialId,
        row.attempt_id,
        objectId,
        material.keyId,
        material.algorithm,
        material.spkiSha256,
        row.attempt_expires_at,
      ],
    );
    await client.query("COMMIT");
    return {
      mobileSession,
      wrappingMaterial: {
        version: 1,
        materialId,
        ...material,
        attemptId: row.attempt_id,
        headSha: row.head_sha,
        objectId,
        usableUntil: row.attempt_expires_at.toISOString(),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof HandoffRejectedError) throw error;
    throw error;
  } finally {
    client.release();
  }
}
