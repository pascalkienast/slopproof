export const EVIDENCE_PROXY_FORWARDED_HEADERS = ["content-type"] as const;

export type EvidenceProxyHeaders = {
  headers: Headers;
  declaredLength: number | undefined;
};

export function parseEvidenceContentLength(
  raw: string | null,
): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The worker may declare plaintext Content-Length. Next must not forward it:
 * a proxied or canceled body that is shorter than that header is what made
 * the player treat a complete WebM as transfer_incomplete.
 */
export function evidenceProxyResponseHeaders(
  upstream: Headers,
): EvidenceProxyHeaders {
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
  });
  for (const name of EVIDENCE_PROXY_FORWARDED_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return {
    headers,
    declaredLength: parseEvidenceContentLength(upstream.get("content-length")),
  };
}

export function tapEvidenceProxyBody(
  body: ReadableStream<Uint8Array>,
  onBytes: (received: number) => void,
): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        onBytes(received);
        controller.enqueue(chunk);
      },
    }),
  );
}
