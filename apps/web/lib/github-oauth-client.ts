import {
  GithubOAuthUserSchema,
  type GithubOAuthAccessGrant,
  type GithubOAuthClient,
  type GithubOAuthUser,
} from "@understandproof/auth";
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
  .passthrough()
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

const GithubOAuthProviderErrorResponseSchema = z
  .object({
    error: z.enum([
      "bad_verification_code",
      "incorrect_client_credentials",
      "redirect_uri_mismatch",
      "unverified_user_email",
    ]),
  })
  .passthrough();

/**
 * GitHub may omit or null profile fields according to the exact user-token
 * permissions. Only the durable numeric id and login participate in our
 * authentication boundary, so validate those two provider fields and project
 * every other profile value away below.
 */
export const GithubAuthenticatedUserResponseSchema = z
  .object({
    login: z.string().min(1).max(39),
    id: z.number().int().positive().safe(),
  })
  .passthrough();

export type GithubOAuthProviderFailureReason =
  | z.infer<typeof GithubOAuthProviderErrorResponseSchema>["error"]
  | "invalid_provider_response"
  | "provider_request_failed";

export class GithubOAuthProviderError extends Error {
  readonly code = "GITHUB_OAUTH_PROVIDER_ERROR" as const;

  constructor(
    readonly reason: GithubOAuthProviderFailureReason = "provider_request_failed",
  ) {
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
  onFailure?: (
    stage: GithubOAuthProviderFailureStage,
    reason: GithubOAuthProviderFailureReason,
  ) => void;
}>;

export type GithubOAuthProviderFailureStage = "token_exchange" | "user_fetch";

export class GithubOAuthHttpClient implements GithubOAuthClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #now: () => number;
  readonly #onFailure: (
    stage: GithubOAuthProviderFailureStage,
    reason: GithubOAuthProviderFailureReason,
  ) => void;

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
    this.#onFailure = options.onFailure ?? (() => undefined);
  }

  async exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
      repositoryId?: string;
    }>,
  ): Promise<GithubOAuthAccessGrant> {
    try {
      return await this.#exchangeCode(input);
    } catch (error) {
      this.#reportFailure("token_exchange", providerFailureReason(error));
      throw new GithubOAuthProviderError();
    }
  }

  async #exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
      repositoryId?: string;
    }>,
  ): Promise<GithubOAuthAccessGrant> {
    const repositoryId =
      input.repositoryId === undefined
        ? undefined
        : DecimalIdSchema.safeParse(input.repositoryId);
    if (
      (repositoryId !== undefined && !repositoryId.success) ||
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
      ...(repositoryId ? { repository_id: repositoryId.data } : {}),
    });
    const payload = await this.#requestJson(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "slopproof/0.1.0",
      },
      body,
    });
    const providerError =
      GithubOAuthProviderErrorResponseSchema.safeParse(payload);
    if (providerError.success) {
      throw new GithubOAuthProviderError(providerError.data.error);
    }
    const response = TokenResponseSchema.safeParse(payload);
    if (!response.success) {
      throw new GithubOAuthProviderError("invalid_provider_response");
    }
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
    try {
      return await this.#getUser(accessToken);
    } catch (error) {
      this.#reportFailure("user_fetch", providerFailureReason(error));
      throw new GithubOAuthProviderError();
    }
  }

  async #getUser(accessToken: string): Promise<GithubOAuthUser> {
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

  #reportFailure(
    stage: GithubOAuthProviderFailureStage,
    reason: GithubOAuthProviderFailureReason,
  ): void {
    try {
      this.#onFailure(stage, reason);
    } catch {
      // Telemetry must never replace the fixed provider error.
    }
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

function providerFailureReason(
  error: unknown,
): GithubOAuthProviderFailureReason {
  return error instanceof GithubOAuthProviderError
    ? error.reason
    : "provider_request_failed";
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
