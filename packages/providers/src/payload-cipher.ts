import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { ProviderError } from "./errors";

const Base64Schema = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const PayloadCipherEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    algorithm: z.literal("aes-256-gcm"),
    nonce: Base64Schema,
    ciphertext: Base64Schema,
    authenticationTag: Base64Schema,
    aadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (Buffer.from(envelope.nonce, "base64").byteLength !== 12) {
      context.addIssue({
        code: "custom",
        path: ["nonce"],
        message: "AES-GCM nonce must decode to exactly 12 bytes",
      });
    }
    if (Buffer.from(envelope.authenticationTag, "base64").byteLength !== 16) {
      context.addIssue({
        code: "custom",
        path: ["authenticationTag"],
        message: "AES-GCM authentication tag must decode to exactly 16 bytes",
      });
    }
  });

export type PayloadCipherEnvelopeV1 = z.infer<
  typeof PayloadCipherEnvelopeV1Schema
>;

export type PayloadCipherNonceSource = (length: number) => Uint8Array;

function asNonEmptyBytes(value: string | Uint8Array, field: string): Buffer {
  const bytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength === 0) {
    throw new ProviderError(
      "INVALID_CIPHER_PAYLOAD",
      "terminal",
      `${field} must not be empty`,
    );
  }
  return bytes;
}

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export class PayloadCipher {
  private readonly key: Buffer;
  private readonly usedNonces = new Set<string>();

  constructor(
    key: Uint8Array,
    private readonly nonceSource: PayloadCipherNonceSource = randomBytes,
  ) {
    if (key.byteLength !== 32) {
      throw new ProviderError(
        "INVALID_CIPHER_KEY",
        "terminal",
        "PayloadCipher requires an explicitly injected 32-byte key",
      );
    }
    this.key = Buffer.from(key);
  }

  encrypt(
    plaintext: string | Uint8Array,
    associatedData: string | Uint8Array,
  ): PayloadCipherEnvelopeV1 {
    const plaintextBytes = asNonEmptyBytes(plaintext, "plaintext");
    const aad = asNonEmptyBytes(associatedData, "associatedData");
    const nonce = Buffer.from(this.nonceSource(12));
    if (nonce.byteLength !== 12) {
      throw new ProviderError(
        "INVALID_CIPHER_PAYLOAD",
        "terminal",
        "PayloadCipher nonce source must return exactly 12 bytes",
      );
    }
    const nonceKey = nonce.toString("hex");
    if (this.usedNonces.has(nonceKey)) {
      throw new ProviderError(
        "NONCE_REUSE",
        "terminal",
        "PayloadCipher nonce source repeated a nonce for the same key",
      );
    }
    this.usedNonces.add(nonceKey);

    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintextBytes),
      cipher.final(),
    ]);
    return PayloadCipherEnvelopeV1Schema.parse({
      schemaVersion: "1",
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
      aadSha256: digest(aad).toString("hex"),
    });
  }

  decrypt(
    rawEnvelope: unknown,
    associatedData: string | Uint8Array,
  ): Uint8Array {
    const envelope = PayloadCipherEnvelopeV1Schema.safeParse(rawEnvelope);
    if (!envelope.success) {
      throw new ProviderError(
        "INVALID_CIPHER_PAYLOAD",
        "terminal",
        "Encrypted DB payload failed its versioned envelope schema",
        { cause: envelope.error },
      );
    }
    const aad = asNonEmptyBytes(associatedData, "associatedData");
    const actualAadHash = digest(aad);
    const expectedAadHash = Buffer.from(envelope.data.aadSha256, "hex");
    if (
      actualAadHash.byteLength !== expectedAadHash.byteLength ||
      !timingSafeEqual(actualAadHash, expectedAadHash)
    ) {
      throw new ProviderError(
        "PAYLOAD_DECRYPTION_FAILED",
        "terminal",
        "Encrypted DB payload is not bound to the supplied associated data",
      );
    }

    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.data.nonce, "base64"),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(
        Buffer.from(envelope.data.authenticationTag, "base64"),
      );
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.data.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch (error) {
      throw new ProviderError(
        "PAYLOAD_DECRYPTION_FAILED",
        "terminal",
        "Encrypted DB payload authentication failed",
        { cause: error },
      );
    }
  }

  encryptJson(
    value: unknown,
    associatedData: string | Uint8Array,
  ): PayloadCipherEnvelopeV1 {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new ProviderError(
        "INVALID_CIPHER_PAYLOAD",
        "terminal",
        "JSON payload is not serializable",
      );
    }
    return this.encrypt(serialized, associatedData);
  }

  decryptJson<T>(
    envelope: unknown,
    associatedData: string | Uint8Array,
    schema: z.ZodType<T>,
  ): T {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        this.decrypt(envelope, associatedData),
      );
      return schema.parse(JSON.parse(decoded));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        "INVALID_CIPHER_PAYLOAD",
        "terminal",
        "Decrypted DB payload is not valid schema-checked JSON",
        { cause: error },
      );
    }
  }
}
