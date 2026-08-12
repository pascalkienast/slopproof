import type { Pool, PoolClient } from "pg";
import type { JobPayload } from "@slopproof/db";
import {
  PublicCheckInputSchema,
  PullRequestJobPayloadSchema,
  type PublicCheckInput,
  type PullRequestJobPayload,
} from "./schemas";

export class WebhookDeliveryConflictError extends Error {
  readonly code = "WEBHOOK_DELIVERY_CONFLICT" as const;
}

export type WebhookReservation = {
  duplicate: boolean;
  shouldEnqueue: boolean;
};

export async function reserveWebhookDelivery(
  pool: Pool,
  input: { deliveryId: string; eventName: "pull_request"; payloadHash: string },
): Promise<WebhookReservation> {
  const inserted = await pool.query(
    `INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash, processing_status)
     VALUES ($1, $2, $3, 'reserved')
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [input.deliveryId, input.eventName, input.payloadHash],
  );
  if (inserted.rowCount === 1) return { duplicate: false, shouldEnqueue: true };

  const existing = await pool.query<{
    payload_hash: string;
    processing_status: string;
  }>(
    "SELECT payload_hash, processing_status FROM webhook_deliveries WHERE delivery_id = $1",
    [input.deliveryId],
  );
  const row = existing.rows[0];
  if (!row || row.payload_hash !== input.payloadHash) {
    throw new WebhookDeliveryConflictError(
      "Delivery ID was reused with a different payload",
    );
  }
  return {
    duplicate: true,
    shouldEnqueue: row.processing_status === "reserved",
  };
}

export async function markWebhookQueued(
  pool: Pool,
  deliveryId: string,
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
     SET processing_status = CASE WHEN processing_status = 'processed' THEN processing_status ELSE 'queued' END
     WHERE delivery_id = $1`,
    [deliveryId],
  );
}

export interface GithubCheckPort {
  upsert(input: PublicCheckInput, client?: PoolClient): Promise<void>;
}

export interface RevisionPreparationPublisher {
  publish(
    client: PoolClient,
    payload: JobPayload<"analysis.prepare-revision">,
  ): Promise<string | null>;
  publishAttemptExpiry?(
    client: PoolClient,
    payload: JobPayload<"proof.expire-attempt">,
  ): Promise<string | null>;
}

export class FakeGithubCheckAdapter implements GithubCheckPort {
  constructor(
    private readonly pool: Pool,
    private readonly baseUrl: string,
  ) {}

  detailsUrl(revisionId: string): string {
    return new URL(`/revisions/${revisionId}`, this.baseUrl).toString();
  }

  async upsert(rawInput: PublicCheckInput, client?: PoolClient): Promise<void> {
    const input = PublicCheckInputSchema.parse(rawInput);
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO check_runs
        (revision_id, github_check_run_id, name, status, conclusion, public_summary, details_url)
       VALUES ($1, $2, 'SlopProof / understanding required', $3, $4, $5, $6)
       ON CONFLICT (revision_id) DO UPDATE SET
         status = EXCLUDED.status,
         conclusion = EXCLUDED.conclusion,
         public_summary = EXCLUDED.public_summary,
         details_url = EXCLUDED.details_url,
         last_synchronized_at = now(),
         updated_at = now()`,
      [
        input.revisionId,
        `fake-check:${input.revisionId}`,
        input.status,
        input.conclusion,
        input.summary,
        input.detailsUrl,
      ],
    );
  }
}

export type ProcessPullRequestResult = {
  revisionId: string;
  createdRevision: boolean;
  invalidatedAttempts: number;
};

export async function processPullRequestJob(
  pool: Pool,
  checkPort: GithubCheckPort,
  rawPayload: PullRequestJobPayload,
  revisionPublisher?: RevisionPreparationPublisher,
): Promise<ProcessPullRequestResult> {
  const payload = PullRequestJobPayloadSchema.parse(rawPayload);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const installation = await client.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, account_id, account_login)
       VALUES ($1, $2, $3)
       ON CONFLICT (github_installation_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         account_login = EXCLUDED.account_login,
         updated_at = now()
       RETURNING id`,
      [
        payload.installation.githubInstallationId,
        payload.installation.accountId,
        payload.installation.accountLogin,
      ],
    );
    const repository = await client.query<{ id: string }>(
      `INSERT INTO repositories
        (installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_repository_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         owner = EXCLUDED.owner,
         name = EXCLUDED.name,
         default_branch = EXCLUDED.default_branch,
         updated_at = now()
       RETURNING id`,
      [
        installation.rows[0]!.id,
        payload.repository.githubRepositoryId,
        payload.repository.owner,
        payload.repository.name,
        payload.repository.defaultBranch,
      ],
    );
    const pullRequest = await client.query<{ id: string }>(
      `INSERT INTO pull_requests
        (repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_pull_request_id) DO UPDATE SET
         author_id = EXCLUDED.author_id,
         state = EXCLUDED.state,
         updated_at = now()
       RETURNING id`,
      [
        repository.rows[0]!.id,
        payload.pullRequest.githubPullRequestId,
        payload.pullRequest.number,
        payload.pullRequest.authorId,
        payload.pullRequest.state,
      ],
    );
    await client.query(
      "SELECT id FROM pull_requests WHERE id = $1 FOR UPDATE",
      [pullRequest.rows[0]!.id],
    );

    const current = await client.query<{ id: string; head_sha: string }>(
      `SELECT id, head_sha FROM pull_request_revisions
       WHERE pull_request_id = $1 AND is_current = true FOR UPDATE`,
      [pullRequest.rows[0]!.id],
    );

    let revisionId = current.rows[0]?.id;
    let createdRevision = false;
    let invalidatedAttempts = 0;
    const invalidatedForCleanup: { id: string; head_sha: string }[] = [];
    if (current.rows[0]?.head_sha !== payload.pullRequest.headSha) {
      if (current.rows[0]) {
        await client.query(
          `UPDATE pull_request_revisions
           SET is_current = false, invalidated_at = now()
           WHERE id = $1`,
          [current.rows[0].id],
        );
        const invalidated = await client.query<{
          id: string;
          head_sha: string;
        }>(
          `UPDATE attempts
           SET status = 'invalidated', invalidated_at = now(), completed_at = now(), updated_at = now()
           WHERE revision_id = $1
             AND status IN ('preparing','ready','active','uploading','processing','review_required')
           RETURNING id, head_sha`,
          [current.rows[0].id],
        );
        invalidatedAttempts = invalidated.rowCount ?? 0;
        invalidatedForCleanup.push(...invalidated.rows);
        await client.query(
          `UPDATE check_runs SET status = 'completed', conclusion = 'cancelled',
             public_summary = 'invalidated by a newer head SHA', updated_at = now(),
             last_synchronized_at = now()
           WHERE revision_id = $1 AND conclusion IS DISTINCT FROM 'success'`,
          [current.rows[0].id],
        );
      }
      const insertedRevision = await client.query<{ id: string }>(
        `INSERT INTO pull_request_revisions (pull_request_id, head_sha, base_sha, is_current)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (pull_request_id, head_sha) DO UPDATE SET
           base_sha = EXCLUDED.base_sha,
           is_current = true,
           invalidated_at = NULL
         RETURNING id`,
        [
          pullRequest.rows[0]!.id,
          payload.pullRequest.headSha,
          payload.pullRequest.baseSha,
        ],
      );
      revisionId = insertedRevision.rows[0]!.id;
      createdRevision = true;
    }

    if (!revisionId) throw new Error("Pull request revision was not created");
    if (payload.action === "closed") {
      const invalidated = await client.query<{
        id: string;
        head_sha: string;
      }>(
        `UPDATE attempts
         SET status = 'invalidated', invalidated_at = now(),
             completed_at = now(), updated_at = now()
         WHERE revision_id = $1
           AND status IN ('preparing','ready','active','uploading','processing','review_required')
         RETURNING id, head_sha`,
        [revisionId],
      );
      invalidatedAttempts += invalidated.rowCount ?? 0;
      invalidatedForCleanup.push(...invalidated.rows);
    }
    const passed = await client.query(
      `SELECT 1 FROM attempts
       WHERE revision_id = $1 AND status = 'passed'
       LIMIT 1`,
      [revisionId],
    );
    const alreadyPassed = payload.action !== "closed" && passed.rowCount === 1;
    await checkPort.upsert(
      {
        revisionId,
        headSha: payload.pullRequest.headSha,
        status:
          payload.action === "closed" || alreadyPassed
            ? "completed"
            : "in_progress",
        conclusion:
          payload.action === "closed"
            ? "cancelled"
            : alreadyPassed
              ? "success"
              : null,
        summary:
          payload.action === "closed"
            ? `closed for head ${payload.pullRequest.headSha}`
            : alreadyPassed
              ? `understanding confirmed for head ${payload.pullRequest.headSha}`
              : `understanding required for head ${payload.pullRequest.headSha}`,
        detailsUrl:
          checkPort instanceof FakeGithubCheckAdapter
            ? checkPort.detailsUrl(revisionId)
            : `https://invalid.local/revisions/${revisionId}`,
      },
      client,
    );
    if (payload.action !== "closed" && revisionPublisher) {
      await revisionPublisher.publish(client, {
        schemaVersion: "1",
        idempotencyKey: `analysis:${revisionId}:${payload.pullRequest.headSha}`,
        revisionId,
        expectedHeadSha: payload.pullRequest.headSha,
      });
    }
    if (revisionPublisher?.publishAttemptExpiry) {
      for (const attempt of invalidatedForCleanup) {
        await revisionPublisher.publishAttemptExpiry(client, {
          schemaVersion: "1",
          idempotencyKey: `invalidation-cleanup:${attempt.id}:${attempt.head_sha}`,
          attemptId: attempt.id,
          expectedHeadSha: attempt.head_sha,
        });
      }
    }
    await client.query(
      "UPDATE webhook_deliveries SET processing_status = 'processed', processed_at = now() WHERE delivery_id = $1",
      [payload.deliveryId],
    );
    await client.query("COMMIT");
    return { revisionId, createdRevision, invalidatedAttempts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
