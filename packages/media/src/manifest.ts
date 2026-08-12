import { MAX_FINALIZE_JSON_BYTES } from "./constants";
import {
  bytesEqual,
  decodeBase64Url,
  decodeHex,
  encodeBase64Url,
  encodeHex,
  utf8Bytes,
} from "./encoding";
import { RecordingProtocolError } from "./errors";
import { canonicalManifestBytes } from "./canonical";
import {
  sha256,
  signManifestBytes,
  verifyManifestBytes,
  type CryptoOptions,
} from "./crypto";
import {
  RecordingManifestSchema,
  Sha256Schema,
  type RecordingManifest,
} from "./schemas";

export type AuthenticatedManifest = {
  manifest: RecordingManifest;
  manifestTagBase64url: string;
  manifestDigest: string;
};

export function assertFinalizeJsonLimit(value: unknown): void {
  let encoded: Uint8Array;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") {
      throw new TypeError("Value is not JSON serializable");
    }
    encoded = utf8Bytes(json);
  } catch (error) {
    throw new RecordingProtocolError(
      "invalid_schema",
      "Finalize value cannot be represented as JSON",
      { cause: error },
    );
  }
  if (encoded.byteLength > MAX_FINALIZE_JSON_BYTES) {
    throw new RecordingProtocolError(
      "limit_exceeded",
      "Finalize JSON exceeds the protocol limit",
    );
  }
}

export async function authenticateManifest(
  manifestInput: RecordingManifest,
  manifestKey: CryptoKey,
  options: CryptoOptions = {},
): Promise<AuthenticatedManifest> {
  const manifest = RecordingManifestSchema.parse(manifestInput);
  const canonicalBytes = canonicalManifestBytes(manifest);
  const [tag, digest] = await Promise.all([
    signManifestBytes(manifestKey, canonicalBytes, options),
    sha256(canonicalBytes, options),
  ]);
  const result = {
    manifest,
    manifestTagBase64url: encodeBase64Url(tag),
    manifestDigest: encodeHex(digest),
  };
  assertFinalizeJsonLimit(result);
  return result;
}

export async function verifyAuthenticatedManifest(
  input: {
    manifest: RecordingManifest;
    manifestTagBase64url: string;
    manifestDigest: string;
  },
  manifestKey: CryptoKey,
  options: CryptoOptions = {},
): Promise<RecordingManifest> {
  const manifest = RecordingManifestSchema.parse(input.manifest);
  const suppliedDigest = Sha256Schema.parse(input.manifestDigest);
  const canonicalBytes = canonicalManifestBytes(manifest);
  const calculatedDigest = await sha256(canonicalBytes, options);
  const digestMatches = bytesEqual(calculatedDigest, decodeHex(suppliedDigest));
  if (!digestMatches) {
    throw new RecordingProtocolError(
      "invalid_manifest",
      "Manifest digest does not match canonical bytes",
    );
  }

  let tag: Uint8Array;
  try {
    tag = decodeBase64Url(input.manifestTagBase64url);
  } catch (error) {
    throw new RecordingProtocolError(
      "invalid_manifest",
      "Invalid manifest tag",
      {
        cause: error,
      },
    );
  }
  if (!(await verifyManifestBytes(manifestKey, canonicalBytes, tag, options))) {
    throw new RecordingProtocolError(
      "authentication_failed",
      "Manifest authentication failed",
    );
  }
  return manifest;
}
