import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PublicWrappingMaterialInput } from "@understandproof/auth";

let cached: Promise<PublicWrappingMaterialInput> | undefined;

export function loadLocalPublicWrappingMaterial(
  publicKeyPath: string,
): Promise<PublicWrappingMaterialInput> {
  cached ??= readMaterial(publicKeyPath);
  return cached;
}

async function readMaterial(
  publicKeyPath: string,
): Promise<PublicWrappingMaterialInput> {
  const pem = await readFile(resolve(publicKeyPath), "utf8");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("Wrapping public key must be RSA");
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < 3_072) {
    throw new Error("Wrapping public key must be at least RSA-3072");
  }
  const spki = key.export({ format: "der", type: "spki" });
  const spkiSha256 = createHash("sha256").update(spki).digest("base64url");
  return {
    keyId: `local:${spkiSha256}`,
    algorithm: "RSA-OAEP-256",
    spkiDer: spki.toString("base64url"),
    spkiSha256,
  };
}
