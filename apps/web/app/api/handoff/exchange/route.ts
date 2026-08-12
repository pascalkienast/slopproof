import { exchangeHandoff, HandoffRejectedError } from "@slopproof/auth";
import {
  RECORDING_PROTOCOL_VERSION,
  RECORDING_SUITE_ID,
} from "@slopproof/media";
import { NextResponse } from "next/server";
import { z } from "zod";
import { attachSessionCookies } from "../../../../lib/http-auth";
import { getWebRuntime } from "../../../../lib/runtime";
import { loadLocalPublicWrappingMaterial } from "../../../../lib/wrapping-material";

const InputSchema = z.object({ token: z.string().min(20).max(200) }).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    if (app.config.KEY_WRAPPING_PROVIDER !== "local") {
      return NextResponse.json(
        { error: "adapter_unavailable" },
        { status: 503 },
      );
    }
    const input = InputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const publicMaterial = await loadLocalPublicWrappingMaterial(
      app.config.KEY_WRAPPING_PUBLIC_KEY_PATH,
    );
    const exchanged = await exchangeHandoff(
      app.database.pool,
      { token: input.data.token, wrappingMaterial: publicMaterial },
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
    if (error instanceof HandoffRejectedError) {
      return NextResponse.json({ error: "handoff_rejected" }, { status: 410 });
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
