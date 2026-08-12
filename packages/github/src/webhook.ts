import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GithubPullRequestWebhookSchema,
  WebhookHeadersSchema,
  type PullRequestEvent,
} from "./schemas";

export class InvalidWebhookSignatureError extends Error {
  readonly code = "INVALID_WEBHOOK_SIGNATURE" as const;
}

export class InvalidWebhookPayloadError extends Error {
  readonly code = "INVALID_WEBHOOK_PAYLOAD" as const;
}

export function payloadSha256(rawBody: Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  secret: string,
): void {
  if (!/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) {
    throw new InvalidWebhookSignatureError(
      "Webhook signature has an invalid format",
    );
  }
  const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new InvalidWebhookSignatureError("Webhook signature does not match");
  }
}

export function parsePullRequestWebhook(
  rawBody: Uint8Array,
  rawHeaders: unknown,
  secret: string,
): { event: PullRequestEvent; deliveryId: string; payloadHash: string } {
  const headers = WebhookHeadersSchema.parse(rawHeaders);
  verifyWebhookSignature(rawBody, headers.signature, secret);
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    return {
      event: GithubPullRequestWebhookSchema.parse(json),
      deliveryId: headers.deliveryId,
      payloadHash: payloadSha256(rawBody),
    };
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) throw error;
    throw new InvalidWebhookPayloadError(
      "Webhook payload is not a supported pull_request event",
    );
  }
}
