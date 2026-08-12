import { RecordingProtocolError } from "./errors";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_LOOKUP = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export function encodeBase64Url(value: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < value.byteLength; offset += 3) {
    const first = value[offset] ?? 0;
    const second = value[offset + 1];
    const third = value[offset + 2];
    const aggregate = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64URL_ALPHABET[(aggregate >>> 18) & 63];
    result += BASE64URL_ALPHABET[(aggregate >>> 12) & 63];
    if (second !== undefined) {
      result += BASE64URL_ALPHABET[(aggregate >>> 6) & 63];
    }
    if (third !== undefined) {
      result += BASE64URL_ALPHABET[aggregate & 63];
    }
  }
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (
    value.length % 4 === 1 ||
    value.includes("=") ||
    [...value].some((character) => !BASE64URL_LOOKUP.has(character))
  ) {
    throw new RecordingProtocolError(
      "invalid_schema",
      "Value is not canonical unpadded base64url",
    );
  }

  const outputLength = Math.floor((value.length * 6) / 8);
  const result = new Uint8Array(outputLength);
  let buffer = 0;
  let bufferedBits = 0;
  let outputOffset = 0;

  for (const character of value) {
    const decoded = BASE64URL_LOOKUP.get(character);
    if (decoded === undefined) {
      throw new RecordingProtocolError(
        "invalid_schema",
        "Value is not canonical unpadded base64url",
      );
    }
    buffer = (buffer << 6) | decoded;
    bufferedBits += 6;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      result[outputOffset] = (buffer >>> bufferedBits) & 0xff;
      outputOffset += 1;
    }
  }

  if (bufferedBits > 0 && (buffer & ((1 << bufferedBits) - 1)) !== 0) {
    throw new RecordingProtocolError(
      "invalid_schema",
      "Value has non-canonical base64url trailing bits",
    );
  }
  return result;
}

export function encodeHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) {
    throw new RecordingProtocolError(
      "invalid_schema",
      "Value is not lowercase hex",
    );
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
