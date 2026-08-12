import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { ActorRole, IssuedSession } from "./session";
import { sealGithubUserAccessToken } from "./github-user-token";

const OAUTH_COOKIE_AAD = Buffer.from(
  "slopproof/github-oauth-cookie/v1",
  "utf8",
);
const OAUTH_STATE_PURPOSE = "slopproof/github-oauth-state/v1\0";
const OAUTH_COOKIE_KEY_INFO = Buffer.from(
  "slopproof/github-oauth-cookie-key/v1",
  "utf8",
);
const OAUTH_COOKIE_KEY_SALT = Buffer.from("slopproof/auth/hkdf/v1", "utf8");
const DEFAULT_STATE_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_FRESH_TOKEN_TTL_MS = 10 * 60_000;
const MAX_STATE_TTL_MS = 10 * 60_000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_FRESH_TOKEN_TTL_MS = 15 * 60_000;

const Base64Url43Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const StateHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const GithubDecimalIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));

const SealedCookiePayloadSchema = z
  .object({
    version: z.literal(1),
    stateHash: StateHashSchema,
    codeVerifier: Base64Url43Schema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const GithubOAuthUserSchema = z
  .object({
    githubUserId: GithubDecimalIdSchema,
    login: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  })
  .strict();

export const GithubOAuthPurposeSchema = z.enum([
  "contributor_login",
  "maintainer_reauth",
]);

export const GithubOAuthBindingSchema = z
  .object({
    purpose: GithubOAuthPurposeSchema,
    repositoryId: z.uuid(),
    githubRepositoryId: GithubDecimalIdSchema,
  })
  .strict();

const GithubOAuthAccessGrantSchema = z
  .object({
    accessToken: z
      .string()
      .min(16)
      .max(1_024)
      .regex(/^[^\0\r\n]+$/u),
    expiresAt: z.date(),
  })
  .strict();

export type GithubOAuthUser = z.infer<typeof GithubOAuthUserSchema>;
export type GithubOAuthPurpose = z.infer<typeof GithubOAuthPurposeSchema>;
export type GithubOAuthBinding = z.infer<typeof GithubOAuthBindingSchema>;
export type GithubOAuthAccessGrant = z.infer<
  typeof GithubOAuthAccessGrantSchema
>;
export type OAuthStateHash = string & {
  readonly __oauthStateHash: unique symbol;
};

export type GithubOAuthStateRecord = Readonly<
  GithubOAuthBinding & {
    stateHash: OAuthStateHash;
    redirectPath: string;
    createdAt: Date;
    expiresAt: Date;
  }
>;

/**
 * Persistence boundary for one-use OAuth state. Implementations must persist
 * only `stateHash`, never the raw state or the PKCE verifier. `consume` must be
 * atomic and return a record at most once while it is unexpired.
 */
export interface GithubOAuthStateRepository {
  create(record: GithubOAuthStateRecord): Promise<void>;
  consume(
    input: Readonly<{
      stateHash: OAuthStateHash;
      now: Date;
    }>,
  ): Promise<GithubOAuthStateRecord | null>;
}

/**
 * Request-scoped provider port. The access token returned by `exchangeCode`
 * may only be passed to `getUser` and the sealed-token helper. Neither this
 * port nor callers may persist or log it. `repositoryId` is GitHub's numeric
 * repository ID and must be sent as `repository_id` during the GitHub App
 * token exchange.
 */
export interface GithubOAuthClient {
  exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
      repositoryId: string;
    }>,
  ): Promise<GithubOAuthAccessGrant>;
  getUser(accessToken: string): Promise<GithubOAuthUser>;
}

/**
 * Session persistence boundary. Rotation must atomically revoke any resolved
 * current session before installing the replacement. Revocation must validate
 * the session-bound CSRF token. GitHub user access tokens are intentionally
 * absent from both inputs.
 */
export interface GithubOAuthSessionPort {
  rotate(
    input: Readonly<{
      user: GithubOAuthUser;
      binding: GithubOAuthBinding;
      actorRole: Extract<ActorRole, "author" | "maintainer">;
      redirectPath: string;
      currentSessionToken?: string;
      ttlMs: number;
      now: Date;
    }>,
  ): Promise<IssuedSession>;
  revoke(
    input: Readonly<{
      sessionToken: string;
      csrfToken: string;
      now: Date;
    }>,
  ): Promise<void>;
}

export class GithubOAuthRejectedError extends Error {
  readonly code = "GITHUB_OAUTH_REJECTED" as const;

  constructor() {
    super("GitHub OAuth was rejected.");
    this.name = "GithubOAuthRejectedError";
  }
}

export class GithubOAuthUnavailableError extends Error {
  readonly code = "GITHUB_OAUTH_UNAVAILABLE" as const;

  constructor() {
    super("GitHub OAuth is unavailable.");
    this.name = "GithubOAuthUnavailableError";
  }
}

export type GithubOAuthStart = Readonly<{
  authorizationUrl: URL;
  sealedCookie: string;
  cookieExpiresAt: Date;
}>;

export type GithubOAuthCallback = Readonly<{
  issuedSession: IssuedSession;
  redirectPath: string;
  user: GithubOAuthUser;
  binding: GithubOAuthBinding;
  sealedUserToken: string;
  userTokenExpiresAt: Date;
  userTokenMaxAgeSeconds: number;
}>;

export type GithubOAuthServiceOptions = Readonly<{
  clientId: string;
  callbackUrl: string;
  /** Must be the same high-entropy SESSION_SECRET used for server sessions. */
  sessionSecret: string;
  allowedRedirectPaths: readonly string[];
  defaultRedirectPath: string;
  stateRepository: GithubOAuthStateRepository;
  client: GithubOAuthClient;
  sessions: GithubOAuthSessionPort;
  stateTtlMs?: number;
  sessionTtlMs?: number;
  freshTokenTtlMs?: number;
  now?: () => Date;
  entropy?: (bytes: number) => Buffer;
}>;

type ValidatedOptions = Readonly<{
  clientId: string;
  callbackUrl: string;
  sessionSecret: string;
  allowedRedirectPaths: ReadonlySet<string>;
  defaultRedirectPath: string;
  stateRepository: GithubOAuthStateRepository;
  client: GithubOAuthClient;
  sessions: GithubOAuthSessionPort;
  stateTtlMs: number;
  sessionTtlMs: number;
  freshTokenTtlMs: number;
  now: () => Date;
  entropy: (bytes: number) => Buffer;
}>;

export class GithubOAuthService {
  readonly callbackUrl: string;
  readonly stateTtlMs: number;
  readonly sessionTtlMs: number;
  readonly freshTokenTtlMs: number;
  readonly #options: ValidatedOptions;

  constructor(options: GithubOAuthServiceOptions) {
    this.#options = validateOptions(options);
    this.callbackUrl = this.#options.callbackUrl;
    this.stateTtlMs = this.#options.stateTtlMs;
    this.sessionTtlMs = this.#options.sessionTtlMs;
    this.freshTokenTtlMs = this.#options.freshTokenTtlMs;
  }

  async start(
    input: Readonly<{
      binding: GithubOAuthBinding;
      requestedRedirectPath?: string;
    }>,
  ): Promise<GithubOAuthStart> {
    const binding = parseBinding(input.binding);
    const redirectPath =
      input.requestedRedirectPath ?? this.#options.defaultRedirectPath;
    if (!this.#options.allowedRedirectPaths.has(redirectPath)) {
      throw new GithubOAuthRejectedError();
    }

    const now = validNow(this.#options.now);
    const expiresAt = new Date(now.getTime() + this.#options.stateTtlMs);
    const rawState = credential(this.#options.entropy);
    const codeVerifier = credential(this.#options.entropy);
    const stateHash = hashOAuthState(
      this.#options.sessionSecret,
      rawState,
    ) as OAuthStateHash;
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "ascii")
      .digest("base64url");

    try {
      await this.#options.stateRepository.create({
        stateHash,
        redirectPath,
        createdAt: now,
        expiresAt,
        ...binding,
      });
    } catch {
      throw new GithubOAuthUnavailableError();
    }

    const authorizationUrl = new URL(
      "https://github.com/login/oauth/authorize",
    );
    authorizationUrl.searchParams.set("client_id", this.#options.clientId);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      this.#options.callbackUrl,
    );
    authorizationUrl.searchParams.set("state", rawState);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("allow_signup", "false");

    return Object.freeze({
      authorizationUrl,
      sealedCookie: sealCookie(
        {
          version: 1,
          stateHash,
          codeVerifier,
          expiresAt: expiresAt.toISOString(),
        },
        this.#options.sessionSecret,
        this.#options.entropy,
      ),
      cookieExpiresAt: expiresAt,
    });
  }

  async callback(
    input: Readonly<{
      code: string;
      state: string;
      sealedCookie: string;
      currentSessionToken?: string;
    }>,
  ): Promise<GithubOAuthCallback> {
    const now = validNow(this.#options.now);
    const code = validateProviderCode(input.code);
    const state = Base64Url43Schema.safeParse(input.state);
    if (!state.success) throw new GithubOAuthRejectedError();

    const cookie = unsealCookie(
      input.sealedCookie,
      this.#options.sessionSecret,
    );
    const cookieExpiry = new Date(cookie.expiresAt);
    if (cookieExpiry <= now) throw new GithubOAuthRejectedError();

    const suppliedStateHash = hashOAuthState(
      this.#options.sessionSecret,
      state.data,
    );
    if (!safeTextEqual(cookie.stateHash, suppliedStateHash)) {
      throw new GithubOAuthRejectedError();
    }

    let persisted: GithubOAuthStateRecord | null;
    try {
      persisted = await this.#options.stateRepository.consume({
        stateHash: suppliedStateHash as OAuthStateHash,
        now,
      });
    } catch {
      throw new GithubOAuthUnavailableError();
    }
    const binding = persisted
      ? parseBinding({
          purpose: persisted.purpose,
          repositoryId: persisted.repositoryId,
          githubRepositoryId: persisted.githubRepositoryId,
        })
      : null;
    if (
      !persisted ||
      !binding ||
      persisted.expiresAt <= now ||
      !safeTextEqual(persisted.stateHash, suppliedStateHash) ||
      !this.#options.allowedRedirectPaths.has(persisted.redirectPath)
    ) {
      throw new GithubOAuthRejectedError();
    }

    let grant: GithubOAuthAccessGrant;
    let user: GithubOAuthUser;
    try {
      grant = GithubOAuthAccessGrantSchema.parse(
        await this.#options.client.exchangeCode({
          code,
          codeVerifier: cookie.codeVerifier,
          redirectUri: this.#options.callbackUrl,
          repositoryId: binding.githubRepositoryId,
        }),
      );
      if (grant.expiresAt <= now) throw new GithubOAuthUnavailableError();
      user = GithubOAuthUserSchema.parse(
        await this.#options.client.getUser(grant.accessToken),
      );
    } catch {
      throw new GithubOAuthUnavailableError();
    }

    try {
      const issuedSession = await this.#options.sessions.rotate({
        user,
        binding,
        actorRole: githubOAuthActorRole(binding.purpose),
        redirectPath: persisted.redirectPath,
        ...(input.currentSessionToken
          ? { currentSessionToken: input.currentSessionToken }
          : {}),
        ttlMs: this.#options.sessionTtlMs,
        now,
      });
      validateIssuedSession(issuedSession, user, binding, now);
      const userTokenExpiresAt = new Date(
        Math.min(
          grant.expiresAt.getTime(),
          issuedSession.session.expiresAt.getTime(),
          now.getTime() + this.#options.freshTokenTtlMs,
        ),
      );
      const sealedUserToken = sealGithubUserAccessToken(
        {
          accessToken: grant.accessToken,
          binding: {
            sessionId: issuedSession.session.id,
            githubUserId: user.githubUserId,
            repositoryId: binding.repositoryId,
            githubRepositoryId: binding.githubRepositoryId,
            purpose: binding.purpose,
          },
          issuedAt: now,
          expiresAt: userTokenExpiresAt,
        },
        this.#options.sessionSecret,
        { entropy: this.#options.entropy },
      );
      return Object.freeze({
        issuedSession,
        redirectPath: persisted.redirectPath,
        user,
        binding,
        sealedUserToken,
        userTokenExpiresAt,
        userTokenMaxAgeSeconds: Math.floor(
          (userTokenExpiresAt.getTime() - now.getTime()) / 1_000,
        ),
      });
    } catch {
      throw new GithubOAuthUnavailableError();
    }
  }

  async logout(
    input: Readonly<{
      sessionToken: string;
      csrfToken: string;
    }>,
  ): Promise<void> {
    try {
      await this.#options.sessions.revoke({
        sessionToken: input.sessionToken,
        csrfToken: input.csrfToken,
        now: validNow(this.#options.now),
      });
    } catch {
      throw new GithubOAuthUnavailableError();
    }
  }
}

function validateOptions(options: GithubOAuthServiceOptions): ValidatedOptions {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(options.clientId)) {
    throw new GithubOAuthRejectedError();
  }
  if (
    options.sessionSecret.length < 32 ||
    /[\0\r\n]/u.test(options.sessionSecret)
  ) {
    throw new GithubOAuthRejectedError();
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(options.callbackUrl);
  } catch {
    throw new GithubOAuthRejectedError();
  }
  if (
    callbackUrl.protocol !== "https:" ||
    callbackUrl.pathname !== "/api/auth/github/callback" ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.search ||
    callbackUrl.hash
  ) {
    throw new GithubOAuthRejectedError();
  }

  const allowedRedirectPaths = new Set(options.allowedRedirectPaths);
  if (
    allowedRedirectPaths.size === 0 ||
    [...allowedRedirectPaths].some((path) => !isSafeLocalPath(path)) ||
    !allowedRedirectPaths.has(options.defaultRedirectPath)
  ) {
    throw new GithubOAuthRejectedError();
  }

  const stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const freshTokenTtlMs = options.freshTokenTtlMs ?? DEFAULT_FRESH_TOKEN_TTL_MS;
  if (
    !Number.isSafeInteger(stateTtlMs) ||
    stateTtlMs < 60_000 ||
    stateTtlMs > MAX_STATE_TTL_MS ||
    !Number.isSafeInteger(sessionTtlMs) ||
    sessionTtlMs < 60_000 ||
    sessionTtlMs > MAX_SESSION_TTL_MS ||
    !Number.isSafeInteger(freshTokenTtlMs) ||
    freshTokenTtlMs < 60_000 ||
    freshTokenTtlMs > MAX_FRESH_TOKEN_TTL_MS
  ) {
    throw new GithubOAuthRejectedError();
  }

  return Object.freeze({
    ...options,
    callbackUrl: callbackUrl.toString(),
    allowedRedirectPaths,
    stateTtlMs,
    sessionTtlMs,
    freshTokenTtlMs,
    now: options.now ?? (() => new Date()),
    entropy: options.entropy ?? randomBytes,
  });
}

function parseBinding(value: unknown): GithubOAuthBinding {
  const binding = GithubOAuthBindingSchema.safeParse(value);
  if (!binding.success) throw new GithubOAuthRejectedError();
  return binding.data;
}

function isSafeLocalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !path.includes("?") &&
    !path.includes("#") &&
    !/[\0\r\n]/u.test(path) &&
    new URL(path, "https://local.invalid").origin === "https://local.invalid"
  );
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GithubOAuthUnavailableError();
  }
  return new Date(value);
}

function credential(entropy: (bytes: number) => Buffer): string {
  const value = entropy(32);
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new GithubOAuthUnavailableError();
  }
  return value.toString("base64url");
}

function validateProviderCode(code: string): string {
  if (
    typeof code !== "string" ||
    code.length < 1 ||
    code.length > 1_024 ||
    /[\0\r\n]/u.test(code)
  ) {
    throw new GithubOAuthRejectedError();
  }
  return code;
}

function validateIssuedSession(
  issued: IssuedSession,
  user: GithubOAuthUser,
  binding: GithubOAuthBinding,
  now: Date,
): void {
  if (
    !z.uuid().safeParse(issued.session.id).success ||
    issued.session.actorId !== user.githubUserId ||
    issued.session.actorRole !== githubOAuthActorRole(binding.purpose) ||
    issued.session.repositoryId !== binding.repositoryId ||
    issued.session.expiresAt <= now ||
    !issued.sessionToken ||
    !issued.csrfToken
  ) {
    throw new GithubOAuthUnavailableError();
  }
}

export function githubOAuthActorRole(
  purpose: GithubOAuthPurpose,
): Extract<ActorRole, "author" | "maintainer"> {
  return purpose === "contributor_login" ? "author" : "maintainer";
}

export function deriveGithubOAuthStateHash(
  state: string,
  sessionSecret: string,
): OAuthStateHash {
  if (
    !Base64Url43Schema.safeParse(state).success ||
    typeof sessionSecret !== "string" ||
    sessionSecret.length < 32 ||
    /[\0\r\n]/u.test(sessionSecret)
  ) {
    throw new GithubOAuthRejectedError();
  }
  return hashOAuthState(sessionSecret, state) as OAuthStateHash;
}

function hashOAuthState(secret: string, state: string): string {
  return createHmac("sha256", secret)
    .update(OAUTH_STATE_PURPOSE, "utf8")
    .update(state, "ascii")
    .digest("hex");
}

function cookieKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      OAUTH_COOKIE_KEY_SALT,
      OAUTH_COOKIE_KEY_INFO,
      32,
    ),
  );
}

function sealCookie(
  payload: z.infer<typeof SealedCookiePayloadSchema>,
  secret: string,
  entropy: (bytes: number) => Buffer,
): string {
  const validated = SealedCookiePayloadSchema.parse(payload);
  const nonce = entropy(12);
  if (!Buffer.isBuffer(nonce) || nonce.byteLength !== 12) {
    throw new GithubOAuthUnavailableError();
  }
  const key = cookieKey(secret);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(OAUTH_COOKIE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validated), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  } finally {
    key.fill(0);
  }
}

function unsealCookie(
  sealed: string,
  secret: string,
): z.infer<typeof SealedCookiePayloadSchema> {
  if (
    typeof sealed !== "string" ||
    sealed.length < 32 ||
    sealed.length > 2_048
  ) {
    throw new GithubOAuthRejectedError();
  }
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new GithubOAuthRejectedError();
  }
  const key = cookieKey(secret);
  try {
    const nonce = Buffer.from(parts[1]!, "base64url");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new GithubOAuthRejectedError();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(OAUTH_COOKIE_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return SealedCookiePayloadSchema.parse(JSON.parse(plaintext));
  } catch {
    throw new GithubOAuthRejectedError();
  } finally {
    key.fill(0);
  }
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
