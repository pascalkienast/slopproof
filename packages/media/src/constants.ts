export const RECORDING_SUITE_ID = "SP-RC1" as const;
export const RECORDING_PROTOCOL_VERSION = 1 as const;
export const RECORD_MAGIC = "SPC1" as const;
export const RECORD_VERSION = 1 as const;
export const RECORD_HEADER_BYTES = 32 as const;
export const AES_GCM_TAG_BYTES = 16 as const;
export const AES_GCM_NONCE_BYTES = 12 as const;
export const NONCE_PREFIX_BYTES = 8 as const;
export const MASTER_KEY_BYTES = 32 as const;
export const MANIFEST_TAG_BYTES = 32 as const;
export const SHA256_BYTES = 32 as const;
export const RSA_MINIMUM_MODULUS_BITS = 3072 as const;

export const RECORDING_CODEC = "video/webm;codecs=vp8,opus" as const;
export const WRAPPING_ALGORITHM = "RSA-OAEP-256" as const;

export const KDF_DOMAIN = "slopproof-recording-kdf" as const;
export const CHUNK_AAD_DOMAIN = "slopproof-recording-chunk" as const;
export const MANIFEST_DOMAIN = "slopproof-recording-manifest" as const;
export const CHUNK_AEAD_INFO = "slopproof/recording/v1/chunk-aead" as const;
export const MANIFEST_AUTH_INFO =
  "slopproof/recording/v1/manifest-auth" as const;

export const S3_MINIMUM_NONFINAL_PART_BYTES = 5 * 1024 * 1024;
export const MULTIPART_TARGET_BYTES = 8 * 1024 * 1024;
export const MAX_PLAINTEXT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ENCRYPTED_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_RECORDING_CHUNKS = 1024;
export const MAX_MULTIPART_PARTS = 32;
export const MAX_RECORDING_OBJECT_BYTES = 128 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 8 * 60 * 1000;
export const MAX_FINALIZE_JSON_BYTES = 512 * 1024;

export const MAX_UINT32 = 0xffff_ffff;
