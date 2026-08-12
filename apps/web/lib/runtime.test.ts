import { describe, expect, it, vi } from "vitest";
import { createRetryableRuntimeGetter } from "./runtime";

describe("createRetryableRuntimeGetter", () => {
  it("shares an in-flight start and caches a successful runtime", async () => {
    const factory = vi.fn(async () => ({ ready: true }));
    const getRuntime = createRetryableRuntimeGetter(factory);

    const first = getRuntime();
    const second = getRuntime();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ ready: true });
    await expect(getRuntime()).resolves.toEqual({ ready: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("drops a rejected start so the next request can recover", async () => {
    const factory = vi
      .fn<() => Promise<{ ready: true }>>()
      .mockRejectedValueOnce(new Error("transient startup failure"))
      .mockResolvedValueOnce({ ready: true });
    const getRuntime = createRetryableRuntimeGetter(factory);

    await expect(getRuntime()).rejects.toThrow("transient startup failure");
    await expect(getRuntime()).resolves.toEqual({ ready: true });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
