import {
  InvalidWebhookPayloadError,
  InvalidWebhookSignatureError,
  WebhookDeliveryConflictError,
  ingestPullRequestWebhook,
} from "@slopproof/github";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getWebRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json(
      { error: "invalid_payload_size" },
      { status: 400 },
    );
  }

  try {
    const app = await getWebRuntime();
    const result = await ingestPullRequestWebhook({
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
      { accepted: result.accepted, duplicate: result.duplicate },
      { status: 202 },
    );
  } catch (error) {
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
