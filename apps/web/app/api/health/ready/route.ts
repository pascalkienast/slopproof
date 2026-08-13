import { checkReadiness, healthJsonResponse } from "../../../../lib/health";
import { getWebRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const ready = await checkReadiness({ loadRuntime: getWebRuntime });
  return ready
    ? healthJsonResponse("ready")
    : healthJsonResponse("unavailable", 503);
}
