import { describe, expect, it, vi } from "vitest";
import { handleGithubControlHealthRequest } from "./health";

describe("GitHub Control health server", () => {
  it("exposes only an exact, value-free readiness response", async () => {
    let ready = false;
    const writeHead = vi.fn();
    const end = vi.fn();
    const response = { end, writeHead };

    handleGithubControlHealthRequest(
      { method: "GET", url: "/healthz" },
      response,
      () => ready,
    );
    expect(writeHead).toHaveBeenLastCalledWith(
      503,
      expect.objectContaining({
        "cache-control": "no-store, max-age=0",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "content-type": "application/json; charset=utf-8",
      }),
    );
    expect(end).toHaveBeenLastCalledWith('{"status":"starting"}');

    ready = true;
    handleGithubControlHealthRequest(
      { method: "GET", url: "/healthz" },
      response,
      () => ready,
    );
    expect(writeHead).toHaveBeenLastCalledWith(200, expect.any(Object));
    expect(end).toHaveBeenLastCalledWith('{"status":"ok"}');

    handleGithubControlHealthRequest(
      { method: "GET", url: "/healthz?detail=true" },
      response,
      () => ready,
    );
    expect(writeHead).toHaveBeenLastCalledWith(404, expect.any(Object));
    expect(end).toHaveBeenLastCalledWith('{"error":"not_found"}');
    handleGithubControlHealthRequest(
      { method: "POST", url: "/healthz" },
      response,
      () => ready,
    );
    expect(writeHead).toHaveBeenLastCalledWith(
      405,
      expect.objectContaining({ allow: "GET" }),
    );
    expect(end).toHaveBeenLastCalledWith('{"error":"method_not_allowed"}');
  });
});
