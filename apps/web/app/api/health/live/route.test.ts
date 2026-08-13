import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health/live", () => {
  it("is runtime-independent, strict and non-cacheable", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(JSON.stringify(await GET().json())).toBe('{"status":"ok"}');
  });
});
