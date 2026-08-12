import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

const TOKEN_AAD_PREFIX = "slopproof/github-user-token/v1";
const TOKEN_KEY_INFO = Buffer.from(
  "slopproof/github-user-token-key/v1",
  "utf8",
);
const TOKEN_KEY_SALT = Buffer.from("slopproof/auth/hkdf/v1", "utf8");
const MAX_TOKEN_LIFETIME_MS = 15 * 60_000;

const GithubDecimalIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));
const GithubOAuthPurposeSchema = z.enum([
  "contributor_login",
  "maintainer_reauth",
]);

export const GithubUserTokenBindingSchema = z
  .object({
    sessionId: z.uuid(),
    githubUserId: GithubDecimalIdSchema,
    repositoryId: z.uuid(),
    githubRepositoryId: GithubDecimalIdSchema,
    purpose: GithubOAuthPurposeSchema,
  })
  .strict();

const TokenPayloadSchema = z
  .object({
    version: z.literal(1),
    accessToken: z
      .string()
      .min(16)
      .max(1_024)
      .regex(/^[^\0\r\n]+$/u),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type GithubUserTokenBinding = z.infer<
  typeof GithubUserTokenBindingSchema
>;

export type UnsealedGithubUserAccessToken = Readonly<{
  accessToken: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export class GithubUserTokenRejectedError extends Error {
  readonly code = "GITHUB_USER_TOKEN_REJECTED" as const;

  constructor() {
    super("GitHub user authorization is unavailable.");
    this.name = "GithubUserTokenRejectedError";
  }
}

/**
 * Seals a request-near GitHub user token with an AES-256-GCM key derived from
 * SESSION_SECRET via HKDF-SHA256. The binding is authenticated as AEAD AAD, so
 * another session, GitHub actor, repository, or OAuth purpose cannot unseal it.
 * The token is never returned in plaintext to browser JavaScript or a DB port.
 */
export function sealGithubUserAccessToken(
  input: Readonly<{
    accessToken: string;
    binding: GithubUserTokenBinding;
    issuedAt: Date;
    expiresAt: Date;
  }>,
  sessionSecret: string,
  dependencies: Readonly<{
    entropy?: (bytes: number) => Buffer;
  }> = {},
): string {
  validateSecret(sessionSecret);
  const binding = parseBinding(input.binding);
  const issuedAt = validDate(input.issuedAt);
  const expiresAt = validDate(input.expiresAt);
  if (
    expiresAt <= issuedAt ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_TOKEN_LIFETIME_MS
  ) {
    throw new GithubUserTokenRejectedError();
  }
  const payload = TokenPayloadSchema.safeParse({
    version: 1,
    accessToken: input.accessToken,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  if (!payload.success) throw new GithubUserTokenRejectedError();

  const nonce = (dependencies.entropy ?? randomBytes)(12);
  if (!Buffer.isBuffer(nonce) || nonce.byteLength !== 12) {
    throw new GithubUserTokenRejectedError();
  }
  const key = tokenKey(sessionSecret);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(bindingAad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload.data), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  } catch {
    throw new GithubUserTokenRejectedError();
  } finally {
    key.fill(0);
  }
}

/**
 * Unseals only for the authenticated session and exact GitHub/repository
 * binding supplied by the caller. Callers must first authenticate the normal
 * server session and must keep the returned token request-scoped and unlogged.
 */
export function unsealGithubUserAccessToken(
  sealed: string,
  expectedBinding: GithubUserTokenBinding,
  sessionSecret: string,
  now = new Date(),
): UnsealedGithubUserAccessToken {
  validateSecret(sessionSecret);
  const binding = parseBinding(expectedBinding);
  const currentTime = validDate(now);
  if (
    typeof sealed !== "string" ||
    sealed.length < 32 ||
    sealed.length > 4_096
  ) {
    throw new GithubUserTokenRejectedError();
  }
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new GithubUserTokenRejectedError();
  }
  const key = tokenKey(sessionSecret);
  try {
    const nonce = Buffer.from(parts[1]!, "base64url");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new GithubUserTokenRejectedError();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(bindingAad(binding));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload = TokenPayloadSchema.parse(JSON.parse(plaintext));
    const issuedAt = new Date(payload.issuedAt);
    const expiresAt = new Date(payload.expiresAt);
    if (
      expiresAt <= currentTime ||
      expiresAt <= issuedAt ||
      expiresAt.getTime() - issuedAt.getTime() > MAX_TOKEN_LIFETIME_MS
    ) {
      throw new GithubUserTokenRejectedError();
    }
    return Object.freeze({
      accessToken: payload.accessToken,
      issuedAt,
      expiresAt,
    });
  } catch {
    throw new GithubUserTokenRejectedError();
  } finally {
    key.fill(0);
  }
}

function parseBinding(value: unknown): GithubUserTokenBinding {
  const binding = GithubUserTokenBindingSchema.safeParse(value);
  if (!binding.success) throw new GithubUserTokenRejectedError();
  return binding.data;
}

function validateSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    /[\0\r\n]/u.test(secret)
  ) {
    throw new GithubUserTokenRejectedError();
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GithubUserTokenRejectedError();
  }
  return new Date(value);
}

function tokenKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      TOKEN_KEY_SALT,
      TOKEN_KEY_INFO,
      32,
    ),
  );
}

function bindingAad(binding: GithubUserTokenBinding): Buffer {
  return Buffer.from(
    [
      TOKEN_AAD_PREFIX,
      binding.sessionId,
      binding.githubUserId,
      binding.repositoryId,
      binding.githubRepositoryId,
      binding.purpose,
    ]
      .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
      .join("|"),
    "utf8",
  );
}
