import { generateKeyPairSync } from "node:crypto";
import { access, chmod, chown, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const publicPath = resolve(
  process.argv[2] ?? "infra/docker/secrets/wrapping-public.pem",
);
const privatePath = resolve(
  process.argv[3] ?? "infra/docker/secrets/wrapping-private.pem",
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const [hasPublic, hasPrivate] = await Promise.all([
  exists(publicPath),
  exists(privatePath),
]);

if (hasPublic !== hasPrivate) {
  throw new Error("Refusing to replace an incomplete local wrapping-key pair");
}

if (hasPublic && hasPrivate) {
  await assignContainerRuntimeOwner();
  process.stdout.write("Local wrapping-key pair already exists.\n");
  process.exit(0);
}

await Promise.all([
  mkdir(dirname(publicPath), { recursive: true }),
  mkdir(dirname(privatePath), { recursive: true }),
]);

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicExponent: 0x10001,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

await writeFile(publicPath, publicKey, {
  encoding: "utf8",
  mode: 0o644,
  flag: "wx",
});
await writeFile(privatePath, privateKey, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
await assignContainerRuntimeOwner();

process.stdout.write(
  "Generated a local RSA-3072 wrapping-key pair. Keep the private key out of Git.\n",
);

async function assignContainerRuntimeOwner() {
  await Promise.all([chmod(publicPath, 0o644), chmod(privatePath, 0o600)]);
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  await Promise.all([
    chown(publicPath, 1_000, 1_000),
    chown(privatePath, 1_000, 1_000),
  ]);
}
