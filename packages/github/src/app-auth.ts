import { createPrivateKey, createSign } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  GithubRepositoryBindingSchema,
  type GithubRepositoryBinding,
} from "./production-ports";
import { GithubControlError } from "./production-errors";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import {
  executeGithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const appIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/u);
const tokenResponseSchema = z
  .object({
    token: z.string().min(16).max(1_024),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();

export type GithubAppJwtOptions = {
  appId: string;
  privateKeyPath: string;
  now?: () => number;
};

export async function createGithubAppJwt(
  options: GithubAppJwtOptions,
): Promise<string> {
  const appId = appIdSchema.safeParse(options.appId);
  if (!appId.success || !isAbsolute(options.privateKeyPath)) {
    throw new GithubControlError("INVALID_INPUT");
  }

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
  // Five seconds of clock-skew tolerance; GitHub App JWTs stay well below the
  // official ten-minute maximum lifetime.
  const payload = encodeJwtPart({
    iat: nowSeconds - 5,
    exp: nowSeconds + 9 * 60,
    iss: appId.data,
  });
  const unsigned = `${header}.${payload}`;

  let privateKey: Buffer | undefined;
  try {
    privateKey = readPrivateKeyFile(options.privateKeyPath);
    const key = createPrivateKey(privateKey);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
    ) {
      throw new GithubControlError("INVALID_KEY_FILE");
    }
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned, "utf8");
    signer.end();
    return `${unsigned}.${signer.sign(key).toString("base64url")}`;
  } catch (error) {
    if (error instanceof GithubControlError) throw error;
    throw new GithubControlError("INVALID_KEY_FILE");
  } finally {
    privateKey?.fill(0);
  }
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readPrivateKeyFile(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const resolved = realpathSync(path);
    if (resolved !== path) throw new GithubControlError("INVALID_KEY_FILE");
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    const effectiveUserId = process.geteuid?.();
    const groups = process.getgroups?.();
    if (
      effectiveUserId === undefined ||
      groups === undefined ||
      !isPrivateKeyFileMetadataSafe(stat, {
        effectiveUserId,
        groups,
      })
    ) {
      throw new GithubControlError("INVALID_KEY_FILE");
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof GithubControlError) throw error;
    throw new GithubControlError("INVALID_KEY_FILE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

type PrivateKeyFileMetadata = Readonly<{
  gid: number;
  isFile(): boolean;
  mode: number;
  size: number;
  uid: number;
}>;

type FileAccessIdentity = Readonly<{
  effectiveUserId: number;
  groups: readonly number[];
}>;

/**
 * Accepts either a key owned privately by the effective user, or the safe stat
 * projection of the production ACL shape: root:root ownership, no root group
 * membership, and only the group-read mask bit. Opening the descriptor before
 * this check proves that an ACL grants this process access; host preflight must
 * separately prove that no additional named ACL entries exist.
 */
export function isPrivateKeyFileMetadataSafe(
  stat: PrivateKeyFileMetadata,
  identity: FileAccessIdentity,
): boolean {
  if (
    !stat.isFile() ||
    stat.size < 128 ||
    stat.size > 64 * 1_024 ||
    (stat.mode & 0o7000) !== 0
  ) {
    return false;
  }

  const permissions = stat.mode & 0o777;
  if ((permissions & 0o400) === 0 || (permissions & 0o137) !== 0) {
    return false;
  }

  if ((permissions & 0o040) === 0) {
    return stat.uid === identity.effectiveUserId;
  }

  return (
    stat.uid === 0 &&
    stat.gid === 0 &&
    identity.effectiveUserId !== 0 &&
    !identity.groups.includes(0)
  );
}

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

export type RepositoryInstallationTokenCacheOptions = {
  appId: string;
  privateKeyPath: string;
  clientFactory?: GithubRestClientFactory;
  requestPolicy?: GithubRequestPolicy;
  expirySkewMs?: number;
  now?: () => number;
};

export interface RepositoryInstallationTokenProvider {
  get(binding: GithubRepositoryBinding): Promise<string>;
  getFresh?(binding: GithubRepositoryBinding): Promise<string>;
  invalidate(binding: GithubRepositoryBinding): void;
}

export class RepositoryInstallationTokenCache implements RepositoryInstallationTokenProvider {
  private readonly cached = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<CachedToken>>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();
  private readonly appId: string;
  private readonly privateKeyPath: string;
  private readonly clientFactory: GithubRestClientFactory;
  private readonly requestPolicy: GithubRequestPolicy;
  private readonly expirySkewMs: number;
  private readonly now: () => number;

  constructor(options: RepositoryInstallationTokenCacheOptions) {
    this.appId = options.appId;
    this.privateKeyPath = options.privateKeyPath;
    this.clientFactory = options.clientFactory ?? createOctokitGithubRestClient;
    this.requestPolicy = options.requestPolicy ?? {};
    this.expirySkewMs = options.expirySkewMs ?? 5 * 60 * 1_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isFinite(this.expirySkewMs) ||
      this.expirySkewMs < 30_000 ||
      this.expirySkewMs > 30 * 60 * 1_000
    ) {
      throw new GithubControlError("INVALID_INPUT");
    }
  }

  async get(rawBinding: GithubRepositoryBinding): Promise<string> {
    const binding = parseBinding(rawBinding);
    const key = tokenCacheKey(binding);
    const current = this.cached.get(key);
    if (current && current.expiresAtMs - this.expirySkewMs > this.now()) {
      return current.token;
    }

    const existing = this.pending.get(key);
    if (existing) return (await existing).token;

    const generation = this.generations.get(key) ?? 0;
    const pending = this.mint(binding);
    this.pending.set(key, pending);
    try {
      const minted = await pending;
      if ((this.generations.get(key) ?? 0) === generation) {
        this.cached.set(key, minted);
      }
      return minted.token;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  async getFresh(rawBinding: GithubRepositoryBinding): Promise<string> {
    const binding = parseBinding(rawBinding);
    const key = tokenCacheKey(binding);
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const refresh = (async () => {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      this.cached.delete(key);
      this.pending.delete(key);
      return this.get(binding);
    })();
    this.refreshing.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshing.get(key) === refresh) this.refreshing.delete(key);
    }
  }

  invalidate(rawBinding: GithubRepositoryBinding): void {
    const binding = parseBinding(rawBinding);
    this.cached.delete(tokenCacheKey(binding));
  }

  private async mint(
    binding: z.infer<typeof GithubRepositoryBindingSchema>,
  ): Promise<CachedToken> {
    const jwt = await createGithubAppJwt({
      appId: this.appId,
      privateKeyPath: this.privateKeyPath,
      now: this.now,
    });
    // App JWT is never retained by the cache; only the repository-bound
    // installation token below is cached.
    let client: GithubRestClient;
    try {
      client = this.clientFactory(jwt);
    } catch {
      throw new GithubControlError("UNAVAILABLE");
    }
    const response = await executeGithubRequest(
      (signal) =>
        client.createInstallationAccessToken(
          {
            installationId: Number(binding.installationId),
            repositoryId: Number(binding.repositoryId),
          },
          signal,
        ),
      this.requestPolicy,
    );
    const parsed = tokenResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");
    const expiresAtMs = Date.parse(parsed.data.expires_at);
    if (
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs - this.expirySkewMs <= this.now()
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    return { token: parsed.data.token, expiresAtMs };
  }
}

function parseBinding(
  binding: GithubRepositoryBinding,
): z.infer<typeof GithubRepositoryBindingSchema> {
  const parsed = GithubRepositoryBindingSchema.safeParse(binding);
  if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
  return parsed.data;
}

function tokenCacheKey(
  binding: z.infer<typeof GithubRepositoryBindingSchema>,
): string {
  return `${binding.installationId}:${binding.repositoryId}`;
}
