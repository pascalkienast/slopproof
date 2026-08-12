import { describe, expect, it } from "vitest";
import {
  InvalidRequestBodyEncodingError,
  readBoundedUtf8Body,
  RequestBodyTooLargeError,
} from "./bounded-body";

describe("bounded request bodies", () => {
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
});
