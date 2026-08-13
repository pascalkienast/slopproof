import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGithubAppJwt,
  isPrivateKeyFileMetadataSafe,
  RepositoryInstallationTokenCache,
} from "./app-auth";
import { GithubControlError } from "./production-errors";
import { githubRestClientStub } from "./production-testkit";

const tempDirectories: string[] = [];
const now = Date.UTC(2026, 7, 12, 12, 0, 0);
const binding = {
  installationId: "17",
  repositoryId: "42",
  owner: "acme",
  repositoryName: "cachekit",
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub App authentication", () => {
  it("builds a short-lived RS256 App JWT from a private file", async () => {
    const fixture = createRsaFixture(2_048);
    const token = await createGithubAppJwt({
      appId: "12345",
      privateKeyPath: fixture.path,
      now: () => now,
    });
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    if (signature === undefined) throw new Error("missing JWT signature");

    expect(JSON.parse(decodeJwtPart(encodedHeader))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(decodeJwtPart(encodedPayload))).toEqual({
      iat: now / 1_000 - 5,
      exp: now / 1_000 + 540,
      iss: "12345",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey(fixture.publicKey),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects relative, symlinked, permissive, and weak key files", async () => {
    const fixture = createRsaFixture(2_048);
    const link = join(fixture.directory, "linked.pem");
    symlinkSync(fixture.path, link);
    await expect(
      createGithubAppJwt({ appId: "1", privateKeyPath: link }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_FILE" });

    chmodSync(fixture.path, 0o644);
    await expect(
      createGithubAppJwt({ appId: "1", privateKeyPath: fixture.path }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_FILE" });
    await expect(
      createGithubAppJwt({ appId: "1", privateKeyPath: "key.pem" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const weak = createRsaFixture(1_024);
    await expect(
      createGithubAppJwt({ appId: "1", privateKeyPath: weak.path }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_FILE" });

    await expect(
      createGithubAppJwt({
        appId: "1",
        privateKeyPath: join(fixture.directory, "missing.pem"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_FILE" });

    const { privateKey: ecPrivateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const ecPath = join(fixture.directory, "ec-private-key.pem");
    writeFileSync(ecPath, ecPrivateKey, { mode: 0o600 });
    await expect(
      createGithubAppJwt({ appId: "1", privateKeyPath: ecPath }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_FILE" });
  });

  it("accepts only the safe root-owned named-ACL stat projection", () => {
    const metadata = (
      mode: number,
      uid = 0,
      gid = 0,
    ): Parameters<typeof isPrivateKeyFileMetadataSafe>[0] => ({
      gid,
      isFile: () => true,
      mode,
      size: 1_700,
      uid,
    });
    const containerIdentity = { effectiveUserId: 1_000, groups: [1_000] };

    expect(
      isPrivateKeyFileMetadataSafe(metadata(0o100640), containerIdentity),
    ).toBe(true);
    expect(
      isPrivateKeyFileMetadataSafe(
        metadata(0o100600, 1_000, 1_000),
        containerIdentity,
      ),
    ).toBe(true);

    for (const unsafe of [
      metadata(0o100640, 1_000, 1_000),
      metadata(0o100660),
      metadata(0o100644),
      metadata(0o100740),
      metadata(0o104640),
    ]) {
      expect(isPrivateKeyFileMetadataSafe(unsafe, containerIdentity)).toBe(
        false,
      );
    }
    expect(
      isPrivateKeyFileMetadataSafe(metadata(0o100640), {
        effectiveUserId: 1_000,
        groups: [0, 1_000],
      }),
    ).toBe(false);
    expect(
      isPrivateKeyFileMetadataSafe(metadata(0o100640), {
        effectiveUserId: 0,
        groups: [0],
      }),
    ).toBe(false);
  });
});

describe("repository installation token cache", () => {
  it("singleflights a forced refresh and supersedes the cached token", async () => {
    const fixture = createRsaFixture(2_048);
    let sequence = 0;
    const cache = new RepositoryInstallationTokenCache({
      appId: "12345",
      privateKeyPath: fixture.path,
      now: () => now,
      clientFactory: () =>
        githubRestClientStub({
          createInstallationAccessToken: async () => {
            sequence += 1;
            return {
              data: {
                token: `installation-token-${sequence}`,
                expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
              },
            };
          },
        }),
    });

    await expect(cache.get(binding)).resolves.toBe("installation-token-1");
    await expect(
      Promise.all([
        cache.getFresh(binding),
        cache.getFresh(binding),
        cache.getFresh(binding),
      ]),
    ).resolves.toEqual([
      "installation-token-2",
      "installation-token-2",
      "installation-token-2",
    ]);
    await expect(cache.get(binding)).resolves.toBe("installation-token-2");
    expect(sequence).toBe(2);
  });

  it("singleflights and reuses a repository-bound token before its skew", async () => {
    const fixture = createRsaFixture(2_048);
    const createToken = vi.fn(async (_input: unknown) => ({
      data: {
        token: "installation-token-1",
        expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
      },
    }));
    const authorizations: string[] = [];
    const cache = new RepositoryInstallationTokenCache({
      appId: "12345",
      privateKeyPath: fixture.path,
      now: () => now,
      clientFactory: (authorization) => {
        authorizations.push(authorization);
        return githubRestClientStub({
          createInstallationAccessToken: createToken,
        });
      },
    });

    const tokens = await Promise.all([
      cache.get(binding),
      cache.get(binding),
      cache.get({ ...binding }),
    ]);
    expect(tokens).toEqual([
      "installation-token-1",
      "installation-token-1",
      "installation-token-1",
    ]);
    expect(createToken).toHaveBeenCalledTimes(1);
    expect(createToken.mock.calls[0]?.[0]).toEqual({
      installationId: 17,
      repositoryId: 42,
    });
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.split(".")).toHaveLength(3);
  });

  it("keys tokens by installation and repository and refreshes inside skew", async () => {
    const fixture = createRsaFixture(2_048);
    let clock = now;
    let sequence = 0;
    const createToken = vi.fn(async () => {
      sequence += 1;
      return {
        data: {
          token: `installation-token-${sequence}`,
          expires_at: new Date(clock + 10 * 60 * 1_000).toISOString(),
        },
      };
    });
    const cache = new RepositoryInstallationTokenCache({
      appId: "12345",
      privateKeyPath: fixture.path,
      now: () => clock,
      clientFactory: () =>
        githubRestClientStub({
          createInstallationAccessToken: createToken,
        }),
    });

    expect(await cache.get(binding)).toBe("installation-token-1");
    expect(
      await cache.get({
        ...binding,
        repositoryId: "43",
        repositoryName: "api",
      }),
    ).toBe("installation-token-2");
    clock += 6 * 60 * 1_000;
    expect(await cache.get(binding)).toBe("installation-token-3");
    expect(createToken).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed or already-too-short-lived token responses", async () => {
    const fixture = createRsaFixture(2_048);
    const cache = new RepositoryInstallationTokenCache({
      appId: "12345",
      privateKeyPath: fixture.path,
      now: () => now,
      clientFactory: () =>
        githubRestClientStub({
          createInstallationAccessToken: async () => ({
            data: {
              token: "installation-token-1",
              expires_at: new Date(now + 60_000).toISOString(),
            },
          }),
        }),
      requestPolicy: { maxAttempts: 1 },
    });
    await expect(cache.get(binding)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("does not expose an upstream secret-bearing error", async () => {
    const fixture = createRsaFixture(2_048);
    const secret = "installation-token-must-not-leak";
    const cache = new RepositoryInstallationTokenCache({
      appId: "12345",
      privateKeyPath: fixture.path,
      clientFactory: () =>
        githubRestClientStub({
          createInstallationAccessToken: async () => {
            throw new Error(`upstream rejected ${secret}`);
          },
        }),
      requestPolicy: { maxAttempts: 1 },
    });
    const error = await cache.get(binding).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubControlError);
    expect(String(error)).not.toContain(secret);
  });
});

function createRsaFixture(modulusLength: number): {
  directory: string;
  path: string;
  publicKey: string;
} {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "slopproof-github-auth-")),
  );
  tempDirectories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const path = join(directory, "github-app.pem");
  writeFileSync(path, privateKey, { mode: 0o600 });
  return { directory, path, publicKey };
}

function decodeJwtPart(value: string | undefined): string {
  if (value === undefined) throw new Error("missing JWT part");
  return Buffer.from(value, "base64url").toString("utf8");
}
