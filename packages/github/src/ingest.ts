import type { Pool } from "pg";
import type { PullRequestJobPublisher } from "./queue";
import { PullRequestJobPayloadSchema } from "./schemas";
import { markWebhookQueued, reserveWebhookDelivery } from "./service";
import { parsePullRequestWebhook } from "./webhook";

export type IngestWebhookResult = {
  accepted: true;
  duplicate: boolean;
  deliveryId: string;
};

export async function ingestPullRequestWebhook(input: {
  pool: Pool;
  queue: PullRequestJobPublisher;
  secret: string;
  rawBody: Uint8Array;
  headers: unknown;
}): Promise<IngestWebhookResult> {
  const parsed = parsePullRequestWebhook(
    input.rawBody,
    input.headers,
    input.secret,
  );
  const reservation = await reserveWebhookDelivery(input.pool, {
    deliveryId: parsed.deliveryId,
    eventName: "pull_request",
    payloadHash: parsed.payloadHash,
  });
  if (reservation.shouldEnqueue) {
    const payload = PullRequestJobPayloadSchema.parse({
      schemaVersion: "1",
      idempotencyKey: `github-delivery:${parsed.deliveryId}`,
      deliveryId: parsed.deliveryId,
      eventName: "pull_request",
      ...parsed.event,
    });
    await input.queue.publish(payload);
    await markWebhookQueued(input.pool, parsed.deliveryId);
  }
  return {
    accepted: true,
    duplicate: reservation.duplicate,
    deliveryId: parsed.deliveryId,
  };
}
