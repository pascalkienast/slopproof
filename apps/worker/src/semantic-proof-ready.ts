import type { PoolClient } from "pg";
import type { CheckIntentWriter } from "./revision-preparation";
import type { SemanticProofReadyWriter } from "./semantic-generation-contracts";

/** DB-only composition: Check intent and audit share the Attempt transaction. */
export function createSemanticProofReadyWriter(
  checkIntents: CheckIntentWriter,
): SemanticProofReadyWriter {
  return {
    async write(client, input) {
      await checkIntents.write(client, {
        revisionId: input.revisionId,
        headSha: input.headSha,
        status: "in_progress",
        conclusion: null,
        summary: `proof ready for head ${input.headSha}`,
        reason: "analysis_ready",
        idempotencyKey: input.idempotencyKey,
      });
      await insertProofReadyAuditOnce(client, input);
    },
  };
}

async function insertProofReadyAuditOnce(
  client: PoolClient,
  input: {
    revisionId: string;
    headSha: string;
    attemptId: string;
    proofPlanId: string;
    expiresAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (actor_id, action, object_type, object_id, metadata)
     SELECT 'semantic-worker', 'analysis.proof_ready', 'attempt', $1, $2::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events
        WHERE action = 'analysis.proof_ready'
          AND object_type = 'attempt' AND object_id = $1
     )`,
    [
      input.attemptId,
      JSON.stringify({
        revisionId: input.revisionId,
        headSha: input.headSha,
        planId: input.proofPlanId,
        expiresAt: input.expiresAt.toISOString(),
      }),
    ],
  );
}
