import { exchangeHandoff, HandoffRejectedError } from "@understandproof/auth";
import {
  RECORDING_PROTOCOL_VERSION,
  RECORDING_SUITE_ID,
} from "@understandproof/media";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../lib/bounded-body";
import { attachSessionCookies } from "../../../../lib/http-auth";
import {
  consumeWebRequestRateLimit,
  createTrustedProxySubjectHash,
  createWebRequestSubjectHash,
  TrustedProxyRequestError,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../lib/request-rate-limit";
import { getWebRuntime } from "../../../../lib/runtime";
import { loadLocalPublicWrappingMaterial } from "../../../../lib/wrapping-material";

const InputSchema = z.object({ token: z.string().min(20).max(200) }).strict();
const MAX_BODY_BYTES = 512;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    if (app.config.KEY_WRAPPING_PROVIDER !== "local") {
      return NextResponse.json(
        { error: "adapter_unavailable" },
        { status: 503 },
      );
    }
    const input = await readBoundedJson(request, MAX_BODY_BYTES, InputSchema);
    let subjectKeyHash: string;
    if (app.config.DEPLOYMENT_PROFILE === "production") {
      const proxySecret = app.config.OAUTH_TRUSTED_PROXY_SECRET;
      if (!proxySecret) throw new TrustedProxyRequestError();
      subjectKeyHash = createTrustedProxySubjectHash(request, {
        proxySecret,
        subjectSecret: app.config.SESSION_SECRET,
        action: "handoff_exchange",
      });
    } else {
      subjectKeyHash = createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "handoff_exchange",
        ["local-handoff-token", input.token],
      );
    }
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "handoff_exchange",
      subjectKeyHash,
    });
    const publicMaterial = await loadLocalPublicWrappingMaterial(
      app.config.KEY_WRAPPING_PUBLIC_KEY_PATH,
    );
    const exchanged = await exchangeHandoff(
      app.database.pool,
      { token: input.token, wrappingMaterial: publicMaterial },
      app.config.SESSION_SECRET,
    );
    const response = NextResponse.json({
      attemptId: exchanged.wrappingMaterial.attemptId,
      headSha: exchanged.wrappingMaterial.headSha,
      csrfToken: exchanged.mobileSession.csrfToken,
      wrappingMaterial: {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        suiteId: RECORDING_SUITE_ID,
        attemptId: exchanged.wrappingMaterial.attemptId,
        headSha: exchanged.wrappingMaterial.headSha,
        objectId: exchanged.wrappingMaterial.objectId,
        materialId: exchanged.wrappingMaterial.materialId,
        keyId: exchanged.wrappingMaterial.keyId,
        algorithm: exchanged.wrappingMaterial.algorithm,
        spkiBase64url: exchanged.wrappingMaterial.spkiDer,
        usableUntil: exchanged.wrappingMaterial.usableUntil,
      },
    });
    attachSessionCookies(
      response,
      exchanged.mobileSession,
      app.config.APP_BASE_URL,
    );
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof InvalidRequestBodyEncodingError ||
      error instanceof z.ZodError
    ) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (error instanceof HandoffRejectedError) {
      return NextResponse.json({ error: "handoff_rejected" }, { status: 410 });
    }
    if (error instanceof WebRequestRateLimitExceededError) {
      return webRequestRateLimitResponse(error);
    }
    if (error instanceof TrustedProxyRequestError) {
      return NextResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
