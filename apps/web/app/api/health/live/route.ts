import { healthJsonResponse } from "../../../../lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthJsonResponse("ok");
}
