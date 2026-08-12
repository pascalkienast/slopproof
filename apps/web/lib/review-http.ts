import { NextResponse } from "next/server";
import { z } from "zod";
import { EvidenceCapabilityError } from "./evidence-capability";
import { authErrorResponse } from "./http-auth";
import { MaintainerAuthorizationError } from "./maintainer-authorization";
import { ReviewConflictError, ReviewNotFoundError } from "./maintainer-review";

export const ReviewAttemptIdSchema = z.string().uuid();

export function reviewRouteErrorResponse(error: unknown): NextResponse | null {
  const authentication = authErrorResponse(error);
  if (authentication) return authentication;
  if (error instanceof MaintainerAuthorizationError) {
    return jsonError("forbidden", 403);
  }
  if (error instanceof ReviewNotFoundError) {
    return jsonError("not_found", 404);
  }
  if (error instanceof ReviewConflictError) {
    return jsonError("review_conflict", 409);
  }
  if (error instanceof EvidenceCapabilityError) {
    return jsonError("invalid_capability", 401);
  }
  if (error instanceof z.ZodError) {
    return jsonError("invalid_request", 400);
  }
  return null;
}

export function jsonError(code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: code },
    { status, headers: { "cache-control": "no-store" } },
  );
}
