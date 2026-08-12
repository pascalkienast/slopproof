import {
  PgBossGithubCheckOutbox,
  persistGithubCheckIntentInTransaction,
} from "@slopproof/db";
import { GITHUB_CHECK_NAME } from "@slopproof/github";
import type {
  CheckIntentWriter,
  CheckIntentWriterInput,
} from "./attempt-lifecycle";
import type { WebRuntime } from "./runtime";

/**
 * Creates the Web process' DB-only GitHub check writer. The remote GitHub
 * effect is deliberately deferred to the separately isolated control worker.
 */
export function createWebCheckIntentWriter(app: WebRuntime): CheckIntentWriter {
  const outbox = new PgBossGithubCheckOutbox(app.jobQueue);

  return {
    async write(client, input: CheckIntentWriterInput): Promise<void> {
      await persistGithubCheckIntentInTransaction(client, outbox, {
        revisionId: input.revisionId,
        expectedHeadSha: input.headSha,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        name: GITHUB_CHECK_NAME,
        status: input.status,
        conclusion: input.conclusion,
        publicSummary: input.summary,
        detailsUrl: new URL(
          `/revisions/${input.revisionId}`,
          app.config.APP_BASE_URL,
        ).toString(),
      });
    },
  };
}
