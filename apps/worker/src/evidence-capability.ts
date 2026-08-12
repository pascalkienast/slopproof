import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const EVIDENCE_CAPABILITY_MAX_TTL_MS = 60_000;

export const WorkerEvidenceCapabilitySchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    actorId: z.string().min(1).max(255),
    jti: z.string().uuid(),
    expiresAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type WorkerEvidenceCapability = z.infer<
  typeof WorkerEvidenceCapabilitySchema
>;

export class WorkerEvidenceCapabilityError extends Error {
  readonly code = "INVALID_EVIDENCE_CAPABILITY" as const;
}

function canonicalPayload(payload: WorkerEvidenceCapability): string {
  return JSON.stringify({
    version: payload.version,
    attemptId: payload.attemptId,
    repositoryId: payload.repositoryId,
    actorId: payload.actorId,
    jti: payload.jti,
    expiresAt: payload.expiresAt,
  });
}

export function verifyWorkerEvidenceCapability(
  token: string,
  secret: string,
  now = new Date(),
): WorkerEvidenceCapability {
  if (secret.length < 32 || token.length > 4_096) {
    throw new WorkerEvidenceCapabilityError("Capability input is invalid");
  }
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new WorkerEvidenceCapabilityError("Capability shape is invalid");
  }

  let payload: WorkerEvidenceCapability;
  let suppliedSignature: Buffer;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(segments[0], "base64url"),
    );
    payload = WorkerEvidenceCapabilitySchema.parse(JSON.parse(decoded));
    if (canonicalPayload(payload) !== decoded) {
      throw new WorkerEvidenceCapabilityError(
        "Capability payload is not canonical",
      );
    }
    suppliedSignature = Buffer.from(segments[1], "base64url");
  } catch (error) {
    if (error instanceof WorkerEvidenceCapabilityError) throw error;
    throw new WorkerEvidenceCapabilityError("Capability cannot be decoded", {
      cause: error,
    });
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(canonicalPayload(payload), "utf8")
    .digest();
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new WorkerEvidenceCapabilityError(
      "Capability signature does not match",
    );
  }
  const remaining = Date.parse(payload.expiresAt) - now.getTime();
  if (remaining <= 0 || remaining > EVIDENCE_CAPABILITY_MAX_TTL_MS) {
    throw new WorkerEvidenceCapabilityError(
      "Capability is expired or exceeds its maximum TTL",
    );
  }
  return payload;
}
