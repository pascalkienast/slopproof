import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WORKER_PRACTICE_CAPABILITY_MAX_TTL_MS = 30_000;
const PRACTICE_CAPABILITY_HMAC_DOMAIN =
  "slopproof:practice-capability:v1:" as const;

export const WorkerPracticeCapabilitySchema = z
  .object({
    version: z.literal(1),
    revisionId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    actorId: z.string().min(1).max(255),
    action: z.enum(["practice.read", "practice.submit"]),
    jti: z.string().uuid(),
    expiresAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type WorkerPracticeCapability = z.infer<
  typeof WorkerPracticeCapabilitySchema
>;

export class WorkerPracticeCapabilityError extends Error {
  readonly code = "INVALID_PRACTICE_CAPABILITY" as const;
}

function canonicalPayload(payload: WorkerPracticeCapability): string {
  return JSON.stringify({
    version: payload.version,
    revisionId: payload.revisionId,
    repositoryId: payload.repositoryId,
    actorId: payload.actorId,
    action: payload.action,
    jti: payload.jti,
    expiresAt: payload.expiresAt,
  });
}

export function verifyWorkerPracticeCapability(
  token: string,
  secret: string,
  now = new Date(),
): WorkerPracticeCapability {
  if (secret.length < 32 || token.length > 4_096) {
    throw new WorkerPracticeCapabilityError("Capability input is invalid");
  }
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new WorkerPracticeCapabilityError("Capability shape is invalid");
  }

  let payload: WorkerPracticeCapability;
  let suppliedSignature: Buffer;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(segments[0], "base64url"),
    );
    payload = WorkerPracticeCapabilitySchema.parse(JSON.parse(decoded));
    if (canonicalPayload(payload) !== decoded) {
      throw new WorkerPracticeCapabilityError(
        "Capability payload is not canonical",
      );
    }
    suppliedSignature = Buffer.from(segments[1], "base64url");
  } catch (error) {
    if (error instanceof WorkerPracticeCapabilityError) throw error;
    throw new WorkerPracticeCapabilityError("Capability cannot be decoded", {
      cause: error,
    });
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(PRACTICE_CAPABILITY_HMAC_DOMAIN, "utf8")
    .update(canonicalPayload(payload), "utf8")
    .digest();
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new WorkerPracticeCapabilityError(
      "Capability signature does not match",
    );
  }
  const remaining = Date.parse(payload.expiresAt) - now.getTime();
  if (remaining <= 0 || remaining > WORKER_PRACTICE_CAPABILITY_MAX_TTL_MS) {
    throw new WorkerPracticeCapabilityError(
      "Capability is expired or exceeds its maximum TTL",
    );
  }
  return payload;
}
