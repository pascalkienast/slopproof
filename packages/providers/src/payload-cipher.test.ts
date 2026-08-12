import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PayloadCipher,
  PayloadCipherEnvelopeV1Schema,
  ProviderError,
} from "./index";

const AAD = "attempt:10000000-0000-4000-8000-000000000001:transcript:v1";

function sequenceNonceSource() {
  let value = 0;
  return (length: number) => {
    value += 1;
    return new Uint8Array(length).fill(value);
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected ProviderError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe(code);
  }
}

describe("PayloadCipher", () => {
  it("encrypts and authenticates a DB payload with an explicitly injected key", () => {
    const key = new Uint8Array(32).fill(7);
    const cipher = new PayloadCipher(key, sequenceNonceSource());
    const envelope = cipher.encryptJson(
      { transcript: "private contributor answer", version: 1 },
      AAD,
    );

    expect(PayloadCipherEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(JSON.stringify(envelope)).not.toContain(
      "private contributor answer",
    );
    expect(JSON.stringify(envelope)).not.toContain(
      Buffer.from(key).toString("base64"),
    );
    expect(
      cipher.decryptJson(
        envelope,
        AAD,
        z
          .object({
            transcript: z.string(),
            version: z.literal(1),
          })
          .strict(),
      ),
    ).toEqual({ transcript: "private contributor answer", version: 1 });
  });

  it("fails closed for wrong AAD, wrong key and modified ciphertext", () => {
    const key = new Uint8Array(32).fill(8);
    const cipher = new PayloadCipher(key, sequenceNonceSource());
    const envelope = cipher.encrypt("sensitive", AAD);

    expectCode(
      () => cipher.decrypt(envelope, `${AAD}:other-row`),
      "PAYLOAD_DECRYPTION_FAILED",
    );
    expectCode(
      () =>
        new PayloadCipher(
          new Uint8Array(32).fill(9),
          sequenceNonceSource(),
        ).decrypt(envelope, AAD),
      "PAYLOAD_DECRYPTION_FAILED",
    );
    const first = envelope.ciphertext[0];
    const replacement = first === "A" ? "B" : "A";
    expectCode(
      () =>
        cipher.decrypt(
          {
            ...envelope,
            ciphertext: `${replacement}${envelope.ciphertext.slice(1)}`,
          },
          AAD,
        ),
      "PAYLOAD_DECRYPTION_FAILED",
    );
  });

  it("rejects key-size mistakes and nonce reuse", () => {
    expectCode(
      () => new PayloadCipher(new Uint8Array(31), sequenceNonceSource()),
      "INVALID_CIPHER_KEY",
    );

    const repeatedNonce = (length: number) => new Uint8Array(length).fill(4);
    const cipher = new PayloadCipher(new Uint8Array(32).fill(1), repeatedNonce);
    cipher.encrypt("first", AAD);
    expectCode(() => cipher.encrypt("second", AAD), "NONCE_REUSE");
  });

  it("rejects unknown envelope fields and malformed decrypted JSON schemas", () => {
    const cipher = new PayloadCipher(
      new Uint8Array(32).fill(3),
      sequenceNonceSource(),
    );
    const envelope = cipher.encryptJson({ version: 1, unexpected: true }, AAD);

    expectCode(
      () => cipher.decrypt({ ...envelope, keyId: "not-part-of-envelope" }, AAD),
      "INVALID_CIPHER_PAYLOAD",
    );
    expectCode(
      () =>
        cipher.decryptJson(
          envelope,
          AAD,
          z.object({ version: z.literal(1) }).strict(),
        ),
      "INVALID_CIPHER_PAYLOAD",
    );
  });
});
