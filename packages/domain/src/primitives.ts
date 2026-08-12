import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const GitShaSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    "Expected a lowercase Git object SHA",
  );
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");
export const NonEmptyIdentifierSchema = z.string().trim().min(1).max(200);
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Idempotency keys must be log-safe identifiers");

export type Uuid = z.infer<typeof UuidSchema>;
export type GitSha = z.infer<typeof GitShaSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoUuidGenerator implements IdGenerator {
  nextId(): string {
    return crypto.randomUUID();
  }
}
