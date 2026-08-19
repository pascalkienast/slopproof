import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReviewQueuePage, { GithubMaintainerLogin, ReviewAuthWall } from "./page";

const LEAK_OWNER = "secret-private-owner";
const LEAK_NAME = "secret-private-repo";
const LEAK_ID = "10000000-0000-4000-8000-000000000002";
const BOUND_ID = "40000000-0000-4000-8000-000000000005";

const mocks = {
  getWebRuntime: vi.fn(),
  readPageSessionRequest: vi.fn(),
  cookiesGet: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookiesGet }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("../../lib/runtime", () => ({
  getWebRuntime: () => mocks.getWebRuntime(),
}));

vi.mock("../../lib/http-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPageSessionRequest: (...args: unknown[]) =>
    mocks.readPageSessionRequest(...args),
}));

describe("review auth wall", () => {
  beforeEach(() => {
    mocks.getWebRuntime.mockReset();
    mocks.readPageSessionRequest.mockReset();
    mocks.cookiesGet.mockReset();
    mocks.cookiesGet.mockReturnValue(undefined);
    mocks.readPageSessionRequest.mockResolvedValue(null);
  });

  it("renders one GitHub authorize CTA and no installation owner/name", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: LEAK_ID, owner: LEAK_OWNER, name: LEAK_NAME }],
      rowCount: 1,
    }));
    mocks.getWebRuntime.mockResolvedValue({
      config: {
        DEMO_MODE: false,
        DEPLOYMENT_PROFILE: "production",
        APP_BASE_URL: "https://slopproof.example/",
        SESSION_SECRET: "review-page-session-secret-that-is-32b",
      },
      database: { pool: { query } },
    });
    const html = renderToStaticMarkup(
      await ReviewQueuePage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("Maintainer authorization required.");
    expect(html).toContain("Authorize with GitHub");
    expect(html).toContain("/api/auth/github/start?returnTo=%2Freview");
    expect(html).not.toContain("repositoryId=");
    expect(html).not.toContain(LEAK_OWNER);
    expect(html).not.toContain(LEAK_NAME);
    expect(html).not.toContain(`${LEAK_OWNER}/${LEAK_NAME}`);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps a bound inbound repository authorize path", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewAuthWall, {
        demoMode: false,
        directory: null,
        pageAuth: false,
        requestedRepository: {
          id: BOUND_ID,
          owner: "acme",
          name: "cachekit",
        },
        sessionMismatch: false,
      }),
    );
    expect(html).toContain("acme/cachekit");
    expect(html).toContain(`repositoryId=${BOUND_ID}`);
    expect(html).toContain("Authorize with GitHub");
    expect(html).not.toContain(LEAK_OWNER);
  });

  it("shows only identified maintainer repositories after the directory cookie", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewAuthWall, {
        demoMode: false,
        directory: [
          { id: BOUND_ID, owner: "acme", name: "cachekit" },
          {
            id: "50000000-0000-4000-8000-000000000006",
            owner: "acme",
            name: "second",
          },
        ],
        pageAuth: false,
        requestedRepository: undefined,
        sessionMismatch: false,
      }),
    );
    expect(html).toContain("Choose a repository to review.");
    expect(html).toContain("Authorize acme/cachekit");
    expect(html).toContain("Authorize acme/second");
    expect(html).not.toContain(LEAK_OWNER);
    expect(html).not.toContain("Authorize with GitHub");
  });

  it("does not render a public picker from the installation set when identify is empty", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewAuthWall, {
        demoMode: false,
        directory: [],
        pageAuth: false,
        requestedRepository: undefined,
        sessionMismatch: false,
      }),
    );
    expect(html).toContain("No repositories available.");
    expect(html).toContain("Authorize with GitHub");
    expect(html).not.toContain("repositoryId=");
    expect(html).not.toContain(LEAK_OWNER);
    expect(html).not.toContain(LEAK_NAME);
  });

  it("starts identify without a repository id", () => {
    const html = renderToStaticMarkup(
      createElement(GithubMaintainerLogin, {
        identify: true,
        repositories: [{ id: LEAK_ID, owner: LEAK_OWNER, name: LEAK_NAME }],
      }),
    );
    expect(html).toContain('href="/api/auth/github/start?returnTo=%2Freview"');
    expect(html).not.toContain("repositoryId=");
    expect(html).not.toContain(LEAK_OWNER);
    expect(html).not.toContain(LEAK_NAME);
  });
});
