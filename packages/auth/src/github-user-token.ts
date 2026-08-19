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
export const GITHUB_USER_SEAL_TTL_MS = 15 * 60_000;
const MAX_SEALED_TOKEN_LENGTH = 4_096;
const MAX_SEALED_DIRECTORY_LENGTH = 8_192;
const MAX_DIRECTORY_REPOSITORIES = 32;

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

const DirectoryPayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("maintainer_identify"),
    githubUserId: GithubDecimalIdSchema,
    repositoryIds: z.array(z.uuid()).max(MAX_DIRECTORY_REPOSITORIES),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) => new Set(value.repositoryIds).size === value.repositoryIds.length,
    "repository ids must be unique",
  );

export type GithubUserTokenBinding = z.infer<
  typeof GithubUserTokenBindingSchema
>;

export type UnsealedGithubUserAccessToken = Readonly<{
  accessToken: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type UnsealedGithubMaintainerDirectory = Readonly<{
  githubUserId: string;
  repositoryIds: readonly string[];
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
  const binding = parseBinding(input.binding);
  const issuedAt = validDate(input.issuedAt);
  const expiresAt = validDate(input.expiresAt);
  rejectInvalidLifetime(issuedAt, expiresAt);
  const payload = TokenPayloadSchema.safeParse({
    version: 1,
    accessToken: input.accessToken,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  if (!payload.success) throw new GithubUserTokenRejectedError();
  return sealJson(
    payload.data,
    bindingAad(binding),
    sessionSecret,
    dependencies.entropy ?? randomBytes,
  );
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
  const binding = parseBinding(expectedBinding);
  const currentTime = validDate(now);
  let payload: z.infer<typeof TokenPayloadSchema>;
  try {
    payload = TokenPayloadSchema.parse(
      unsealJson(
        sealed,
        bindingAad(binding),
        sessionSecret,
        MAX_SEALED_TOKEN_LENGTH,
      ),
    );
  } catch {
    throw new GithubUserTokenRejectedError();
  }
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  rejectInvalidLifetime(issuedAt, expiresAt);
  if (expiresAt <= currentTime) throw new GithubUserTokenRejectedError();
  return Object.freeze({
    accessToken: payload.accessToken,
    issuedAt,
    expiresAt,
  });
}

/**
 * Seals the identify directory with the same SESSION_SECRET AEAD as the user
 * token. AAD is the identify purpose only — there is no session or repository
 * binding. The payload is the GitHub user id and local repository UUIDs. The
 * access token must never be passed here.
 */
export function sealGithubMaintainerDirectory(
  input: Readonly<{
    githubUserId: string;
    repositoryIds: readonly string[];
    issuedAt: Date;
    expiresAt: Date;
  }>,
  sessionSecret: string,
  dependencies: Readonly<{
    entropy?: (bytes: number) => Buffer;
  }> = {},
): string {
  const issuedAt = validDate(input.issuedAt);
  const expiresAt = validDate(input.expiresAt);
  rejectInvalidLifetime(issuedAt, expiresAt);
  const payload = DirectoryPayloadSchema.safeParse({
    version: 1,
    purpose: "maintainer_identify",
    githubUserId: input.githubUserId,
    repositoryIds: [...input.repositoryIds],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  if (!payload.success) throw new GithubUserTokenRejectedError();
  return sealJson(
    payload.data,
    directoryAad(),
    sessionSecret,
    dependencies.entropy ?? randomBytes,
  );
}

export function unsealGithubMaintainerDirectory(
  sealed: string,
  sessionSecret: string,
  now = new Date(),
): UnsealedGithubMaintainerDirectory {
  const currentTime = validDate(now);
  let payload: z.infer<typeof DirectoryPayloadSchema>;
  try {
    payload = DirectoryPayloadSchema.parse(
      unsealJson(
        sealed,
        directoryAad(),
        sessionSecret,
        MAX_SEALED_DIRECTORY_LENGTH,
      ),
    );
  } catch {
    throw new GithubUserTokenRejectedError();
  }
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  rejectInvalidLifetime(issuedAt, expiresAt);
  if (expiresAt <= currentTime) throw new GithubUserTokenRejectedError();
  return Object.freeze({
    githubUserId: payload.githubUserId,
    repositoryIds: Object.freeze([...payload.repositoryIds]),
    issuedAt,
    expiresAt,
  });
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

function rejectInvalidLifetime(issuedAt: Date, expiresAt: Date): void {
  if (
    expiresAt <= issuedAt ||
    expiresAt.getTime() - issuedAt.getTime() > GITHUB_USER_SEAL_TTL_MS
  ) {
    throw new GithubUserTokenRejectedError();
  }
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

function lengthPrefixedAad(values: readonly string[]): Buffer {
  return Buffer.from(
    values
      .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
      .join("|"),
    "utf8",
  );
}

function bindingAad(binding: GithubUserTokenBinding): Buffer {
  return lengthPrefixedAad([
    TOKEN_AAD_PREFIX,
    binding.sessionId,
    binding.githubUserId,
    binding.repositoryId,
    binding.githubRepositoryId,
    binding.purpose,
  ]);
}

function directoryAad(): Buffer {
  return lengthPrefixedAad([TOKEN_AAD_PREFIX, "maintainer_identify"]);
}

function sealJson(
  payload: unknown,
  aad: Buffer,
  sessionSecret: string,
  entropy: (bytes: number) => Buffer,
): string {
  validateSecret(sessionSecret);
  const nonce = entropy(12);
  if (!Buffer.isBuffer(nonce) || nonce.byteLength !== 12) {
    throw new GithubUserTokenRejectedError();
  }
  const key = tokenKey(sessionSecret);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
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

function unsealJson(
  sealed: string,
  aad: Buffer,
  sessionSecret: string,
  maxLength: number,
): unknown {
  validateSecret(sessionSecret);
  if (
    typeof sealed !== "string" ||
    sealed.length < 32 ||
    sealed.length > maxLength
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
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      ),
    );
  } catch {
    throw new GithubUserTokenRejectedError();
  } finally {
    key.fill(0);
  }
}
