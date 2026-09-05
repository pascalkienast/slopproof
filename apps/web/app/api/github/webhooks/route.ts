import {
  InvalidWebhookPayloadError,
  InvalidWebhookSignatureError,
  WebhookDeliveryConflictError,
  ingestGithubWebhook,
} from "@understandproof/github";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  RequestBodyTooLargeError,
  readBoundedBody,
} from "../../../../lib/bounded-body";
import { getWebRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const rawBody = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
    if (rawBody.byteLength === 0) {
      return NextResponse.json(
        { error: "invalid_payload_size" },
        { status: 400 },
      );
    }
    const app = await getWebRuntime();
    const result = await ingestGithubWebhook({
      pool: app.database.pool,
      queue: app.githubQueue,
      secret: app.config.GITHUB_WEBHOOK_SECRET,
      rawBody,
      headers: {
        deliveryId: request.headers.get("x-github-delivery"),
        eventName: request.headers.get("x-github-event"),
        signature: request.headers.get("x-hub-signature-256"),
      },
    });
    return NextResponse.json(
      {
        accepted: result.accepted,
        duplicate: result.duplicate,
        ignored: result.ignored,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof InvalidWebhookSignatureError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    if (
      error instanceof InvalidWebhookPayloadError ||
      error instanceof ZodError
    ) {
      return NextResponse.json({ error: "invalid_webhook" }, { status: 400 });
    }
    if (error instanceof WebhookDeliveryConflictError) {
      return NextResponse.json({ error: "delivery_conflict" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
