import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PRACTICE_CAPABILITY_MAX_TTL_MS = 30_000;
const PRACTICE_CAPABILITY_HMAC_DOMAIN =
  "slopproof:practice-capability:v1:" as const;

export const PracticeCapabilityActionSchema = z.enum([
  "practice.read",
  "practice.submit",
]);

export const PracticeCapabilityPayloadSchema = z
  .object({
    version: z.literal(1),
    revisionId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    actorId: z.string().min(1).max(255),
    action: PracticeCapabilityActionSchema,
    jti: z.string().uuid(),
    expiresAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type PracticeCapabilityPayload = z.infer<
  typeof PracticeCapabilityPayloadSchema
>;

export class PracticeCapabilityError extends Error {
  readonly code = "INVALID_PRACTICE_CAPABILITY" as const;
}

function canonicalPayload(payload: PracticeCapabilityPayload): string {
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

function signature(payload: PracticeCapabilityPayload, secret: string): Buffer {
  if (secret.length < 32) {
    throw new PracticeCapabilityError("Capability secret is too short");
  }
  return createHmac("sha256", secret)
    .update(PRACTICE_CAPABILITY_HMAC_DOMAIN, "utf8")
    .update(canonicalPayload(payload), "utf8")
    .digest();
}

export function issuePracticeCapability(
  input: {
    revisionId: string;
    repositoryId: string;
    actorId: string;
    action: z.infer<typeof PracticeCapabilityActionSchema>;
    ttlMs?: number;
  },
  secret: string,
  dependencies: { now?: Date; nextJti?: () => string } = {},
): { token: string; payload: PracticeCapabilityPayload } {
  const now = dependencies.now ?? new Date();
  const ttlMs = input.ttlMs ?? PRACTICE_CAPABILITY_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > PRACTICE_CAPABILITY_MAX_TTL_MS
  ) {
    throw new PracticeCapabilityError("Capability TTL is outside its limit");
  }
  const payload = PracticeCapabilityPayloadSchema.parse({
    version: 1,
    revisionId: input.revisionId,
    repositoryId: input.repositoryId,
    actorId: input.actorId,
    action: input.action,
    jti: (dependencies.nextJti ?? randomUUID)(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  const document = canonicalPayload(payload);
  return {
    token: `${Buffer.from(document, "utf8").toString("base64url")}.${signature(payload, secret).toString("base64url")}`,
    payload,
  };
}

export function verifyPracticeCapability(
  token: string,
  secret: string,
  now = new Date(),
): PracticeCapabilityPayload {
  if (token.length > 4_096) {
    throw new PracticeCapabilityError("Capability token is too large");
  }
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new PracticeCapabilityError("Capability token has an invalid shape");
  }

  let payload: PracticeCapabilityPayload;
  let suppliedSignature: Buffer;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(segments[0], "base64url"),
    );
    payload = PracticeCapabilityPayloadSchema.parse(JSON.parse(decoded));
    if (canonicalPayload(payload) !== decoded) {
      throw new PracticeCapabilityError("Capability payload is not canonical");
    }
    suppliedSignature = Buffer.from(segments[1], "base64url");
  } catch (error) {
    if (error instanceof PracticeCapabilityError) throw error;
    throw new PracticeCapabilityError("Capability token cannot be decoded", {
      cause: error,
    });
  }

  const expectedSignature = signature(payload, secret);
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new PracticeCapabilityError("Capability signature does not match");
  }
  const remaining = Date.parse(payload.expiresAt) - now.getTime();
  if (remaining <= 0 || remaining > PRACTICE_CAPABILITY_MAX_TTL_MS) {
    throw new PracticeCapabilityError(
      "Capability is expired or exceeds its TTL",
    );
  }
  return payload;
}
