import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedBody,
  readBoundedJson,
  readBoundedUtf8Body,
  requireEmptyRequestBody,
  RequestBodyTooLargeError,
} from "./bounded-body";

describe("bounded request bodies", () => {
  it("returns exact binary bytes across stream chunks", async () => {
    const chunks = [new Uint8Array([0, 255]), new Uint8Array([1, 2, 3])];
    const request = new Request("https://slopproof.test/webhook", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedBody(request, 5)).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2, 3]),
    );
  });

  it("reads UTF-8 only up to the byte limit", async () => {
    const request = new Request("https://slopproof.test/finalize", {
      method: "POST",
      body: "€",
    });

    await expect(readBoundedUtf8Body(request, 3)).resolves.toBe("€");
  });

  it("rejects an oversized declared body before reading it", async () => {
    const request = new Request("https://slopproof.test/finalize", {
      method: "POST",
      headers: { "content-length": "513" },
      body: "{}",
    });

    await expect(readBoundedUtf8Body(request, 512)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("stops a streamed body that crosses the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    const request = new Request("https://slopproof.test/finalize", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedUtf8Body(request, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("rejects malformed UTF-8", async () => {
    const request = new Request("https://slopproof.test/finalize", {
      method: "POST",
      body: new Uint8Array([0xff]),
    });

    await expect(readBoundedUtf8Body(request, 1)).rejects.toBeInstanceOf(
      InvalidRequestBodyEncodingError,
    );
  });

  it("parses strict JSON only after exact byte and UTF-8 checks", async () => {
    const request = new Request("https://slopproof.test/upload", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ uploadSessionId: "session" }),
    });

    await expect(
      readBoundedJson(
        request,
        128,
        z.object({ uploadSessionId: z.literal("session") }).strict(),
      ),
    ).resolves.toEqual({ uploadSessionId: "session" });
  });

  it("rejects non-JSON media types and non-UTF-8 charset claims", async () => {
    for (const contentType of [
      "text/plain",
      "application/json; charset=latin1",
      "application/json; profile=anything",
    ]) {
      const request = new Request("https://slopproof.test/upload", {
        method: "POST",
        headers: { "content-type": contentType },
        body: "{}",
      });
      await expect(
        readBoundedJson(request, 16, z.object({}).strict()),
      ).rejects.toBeInstanceOf(InvalidRequestBodyError);
    }
  });

  it("rejects a declared length that does not equal the consumed JSON bytes", async () => {
    const request = new Request("https://slopproof.test/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "3",
      },
      body: "{}",
    });

    await expect(
      readBoundedJson(request, 16, z.object({}).strict()),
    ).rejects.toBeInstanceOf(InvalidRequestBodyError);
  });

  it("accepts a bodyless mutation and rejects any streamed body bytes", async () => {
    await expect(
      requireEmptyRequestBody(
        new Request("https://slopproof.test/handoff", { method: "POST" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      requireEmptyRequestBody(
        new Request("https://slopproof.test/handoff", {
          method: "POST",
          body: new Uint8Array([0]),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidRequestBodyError);
  });
});
