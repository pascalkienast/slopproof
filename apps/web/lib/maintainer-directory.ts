import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { GithubOAuthUser } from "@slopproof/auth";
import {
  GithubControlError,
  OctokitUserAuthorizationPort,
  type GithubUserAuthorizationPort,
} from "@slopproof/github";
import { z } from "zod";
import {
  listActiveMaintainerRepositories,
  loadMaintainerRepositoriesByIds,
  type ActiveMaintainerRepositoryV1,
} from "./github-oauth-production";
import { isMaintainerPermission } from "./maintainer-authorization";
import type { WebRuntime } from "./runtime";

export const MAINTAINER_DIRECTORY_COOKIE =
  "__Host-slopproof_maintainer_directory";
export const MAINTAINER_DIRECTORY_TTL_MS = 15 * 60_000;

const DIRECTORY_AAD = Buffer.from(
  "slopproof/maintainer-directory-cookie/v1",
  "utf8",
);
const DIRECTORY_KEY_INFO = Buffer.from(
  "slopproof/maintainer-directory-key/v1",
  "utf8",
);
const DIRECTORY_KEY_SALT = Buffer.from("slopproof/auth/hkdf/v1", "utf8");

const DirectoryPayloadSchema = z
  .object({
    version: z.literal(1),
    githubUserId: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/u)
      .refine((value) => Number.isSafeInteger(Number(value))),
    repositoryIds: z.array(z.uuid()).max(32),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) => new Set(value.repositoryIds).size === value.repositoryIds.length,
    "repository ids must be unique",
  );

export type MaintainerDirectoryCookie = Readonly<{
  sealedCookie: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}>;

export class MaintainerDirectoryError extends Error {
  readonly code = "MAINTAINER_DIRECTORY_UNAVAILABLE" as const;

  constructor() {
    super("Maintainer directory is unavailable.");
    this.name = "MaintainerDirectoryError";
  }
}

/**
 * Live intersection of active SlopProof installations and this GitHub user's
 * collaborator permission. Any inconclusive permission read fails the whole
 * directory. The access token stays method-local.
 */
export async function filterMaintainerDirectory(
  input: Readonly<{
    user: GithubOAuthUser;
    accessToken: string;
    repositories: readonly ActiveMaintainerRepositoryV1[];
    authorizationPort: GithubUserAuthorizationPort;
  }>,
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  if (
    input.accessToken.length < 16 ||
    input.accessToken.length > 1_024 ||
    /[\0\r\n]/u.test(input.accessToken)
  ) {
    throw new MaintainerDirectoryError();
  }

  const allowed: ActiveMaintainerRepositoryV1[] = [];
  for (const repository of input.repositories) {
    let permission: Awaited<
      ReturnType<GithubUserAuthorizationPort["getCollaboratorPermission"]>
    >;
    try {
      permission = await input.authorizationPort.getCollaboratorPermission({
        userToken: input.accessToken,
        owner: repository.owner,
        repositoryName: repository.name,
        username: input.user.login,
      });
    } catch (error) {
      if (isAbsentCollaborator(error)) continue;
      throw new MaintainerDirectoryError();
    }
    if (isMaintainerPermission(permission.permission, permission.roleName)) {
      allowed.push(repository);
    }
  }
  return Object.freeze(allowed);
}

export async function resolveProductionIdentifyDirectory(
  app: WebRuntime,
  input: Readonly<{
    user: GithubOAuthUser;
    accessToken: string;
    now: Date;
  }>,
  dependencies: Readonly<{
    authorizationPort?: GithubUserAuthorizationPort;
    entropy?: (bytes: number) => Buffer;
  }> = {},
): Promise<MaintainerDirectoryCookie | null> {
  try {
    if (
      app.config.DEPLOYMENT_PROFILE !== "production" ||
      app.config.GITHUB_ADAPTER !== "octokit" ||
      app.config.DEMO_MODE
    ) {
      return null;
    }
    const repositories = await listActiveMaintainerRepositories(
      app.database.pool,
    );
    const allowed = await filterMaintainerDirectory({
      user: input.user,
      accessToken: input.accessToken,
      repositories,
      authorizationPort:
        dependencies.authorizationPort ?? new OctokitUserAuthorizationPort(),
    });
    return sealMaintainerDirectory(
      {
        githubUserId: input.user.githubUserId,
        repositoryIds: allowed.map((repository) => repository.id),
        now: input.now,
      },
      app.config.SESSION_SECRET,
      dependencies,
    );
  } catch {
    return null;
  }
}

export function sealMaintainerDirectory(
  input: Readonly<{
    githubUserId: string;
    repositoryIds: readonly string[];
    now: Date;
  }>,
  sessionSecret: string,
  dependencies: Readonly<{
    entropy?: (bytes: number) => Buffer;
    ttlMs?: number;
  }> = {},
): MaintainerDirectoryCookie {
  validateSecret(sessionSecret);
  const now = validDate(input.now);
  const ttlMs = dependencies.ttlMs ?? MAINTAINER_DIRECTORY_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 60_000 ||
    ttlMs > MAINTAINER_DIRECTORY_TTL_MS
  ) {
    throw new MaintainerDirectoryError();
  }
  const expiresAt = new Date(now.getTime() + ttlMs);
  const payload = DirectoryPayloadSchema.safeParse({
    version: 1,
    githubUserId: input.githubUserId,
    repositoryIds: [...input.repositoryIds],
    expiresAt: expiresAt.toISOString(),
  });
  if (!payload.success) throw new MaintainerDirectoryError();

  const nonce = (dependencies.entropy ?? randomBytes)(12);
  if (!Buffer.isBuffer(nonce) || nonce.byteLength !== 12) {
    throw new MaintainerDirectoryError();
  }
  const key = directoryKey(sessionSecret);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(DIRECTORY_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload.data), "utf8"),
      cipher.final(),
    ]);
    return Object.freeze({
      sealedCookie: [
        "v1",
        nonce.toString("base64url"),
        ciphertext.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join("."),
      expiresAt,
      maxAgeSeconds: Math.floor(ttlMs / 1_000),
    });
  } catch {
    throw new MaintainerDirectoryError();
  } finally {
    key.fill(0);
  }
}

export function unsealMaintainerDirectory(
  sealed: string,
  sessionSecret: string,
  now = new Date(),
): readonly string[] {
  validateSecret(sessionSecret);
  const currentTime = validDate(now);
  if (
    typeof sealed !== "string" ||
    sealed.length < 32 ||
    sealed.length > 8_192
  ) {
    throw new MaintainerDirectoryError();
  }
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new MaintainerDirectoryError();
  }
  const key = directoryKey(sessionSecret);
  try {
    const nonce = Buffer.from(parts[1]!, "base64url");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new MaintainerDirectoryError();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(DIRECTORY_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload = DirectoryPayloadSchema.parse(JSON.parse(plaintext));
    const expiresAt = new Date(payload.expiresAt);
    if (expiresAt <= currentTime) throw new MaintainerDirectoryError();
    return Object.freeze(payload.repositoryIds);
  } catch {
    throw new MaintainerDirectoryError();
  } finally {
    key.fill(0);
  }
}

export async function loadSealedMaintainerDirectory(
  app: WebRuntime,
  sealed: string | undefined,
  now = new Date(),
): Promise<readonly ActiveMaintainerRepositoryV1[] | null> {
  if (!sealed) return null;
  try {
    const repositoryIds = unsealMaintainerDirectory(
      sealed,
      app.config.SESSION_SECRET,
      now,
    );
    return await loadMaintainerRepositoriesByIds(
      app.database.pool,
      repositoryIds,
    );
  } catch {
    return null;
  }
}

function isAbsentCollaborator(error: unknown): boolean {
  return (
    error instanceof GithubControlError &&
    error.code === "REJECTED" &&
    (error.status === 403 || error.status === 404)
  );
}

function validateSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    /[\0\r\n]/u.test(secret)
  ) {
    throw new MaintainerDirectoryError();
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MaintainerDirectoryError();
  }
  return new Date(value);
}

function directoryKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      DIRECTORY_KEY_SALT,
      DIRECTORY_KEY_INFO,
      32,
    ),
  );
}
