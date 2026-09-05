import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GithubInstallationRepositoriesWebhookSchema,
  GithubInstallationRepositoriesActionSchema,
  GithubInstallationActionSchema,
  GithubInstallationWebhookSchema,
  GithubPullRequestActionEnvelopeSchema,
  GithubPullRequestWebhookSchema,
  PullRequestActionSchema,
  WebhookHeadersSchema,
  type InstallationEvent,
  type InstallationRepositoriesEvent,
  type PullRequestEvent,
} from "./schemas";

export class InvalidWebhookSignatureError extends Error {
  readonly code = "INVALID_WEBHOOK_SIGNATURE" as const;
}

export class InvalidWebhookPayloadError extends Error {
  readonly code = "INVALID_WEBHOOK_PAYLOAD" as const;
}

export type SignedGithubWebhook = {
  deliveryId: string;
  eventName: string;
  payloadHash: string;
  payload: unknown;
};

export type SupportedGithubWebhook =
  | (SignedGithubWebhook & {
      kind: "pull_request";
      eventName: "pull_request";
      event: PullRequestEvent;
    })
  | (SignedGithubWebhook & {
      kind: "installation";
      eventName: "installation";
      event: InstallationEvent;
    })
  | (SignedGithubWebhook & {
      kind: "installation_repositories";
      eventName: "installation_repositories";
      event: InstallationRepositoriesEvent;
    })
  | (SignedGithubWebhook & { kind: "ignored"; event: null });

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
  const parsed = parseSignedGithubWebhook(rawBody, rawHeaders, secret);
  try {
    if (parsed.eventName !== "pull_request") {
      throw new Error("Webhook event is not pull_request");
    }
    return {
      event: GithubPullRequestWebhookSchema.parse(parsed.payload),
      deliveryId: parsed.deliveryId,
      payloadHash: parsed.payloadHash,
    };
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) throw error;
    throw new InvalidWebhookPayloadError(
      "Webhook payload is not a supported pull_request event",
    );
  }
}

/** Verifies the exact request bytes before interpreting any untrusted JSON. */
export function parseSignedGithubWebhook(
  rawBody: Uint8Array,
  rawHeaders: unknown,
  secret: string,
): SignedGithubWebhook {
  const headers = WebhookHeadersSchema.parse(rawHeaders);
  verifyWebhookSignature(rawBody, headers.signature, secret);
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    );
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("Webhook JSON must be an object");
    }
    return {
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      payloadHash: payloadSha256(rawBody),
      payload,
    };
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) throw error;
    throw new InvalidWebhookPayloadError(
      "Webhook body is not valid UTF-8 JSON",
    );
  }
}

/** Parses only the three event families UnderstandProof deliberately consumes. */
export function parseSupportedGithubWebhook(
  rawBody: Uint8Array,
  rawHeaders: unknown,
  secret: string,
): SupportedGithubWebhook {
  const signed = parseSignedGithubWebhook(rawBody, rawHeaders, secret);
  try {
    switch (signed.eventName) {
      case "pull_request":
        if (
          !PullRequestActionSchema.safeParse(
            GithubPullRequestActionEnvelopeSchema.parse(signed.payload).action,
          ).success
        ) {
          return { ...signed, kind: "ignored", event: null };
        }
        return {
          ...signed,
          kind: "pull_request",
          eventName: "pull_request",
          event: GithubPullRequestWebhookSchema.parse(signed.payload),
        };
      case "installation":
        if (
          !GithubInstallationActionSchema.safeParse(
            GithubPullRequestActionEnvelopeSchema.parse(signed.payload).action,
          ).success
        ) {
          return { ...signed, kind: "ignored", event: null };
        }
        return {
          ...signed,
          kind: "installation",
          eventName: "installation",
          event: GithubInstallationWebhookSchema.parse(signed.payload),
        };
      case "installation_repositories":
        if (
          !GithubInstallationRepositoriesActionSchema.safeParse(
            GithubPullRequestActionEnvelopeSchema.parse(signed.payload).action,
          ).success
        ) {
          return { ...signed, kind: "ignored", event: null };
        }
        return {
          ...signed,
          kind: "installation_repositories",
          eventName: "installation_repositories",
          event: GithubInstallationRepositoriesWebhookSchema.parse(
            signed.payload,
          ),
        };
      default:
        return { ...signed, kind: "ignored", event: null };
    }
  } catch {
    throw new InvalidWebhookPayloadError(
      `Webhook payload is not a supported ${signed.eventName} event`,
    );
  }
}
