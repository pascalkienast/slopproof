import { createHmac, randomBytes } from "node:crypto";

export type OpaqueCredential = {
  value: string;
  hash: string;
};

export function hashOpaqueCredential(
  secret: string,
  purpose: "session" | "csrf" | "handoff",
  value: string,
): string {
  return createHmac("sha256", secret)
    .update(`slopproof/${purpose}/v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function createOpaqueCredential(
  secret: string,
  purpose: "session" | "csrf" | "handoff",
  entropyBytes = 32,
): OpaqueCredential {
  if (!Number.isSafeInteger(entropyBytes) || entropyBytes < 16) {
    throw new Error("Opaque credentials require at least 128 bits of entropy");
  }
  const value = randomBytes(entropyBytes).toString("base64url");
  return { value, hash: hashOpaqueCredential(secret, purpose, value) };
}
