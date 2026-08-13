import type { z } from "zod";

export class RequestBodyTooLargeError extends Error {
  readonly code = "REQUEST_BODY_TOO_LARGE" as const;
}

export class InvalidRequestBodyEncodingError extends Error {
  readonly code = "INVALID_REQUEST_BODY_ENCODING" as const;
}

export class InvalidRequestBodyError extends Error {
  readonly code = "INVALID_REQUEST_BODY" as const;
}

export async function requireEmptyRequestBody(request: Request): Promise<void> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "0") {
    throw new InvalidRequestBodyError("Request body must be empty.");
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done && first.value.byteLength > 0) {
      await reader.cancel();
      throw new InvalidRequestBodyError("Request body must be empty.");
    }
    const second = await reader.read();
    if (!second.done) {
      await reader.cancel();
      throw new InvalidRequestBodyError("Request body must be empty.");
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson<Schema extends z.ZodType>(
  request: Request,
  maximumBytes: number,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (!isUtf8JsonContentType(request.headers.get("content-type"))) {
    throw new InvalidRequestBodyError("Content-Type must be UTF-8 JSON.");
  }
  const body = await readBoundedUtf8Body(request, maximumBytes);
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    Number(declared) !== Buffer.byteLength(body, "utf8")
  ) {
    throw new InvalidRequestBodyError("Declared request length is not exact.");
  }
  try {
    return schema.parse(JSON.parse(body) as unknown) as z.output<Schema>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InvalidRequestBodyError("Request body is not valid JSON.", {
        cause: error,
      });
    }
    throw error;
  }
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

function isUtf8JsonContentType(value: string | null): boolean {
  if (!value || value.length > 128 || /[\0\r\n]/u.test(value)) return false;
  const fields = value.split(";").map((field) => field.trim());
  if (fields[0]?.toLowerCase() !== "application/json") return false;
  return (
    fields.length === 1 ||
    (fields.length === 2 && fields[1]?.toLowerCase() === "charset=utf-8")
  );
}
