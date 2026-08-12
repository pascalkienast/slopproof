import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const EVIDENCE_CAPABILITY_MAX_TTL_MS = 60_000;
export const EVIDENCE_CAPABILITY_COOKIE =
  "slopproof_evidence_capability" as const;

export const EvidenceCapabilityPayloadSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    actorId: z.string().min(1).max(255),
    jti: z.string().uuid(),
    expiresAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type EvidenceCapabilityPayload = z.infer<
  typeof EvidenceCapabilityPayloadSchema
>;

export class EvidenceCapabilityError extends Error {
  readonly code = "INVALID_EVIDENCE_CAPABILITY" as const;
}

function payloadDocument(payload: EvidenceCapabilityPayload): string {
  return JSON.stringify({
    version: payload.version,
    attemptId: payload.attemptId,
    repositoryId: payload.repositoryId,
    actorId: payload.actorId,
    jti: payload.jti,
    expiresAt: payload.expiresAt,
  });
}

function signature(payload: EvidenceCapabilityPayload, secret: string): Buffer {
  if (secret.length < 32) {
    throw new EvidenceCapabilityError("Capability secret is too short");
  }
  return createHmac("sha256", secret)
    .update(payloadDocument(payload), "utf8")
    .digest();
}

export function issueEvidenceCapability(
  input: {
    attemptId: string;
    repositoryId: string;
    actorId: string;
    ttlMs?: number;
  },
  secret: string,
  dependencies: { now?: Date; nextJti?: () => string } = {},
): { token: string; payload: EvidenceCapabilityPayload } {
  const now = dependencies.now ?? new Date();
  const ttlMs = input.ttlMs ?? EVIDENCE_CAPABILITY_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > EVIDENCE_CAPABILITY_MAX_TTL_MS
  ) {
    throw new EvidenceCapabilityError("Capability TTL is outside its limit");
  }
  const payload = EvidenceCapabilityPayloadSchema.parse({
    version: 1,
    attemptId: input.attemptId,
    repositoryId: input.repositoryId,
    actorId: input.actorId,
    jti: (dependencies.nextJti ?? randomUUID)(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  const encodedPayload = Buffer.from(payloadDocument(payload), "utf8").toString(
    "base64url",
  );
  return {
    token: `${encodedPayload}.${signature(payload, secret).toString("base64url")}`,
    payload,
  };
}

export function verifyEvidenceCapability(
  token: string,
  secret: string,
  now = new Date(),
): EvidenceCapabilityPayload {
  if (token.length > 4_096) {
    throw new EvidenceCapabilityError("Capability token is too large");
  }
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new EvidenceCapabilityError("Capability token has an invalid shape");
  }

  let payload: EvidenceCapabilityPayload;
  let suppliedSignature: Buffer;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(segments[0], "base64url"),
    );
    const raw: unknown = JSON.parse(decoded);
    payload = EvidenceCapabilityPayloadSchema.parse(raw);
    if (payloadDocument(payload) !== decoded) {
      throw new EvidenceCapabilityError("Capability payload is not canonical");
    }
    suppliedSignature = Buffer.from(segments[1], "base64url");
  } catch (error) {
    if (error instanceof EvidenceCapabilityError) throw error;
    throw new EvidenceCapabilityError("Capability token cannot be decoded", {
      cause: error,
    });
  }

  const expectedSignature = signature(payload, secret);
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new EvidenceCapabilityError("Capability signature does not match");
  }
  const expiresAt = Date.parse(payload.expiresAt);
  const remaining = expiresAt - now.getTime();
  if (remaining <= 0 || remaining > EVIDENCE_CAPABILITY_MAX_TTL_MS) {
    throw new EvidenceCapabilityError(
      "Capability is expired or exceeds its TTL",
    );
  }
  return payload;
}
