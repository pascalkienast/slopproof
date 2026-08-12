import { z } from "zod";
import {
  AES_GCM_TAG_BYTES,
  MANIFEST_TAG_BYTES,
  MAX_FINALIZE_JSON_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_PLAINTEXT_CHUNK_BYTES,
  MAX_RECORDING_CHUNKS,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  MAX_UINT32,
  NONCE_PREFIX_BYTES,
  RECORD_HEADER_BYTES,
  RECORDING_CODEC,
  RECORDING_PROTOCOL_VERSION,
  RECORDING_SUITE_ID,
  S3_MINIMUM_NONFINAL_PART_BYTES,
  WRAPPING_ALGORITHM,
} from "./constants";
import { decodeBase64Url, encodeBase64Url } from "./encoding";
import { buildChunkNonce } from "./nonce";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headShaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const canonicalIsoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CanonicalTimestampSchema = z
  .string()
  .regex(canonicalIsoTimestampPattern)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Timestamp must be valid",
  );

function hasDecodedLength(value: string, expectedBytes: number): boolean {
  try {
    return decodeBase64Url(value).byteLength === expectedBytes;
  } catch {
    return false;
  }
}

const safeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const uint32Schema = safeIntegerSchema.max(MAX_UINT32);

export const CanonicalUuidSchema = z.string().regex(canonicalUuidPattern);
export const HeadShaSchema = z.string().regex(headShaPattern);
export const Sha256Schema = z.string().regex(sha256Pattern);
export const Base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .refine((value) => {
    try {
      decodeBase64Url(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be canonical unpadded base64url");

export const RecordingBindingSchema = z
  .object({
    attemptId: CanonicalUuidSchema,
    headSha: HeadShaSchema,
    objectId: CanonicalUuidSchema,
  })
  .strict();

export const ChunkAadContextSchema = RecordingBindingSchema.extend({
  codec: z.literal(RECORDING_CODEC),
  chunkIndex: uint32Schema,
  nonceBase64url: Base64UrlSchema.refine(
    (value) => hasDecodedLength(value, 12),
    "Nonce must decode to 12 bytes",
  ),
  plaintextBytes: safeIntegerSchema.min(1).max(MAX_PLAINTEXT_CHUNK_BYTES),
}).strict();

export const ManifestChunkSchema = z
  .object({
    index: uint32Schema,
    nonce: Base64UrlSchema.refine(
      (value) => hasDecodedLength(value, 12),
      "Nonce must decode to 12 bytes",
    ),
    plaintextBytes: safeIntegerSchema.min(1).max(MAX_PLAINTEXT_CHUNK_BYTES),
    sealedBytes: safeIntegerSchema
      .min(AES_GCM_TAG_BYTES + 1)
      .max(MAX_PLAINTEXT_CHUNK_BYTES + AES_GCM_TAG_BYTES),
    ciphertextSha256: Sha256Schema,
  })
  .strict();

export const ManifestPartSchema = z
  .object({
    partNumber: safeIntegerSchema.min(1).max(MAX_MULTIPART_PARTS),
    firstChunkIndex: uint32Schema,
    lastChunkIndex: uint32Schema,
    byteLength: safeIntegerSchema.min(1).max(MAX_RECORDING_OBJECT_BYTES),
    sha256: Sha256Schema,
  })
  .strict();

export const ManifestWrappingSchema = z
  .object({
    materialId: CanonicalUuidSchema,
    keyId: z.string().regex(keyIdPattern),
    algorithm: z.literal(WRAPPING_ALGORITHM),
    wrappedKeySha256: Sha256Schema,
  })
  .strict();

export const RecordingManifestSchema = z
  .object({
    protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
    suiteId: z.literal(RECORDING_SUITE_ID),
    attemptId: CanonicalUuidSchema,
    headSha: HeadShaSchema,
    objectId: CanonicalUuidSchema,
    codec: z.literal(RECORDING_CODEC),
    noncePrefixBase64url: Base64UrlSchema.refine(
      (value) => hasDecodedLength(value, NONCE_PREFIX_BYTES),
      `Nonce prefix must decode to ${String(NONCE_PREFIX_BYTES)} bytes`,
    ),
    wrapping: ManifestWrappingSchema,
    durationMs: safeIntegerSchema.max(MAX_RECORDING_DURATION_MS),
    totalPlaintextBytes: safeIntegerSchema
      .min(1)
      .max(MAX_RECORDING_OBJECT_BYTES),
    totalObjectBytes: safeIntegerSchema.min(1).max(MAX_RECORDING_OBJECT_BYTES),
    chunks: z.array(ManifestChunkSchema).min(1).max(MAX_RECORDING_CHUNKS),
    parts: z.array(ManifestPartSchema).min(1).max(MAX_MULTIPART_PARTS),
  })
  .strict()
  .superRefine((manifest, context) => {
    const prefix = decodeBase64Url(manifest.noncePrefixBase64url);
    let plaintextTotal = 0;
    let objectTotal = 0;
    const nonces = new Set<string>();

    manifest.chunks.forEach((chunk, index) => {
      if (chunk.index !== index) {
        context.addIssue({
          code: "custom",
          message: "Chunk indices must be contiguous and start at zero",
          path: ["chunks", index, "index"],
        });
      }
      if (chunk.sealedBytes !== chunk.plaintextBytes + AES_GCM_TAG_BYTES) {
        context.addIssue({
          code: "custom",
          message: "Sealed length must equal plaintext length plus GCM tag",
          path: ["chunks", index, "sealedBytes"],
        });
      }
      const expectedNonce = encodeBase64Url(
        buildChunkNonce(prefix, chunk.index),
      );
      if (chunk.nonce !== expectedNonce) {
        context.addIssue({
          code: "custom",
          message: "Chunk nonce does not match prefix and index",
          path: ["chunks", index, "nonce"],
        });
      }
      if (nonces.has(chunk.nonce)) {
        context.addIssue({
          code: "custom",
          message: "Chunk nonces must be unique",
          path: ["chunks", index, "nonce"],
        });
      }
      nonces.add(chunk.nonce);
      plaintextTotal += chunk.plaintextBytes;
      objectTotal += RECORD_HEADER_BYTES + chunk.sealedBytes;
    });

    if (manifest.totalPlaintextBytes !== plaintextTotal) {
      context.addIssue({
        code: "custom",
        message: "Plaintext byte total does not match chunks",
        path: ["totalPlaintextBytes"],
      });
    }
    if (manifest.totalObjectBytes !== objectTotal) {
      context.addIssue({
        code: "custom",
        message: "Object byte total does not match chunk records",
        path: ["totalObjectBytes"],
      });
    }

    let expectedFirstChunk = 0;
    let partByteTotal = 0;
    manifest.parts.forEach((part, index) => {
      if (part.partNumber !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Part numbers must be contiguous and start at one",
          path: ["parts", index, "partNumber"],
        });
      }
      if (
        part.firstChunkIndex !== expectedFirstChunk ||
        part.lastChunkIndex < part.firstChunkIndex ||
        part.lastChunkIndex >= manifest.chunks.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Part chunk ranges must be contiguous, unique and complete",
          path: ["parts", index],
        });
      }

      const expectedPartBytes = manifest.chunks
        .slice(part.firstChunkIndex, part.lastChunkIndex + 1)
        .reduce(
          (total, chunk) => total + RECORD_HEADER_BYTES + chunk.sealedBytes,
          0,
        );
      if (part.byteLength !== expectedPartBytes) {
        context.addIssue({
          code: "custom",
          message: "Part byte length does not match its complete records",
          path: ["parts", index, "byteLength"],
        });
      }
      if (
        index < manifest.parts.length - 1 &&
        part.byteLength < S3_MINIMUM_NONFINAL_PART_BYTES
      ) {
        context.addIssue({
          code: "custom",
          message: "A non-final multipart part is below the S3 minimum",
          path: ["parts", index, "byteLength"],
        });
      }
      expectedFirstChunk = part.lastChunkIndex + 1;
      partByteTotal += part.byteLength;
    });

    if (expectedFirstChunk !== manifest.chunks.length) {
      context.addIssue({
        code: "custom",
        message: "Part ranges do not cover every chunk exactly once",
        path: ["parts"],
      });
    }
    if (partByteTotal !== manifest.totalObjectBytes) {
      context.addIssue({
        code: "custom",
        message: "Part byte total does not match object size",
        path: ["parts"],
      });
    }
  });

export const PublicWrappingMaterialSchema = RecordingBindingSchema.extend({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  suiteId: z.literal(RECORDING_SUITE_ID),
  materialId: CanonicalUuidSchema,
  keyId: z.string().regex(keyIdPattern),
  algorithm: z.literal(WRAPPING_ALGORITHM),
  spkiBase64url: Base64UrlSchema.min(1).max(16 * 1024),
  usableUntil: CanonicalTimestampSchema,
}).strict();

export const WrappedMasterKeySchema = z
  .object({
    materialId: CanonicalUuidSchema,
    keyId: z.string().regex(keyIdPattern),
    algorithm: z.literal(WRAPPING_ALGORITHM),
    wrappedKeyBase64url: Base64UrlSchema.min(1).max(2048),
    wrappedKeySha256: Sha256Schema,
  })
  .strict();

export const UploadedPartReceiptSchema = z
  .object({
    partNumber: safeIntegerSchema.min(1).max(MAX_MULTIPART_PARTS),
    etag: z.string().min(1).max(512),
  })
  .strict();

export const ProviderListedPartSchema = z
  .object({
    partNumber: safeIntegerSchema.min(1).max(MAX_MULTIPART_PARTS),
    byteLength: safeIntegerSchema.min(1).max(MAX_RECORDING_OBJECT_BYTES),
    etag: z.string().min(1).max(512),
  })
  .strict();

export const FinalizeRecordingSchema = z
  .object({
    manifest: RecordingManifestSchema,
    manifestTagBase64url: Base64UrlSchema.refine(
      (value) => hasDecodedLength(value, MANIFEST_TAG_BYTES),
      `Manifest tag must decode to ${String(MANIFEST_TAG_BYTES)} bytes`,
    ),
    manifestDigest: Sha256Schema,
    wrappedKey: WrappedMasterKeySchema,
    uploadedParts: z
      .array(UploadedPartReceiptSchema)
      .min(1)
      .max(MAX_MULTIPART_PARTS),
  })
  .strict()
  .superRefine((finalization, context) => {
    const { wrapping } = finalization.manifest;
    if (
      finalization.wrappedKey.materialId !== wrapping.materialId ||
      finalization.wrappedKey.keyId !== wrapping.keyId ||
      finalization.wrappedKey.algorithm !== wrapping.algorithm ||
      finalization.wrappedKey.wrappedKeySha256 !== wrapping.wrappedKeySha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Wrapped key does not match the manifest binding",
        path: ["wrappedKey"],
      });
    }
    if (
      finalization.uploadedParts.length !== finalization.manifest.parts.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Uploaded part receipts do not match manifest parts",
        path: ["uploadedParts"],
      });
    }
    finalization.uploadedParts.forEach((part, index) => {
      if (part.partNumber !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Uploaded part receipts must be ordered and contiguous",
          path: ["uploadedParts", index, "partNumber"],
        });
      }
    });

    if (
      new TextEncoder().encode(JSON.stringify(finalization)).byteLength >
      MAX_FINALIZE_JSON_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Finalize JSON exceeds its protocol limit",
      });
    }
  });

export type RecordingBinding = z.infer<typeof RecordingBindingSchema>;
export type ChunkAadContext = z.infer<typeof ChunkAadContextSchema>;
export type ManifestChunk = z.infer<typeof ManifestChunkSchema>;
export type ManifestPart = z.infer<typeof ManifestPartSchema>;
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;
export type PublicWrappingMaterial = z.infer<
  typeof PublicWrappingMaterialSchema
>;
export type WrappedMasterKey = z.infer<typeof WrappedMasterKeySchema>;
export type UploadedPartReceipt = z.infer<typeof UploadedPartReceiptSchema>;
export type ProviderListedPart = z.infer<typeof ProviderListedPartSchema>;
export type FinalizeRecording = z.infer<typeof FinalizeRecordingSchema>;
