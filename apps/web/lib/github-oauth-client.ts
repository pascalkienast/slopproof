import {
  GithubOAuthUserSchema,
  type GithubOAuthAccessGrant,
  type GithubOAuthClient,
  type GithubOAuthUser,
} from "@slopproof/auth";
import { z } from "zod";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1_024;
const NON_EXPIRING_TOKEN_LOCAL_TTL_SECONDS = 15 * 60;

const DecimalIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));

const TokenResponseSchema = z
  .object({
    access_token: z
      .string()
      .min(16)
      .max(1_024)
      .regex(/^[^\0\r\n]+$/u),
    token_type: z.literal("bearer"),
    scope: z.literal("").optional(),
    expires_in: z
      .number()
      .int()
      .min(60)
      .max(24 * 60 * 60)
      .optional(),
    refresh_token: z.string().min(16).max(1_024).optional(),
    refresh_token_expires_in: z
      .number()
      .int()
      .min(60)
      .max(365 * 24 * 60 * 60)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.refresh_token === undefined) !==
      (value.refresh_token_expires_in === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "refresh token fields must occur together",
      });
    }
    if (value.refresh_token !== undefined && value.expires_in === undefined) {
      context.addIssue({
        code: "custom",
        message: "expiring token fields must occur together",
      });
    }
  });

const NullableStringSchema = z.string().max(65_536).nullable();
const NullableDateTimeSchema = z.iso.datetime({ offset: true }).nullable();
const UserPlanSchema = z
  .object({
    name: z.string().max(100),
    space: z.number().int().nonnegative(),
    collaborators: z.number().int().nonnegative(),
    private_repos: z.number().int().nonnegative(),
  })
  .strict();

/**
 * GitHub's authenticated-user REST shape validates every security-relevant
 * field we consume and tolerates additive GitHub response fields. The strict
 * local `GithubOAuthUserSchema` projection below admits only `id` and `login`
 * into authentication state.
 */
export const GithubAuthenticatedUserResponseSchema = z
  .object({
    login: z.string().min(1).max(39),
    id: z.number().int().positive().safe(),
    node_id: z.string().min(1).max(256),
    avatar_url: z.url().max(2_048),
    gravatar_id: z.string().max(256).nullable(),
    url: z.url().max(2_048),
    html_url: z.url().max(2_048),
    followers_url: z.url().max(2_048),
    following_url: z.string().min(1).max(2_048),
    gists_url: z.string().min(1).max(2_048),
    starred_url: z.string().min(1).max(2_048),
    subscriptions_url: z.url().max(2_048),
    organizations_url: z.url().max(2_048),
    repos_url: z.url().max(2_048),
    events_url: z.string().min(1).max(2_048),
    received_events_url: z.url().max(2_048),
    type: z.string().min(1).max(100),
    user_view_type: z.string().min(1).max(100).optional(),
    site_admin: z.boolean(),
    name: NullableStringSchema,
    company: NullableStringSchema,
    blog: z.string().max(2_048),
    location: NullableStringSchema,
    email: NullableStringSchema,
    hireable: z.boolean().nullable(),
    bio: NullableStringSchema,
    twitter_username: NullableStringSchema,
    notification_email: NullableStringSchema.optional(),
    public_repos: z.number().int().nonnegative(),
    public_gists: z.number().int().nonnegative(),
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    private_gists: z.number().int().nonnegative().optional(),
    total_private_repos: z.number().int().nonnegative().optional(),
    owned_private_repos: z.number().int().nonnegative().optional(),
    disk_usage: z.number().int().nonnegative().optional(),
    collaborators: z.number().int().nonnegative().optional(),
    two_factor_authentication: z.boolean().optional(),
    plan: UserPlanSchema.optional(),
    suspended_at: NullableDateTimeSchema.optional(),
    ldap_dn: z.string().max(2_048).optional(),
    business_plus: z.boolean().optional(),
  })
  .passthrough();

export class GithubOAuthProviderError extends Error {
  readonly code = "GITHUB_OAUTH_PROVIDER_ERROR" as const;

  constructor() {
    super("GitHub OAuth provider request failed.");
    this.name = "GithubOAuthProviderError";
  }
}

export type GithubOAuthHttpClientOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}>;

export class GithubOAuthHttpClient implements GithubOAuthClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #now: () => number;

  constructor(options: GithubOAuthHttpClientOptions) {
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(options.clientId) ||
      options.clientSecret.length < 16 ||
      options.clientSecret.length > 1_024 ||
      /[\0\r\n]/u.test(options.clientSecret)
    ) {
      throw new GithubOAuthProviderError();
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1_024 ||
      maxResponseBytes > 256 * 1_024
    ) {
      throw new GithubOAuthProviderError();
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#now = options.now ?? Date.now;
  }

  async exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
      repositoryId: string;
    }>,
  ): Promise<GithubOAuthAccessGrant> {
    const repositoryId = DecimalIdSchema.safeParse(input.repositoryId);
    if (
      !repositoryId.success ||
      !input.code ||
      input.code.length > 1_024 ||
      /[\0\r\n]/u.test(input.code) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.codeVerifier) ||
      !isExactCallbackUrl(input.redirectUri)
    ) {
      throw new GithubOAuthProviderError();
    }

    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      repository_id: repositoryId.data,
    });
    const response = TokenResponseSchema.safeParse(
      await this.#requestJson(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "slopproof/0.1.0",
        },
        body,
      }),
    );
    if (!response.success) throw new GithubOAuthProviderError();
    const now = this.#now();
    if (!Number.isFinite(now)) throw new GithubOAuthProviderError();
    return Object.freeze({
      accessToken: response.data.access_token,
      expiresAt: new Date(
        now +
          (response.data.expires_in ?? NON_EXPIRING_TOKEN_LOCAL_TTL_SECONDS) *
            1_000,
      ),
    });
  }

  async getUser(accessToken: string): Promise<GithubOAuthUser> {
    if (
      accessToken.length < 16 ||
      accessToken.length > 1_024 ||
      /[\0\r\n]/u.test(accessToken)
    ) {
      throw new GithubOAuthProviderError();
    }
    const response = GithubAuthenticatedUserResponseSchema.safeParse(
      await this.#requestJson(USER_URL, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "slopproof/0.1.0",
          "x-github-api-version": "2022-11-28",
        },
      }),
    );
    if (!response.success) throw new GithubOAuthProviderError();
    const projected = GithubOAuthUserSchema.safeParse({
      githubUserId: String(response.data.id),
      login: response.data.login,
    });
    if (!projected.success) throw new GithubOAuthProviderError();
    return projected.data;
  }

  async #requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.status !== 200) throw new GithubOAuthProviderError();
      const contentType = response.headers.get("content-type")?.toLowerCase();
      if (!contentType?.startsWith("application/json")) {
        throw new GithubOAuthProviderError();
      }
      return await readBoundedJson(response, this.#maxResponseBytes);
    } catch {
      throw new GithubOAuthProviderError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new GithubOAuthProviderError();
    }
  }
  if (!response.body) throw new GithubOAuthProviderError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new GithubOAuthProviderError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GithubOAuthProviderError();
  } finally {
    reader.releaseLock();
  }
}

function isExactCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/api/auth/github/callback" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
