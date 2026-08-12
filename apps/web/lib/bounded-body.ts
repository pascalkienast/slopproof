export class RequestBodyTooLargeError extends Error {
  readonly code = "REQUEST_BODY_TOO_LARGE" as const;
}

export class InvalidRequestBodyEncodingError extends Error {
  readonly code = "INVALID_REQUEST_BODY_ENCODING" as const;
}

export async function readBoundedUtf8Body(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new InvalidRequestBodyEncodingError("Request body is not UTF-8", {
      cause: error,
    });
  }
}

export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > maximumBytes
    ) {
      throw new RequestBodyTooLargeError();
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
