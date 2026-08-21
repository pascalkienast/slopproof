import { describe, expect, it } from "vitest";
import {
  evidenceProxyResponseHeaders,
  tapEvidenceProxyBody,
} from "./evidence-proxy";

const LIVE_REVIEW_BYTES = 15_193_871;

describe("review evidence proxy contract", () => {
  it("forwards video/webm and omits Content-Length", () => {
    const { headers, declaredLength } = evidenceProxyResponseHeaders(
      new Headers({
        "content-type": "video/webm;codecs=vp8,opus",
        "content-length": String(LIVE_REVIEW_BYTES),
        "cache-control": "public, max-age=60",
      }),
    );

    expect(headers.get("content-type")).toBe("video/webm;codecs=vp8,opus");
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(declaredLength).toBe(LIVE_REVIEW_BYTES);
  });

  it("treats a missing or non-integer Content-Length as absent", () => {
    expect(
      evidenceProxyResponseHeaders(
        new Headers({ "content-type": "video/webm" }),
      ).declaredLength,
    ).toBeUndefined();
    expect(
      evidenceProxyResponseHeaders(
        new Headers({
          "content-type": "video/webm",
          "content-length": "not-a-length",
        }),
      ).declaredLength,
    ).toBeUndefined();
  });

  it("streams a 15MB-class body without dropping bytes", async () => {
    const source = webmOfSize(LIVE_REVIEW_BYTES);
    const received: number[] = [];
    const tapped = tapEvidenceProxyBody(new Blob([source]).stream(), (bytes) =>
      received.push(bytes),
    );
    const assembled = new Uint8Array(await new Response(tapped).arrayBuffer());

    expect(assembled.byteLength).toBe(LIVE_REVIEW_BYTES);
    expect(assembled[0]).toBe(0x1a);
    expect(assembled[1]).toBe(0x45);
    expect(assembled[2]).toBe(0xdf);
    expect(assembled[3]).toBe(0xa3);
    expect(received.at(-1)).toBe(LIVE_REVIEW_BYTES);
  });
});

function webmOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}
