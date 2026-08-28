import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ClosedBetaSignupInputSchema,
  persistClosedBetaSignup,
} from "../../../../lib/closed-beta-signup";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../lib/bounded-body";
import {
  consumeWebRequestRateLimit,
  createTrustedProxySubjectHash,
  createWebRequestSubjectHash,
  TrustedProxyRequestError,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../lib/request-rate-limit";
import { getWebRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await readBoundedJson(
      request,
      MAX_BODY_BYTES,
      ClosedBetaSignupInputSchema,
    );
    const app = await getWebRuntime();
    let subjectKeyHash: string;
    if (app.config.DEPLOYMENT_PROFILE === "production") {
      const proxySecret = app.config.OAUTH_TRUSTED_PROXY_SECRET;
      if (!proxySecret) throw new TrustedProxyRequestError();
      subjectKeyHash = createTrustedProxySubjectHash(request, {
        proxySecret,
        subjectSecret: app.config.SESSION_SECRET,
        action: "closed_beta_signup",
      });
    } else {
      subjectKeyHash = createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "closed_beta_signup",
        ["local-closed-beta-signup"],
      );
    }
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "closed_beta_signup",
      subjectKeyHash,
    });
    await persistClosedBetaSignup(app.database.pool, input);
    return NextResponse.json(
      { status: "received" },
      { status: 202, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "request_too_large" },
        { status: 413, headers: NO_STORE_HEADERS },
      );
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof InvalidRequestBodyEncodingError ||
      error instanceof z.ZodError
    ) {
      return NextResponse.json(
        { error: "invalid_request" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof WebRequestRateLimitExceededError) {
      return webRequestRateLimitResponse(error);
    }
    if (error instanceof TrustedProxyRequestError) {
      return NextResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
