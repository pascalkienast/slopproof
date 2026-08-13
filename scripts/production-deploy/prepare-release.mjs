#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_ID_PATTERN = /^\d{8}T\d{6}Z$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".playwright-cli",
  ".pnpm-store",
  "archive",
  "backups",
  "build",
  "cache",
  "caches",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "playwright-report",
  "reports",
  "test-results",
]);
const SOURCE_MANIFEST_NAME = ".slopproof-source-manifest.json";
const RELEASE_MANIFEST_NAME = ".slopproof-release.json";
const IMAGE_ARCHIVE_NAME = "slopproof-app-linux-amd64.tar";
const SCAN_REPORT_NAME = "trivy-linux-amd64.json";
const SBOM_REPORT_NAME = "sbom-linux-amd64.spdx.json";
const POSTGRES_IMAGE =
  "postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";

export class ProductionReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionReleaseError";
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new ProductionReleaseError(`${basename(path)} is not a safe file`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isForbiddenReleasePath(path) {
  if (!path || path.startsWith("/") || path.includes("\0")) return true;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return true;
  }
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (
    lowerSegments.some(
      (segment) =>
        FORBIDDEN_DIRECTORY_NAMES.has(segment) ||
        segment.startsWith("bootstrap-"),
    )
  ) {
    return true;
  }
  const name = lowerSegments.at(-1) ?? "";
  return (
    name.startsWith(".env") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    name.endsWith(".backup") ||
    name.endsWith(".bak") ||
    name === ".ds_store"
  );
}

function readOwnedRegularFile(path, maximumBytes) {
  const resolved = resolve(path);
  const descriptor = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.size <= 0 ||
      stat.size > maximumBytes
    ) {
      throw new ProductionReleaseError(
        `${basename(path)} is not a safe artifact`,
      );
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertOwnedRegularFile(path, maximumBytes) {
  const resolved = resolve(path);
  const descriptor = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.size <= 0 ||
      stat.size > maximumBytes
    ) {
      throw new ProductionReleaseError(
        `${basename(path)} is not a safe artifact`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) {
      throw new ProductionReleaseError("Invalid release preparation arguments");
    }
    values.set(name, value);
  }
  return values;
}

function requiredArgument(values, name) {
  const value = values.get(name);
  if (!value) throw new ProductionReleaseError(`Missing ${name}`);
  return value;
}

function git(repository, argumentsList, options = {}) {
  return execFileSync("git", ["-C", repository, ...argumentsList], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
}

function trackedFiles(repository) {
  const output = execFileSync(
    "git",
    ["-C", repository, "ls-tree", "-r", "-z", "HEAD"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(
        record,
      );
      if (!match) {
        throw new ProductionReleaseError(
          "Releases may contain only tracked regular files",
        );
      }
      const path = match[3];
      if (/\r|\n/u.test(path)) {
        throw new ProductionReleaseError(`Unsafe release path: ${path}`);
      }
      return { path, mode: match[1] };
    })
    .filter(({ path }) => !isForbiddenReleasePath(path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function verifySourceAgainstRepository(
  repository,
  sourceDirectory,
  sourceManifest,
  releaseManifest,
) {
  const resolvedRepository = realpathSync(resolve(repository));
  if (!repository.startsWith("/")) {
    throw new ProductionReleaseError("Repository path must be absolute");
  }
  if (
    git(resolvedRepository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
  ) {
    throw new ProductionReleaseError("Trusted repository must be clean");
  }
  const commit = git(resolvedRepository, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const tree = git(resolvedRepository, [
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  ]);
  if (releaseManifest.commit !== commit || releaseManifest.tree !== tree) {
    throw new ProductionReleaseError(
      "Release does not match the trusted repository identity",
    );
  }
  const trustedFiles = trackedFiles(resolvedRepository);
  if (
    trustedFiles.length !== sourceManifest.files.length ||
    trustedFiles.some(
      (trusted, index) =>
        trusted.path !== sourceManifest.files[index]?.path ||
        trusted.mode !== sourceManifest.files[index]?.mode,
    )
  ) {
    throw new ProductionReleaseError(
      "Release source set does not match the trusted repository",
    );
  }
  for (const file of trustedFiles) {
    const expectedBytes = execFileSync(
      "git",
      ["-C", resolvedRepository, "show", `${commit}:${file.path}`],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const actualBytes = readOwnedRegularFile(
      join(sourceDirectory, file.path),
      64 * 1024 * 1024,
    );
    if (!actualBytes.equals(expectedBytes)) {
      throw new ProductionReleaseError(
        `Release source differs from trusted Git: ${file.path}`,
      );
    }
  }
}

function releaseCreatedAt(releaseId) {
  return `${releaseId.slice(0, 4)}-${releaseId.slice(4, 6)}-${releaseId.slice(6, 8)}T${releaseId.slice(9, 11)}:${releaseId.slice(11, 13)}:${releaseId.slice(13, 15)}Z`;
}

function readUniqueRegularArchiveMember(
  bytesPath,
  listing,
  member,
  maximumBytes,
) {
  if (listing.filter((path) => path === member).length !== 1) {
    throw new ProductionReleaseError("Docker image archive member mismatch");
  }
  const verbose = execFileSync("tar", ["-tvf", bytesPath, member], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  if (verbose.length !== 1 || !verbose[0].startsWith("-")) {
    throw new ProductionReleaseError(
      "Docker image archive member is not a regular file",
    );
  }
  return execFileSync("tar", ["-xOf", bytesPath, member], {
    maxBuffer: maximumBytes,
  });
}

export function inspectDockerArchive(bytesPath, expectedTag, expectedImageId) {
  const listing = execFileSync("tar", ["-tf", bytesPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  if (
    listing.some(
      (path) =>
        path.startsWith("/") ||
        path.split("/").some((segment) => segment === ".."),
    ) ||
    listing.filter((path) => path === "manifest.json").length !== 1
  ) {
    throw new ProductionReleaseError("Unsafe Docker image archive layout");
  }
  const dockerManifest = JSON.parse(
    readUniqueRegularArchiveMember(
      bytesPath,
      listing,
      "manifest.json",
      2 * 1024 * 1024,
    ).toString("utf8"),
  );
  const configMember = dockerManifest[0]?.Config;
  const legacyConfig = /^[0-9a-f]{64}\.json$/u.test(configMember ?? "");
  const containerdConfig = /^blobs\/sha256\/[0-9a-f]{64}$/u.test(
    configMember ?? "",
  );
  if (
    !Array.isArray(dockerManifest) ||
    dockerManifest.length !== 1 ||
    !dockerManifest[0]?.RepoTags?.includes(expectedTag) ||
    (!legacyConfig && !containerdConfig)
  ) {
    throw new ProductionReleaseError("Docker image archive identity mismatch");
  }
  const configBytes = readUniqueRegularArchiveMember(
    bytesPath,
    listing,
    configMember,
    8 * 1024 * 1024,
  );
  const configDigest = sha256Bytes(configBytes);
  const config = JSON.parse(configBytes.toString("utf8"));
  if (config.os !== "linux" || config.architecture !== "amd64") {
    throw new ProductionReleaseError(
      "Docker image is not the expected linux/amd64 image",
    );
  }

  if (legacyConfig) {
    const derivedImageId = `sha256:${configDigest}`;
    if (derivedImageId !== expectedImageId) {
      throw new ProductionReleaseError(
        "Docker image archive identity mismatch",
      );
    }
    return { imageId: derivedImageId, platform: "linux/amd64" };
  }

  if (configMember !== `blobs/sha256/${configDigest}`) {
    throw new ProductionReleaseError("Docker config digest mismatch");
  }
  const expectedIndexMember = `blobs/sha256/${expectedImageId.slice(7)}`;
  if (!SHA256_PATTERN.test(expectedImageId)) {
    throw new ProductionReleaseError("Docker image archive identity mismatch");
  }
  const indexBytes = readUniqueRegularArchiveMember(
    bytesPath,
    listing,
    expectedIndexMember,
    8 * 1024 * 1024,
  );
  if (sha256Bytes(indexBytes) !== expectedImageId.slice(7)) {
    throw new ProductionReleaseError("Docker image index digest mismatch");
  }
  const rootIndex = JSON.parse(
    readUniqueRegularArchiveMember(
      bytesPath,
      listing,
      "index.json",
      2 * 1024 * 1024,
    ).toString("utf8"),
  );
  const imageIndex = JSON.parse(indexBytes.toString("utf8"));
  if (
    rootIndex.schemaVersion !== 2 ||
    !Array.isArray(rootIndex.manifests) ||
    rootIndex.manifests.length !== 1 ||
    rootIndex.manifests[0]?.digest !== expectedImageId ||
    imageIndex.schemaVersion !== 2 ||
    !Array.isArray(imageIndex.manifests) ||
    imageIndex.manifests.filter(
      (entry) =>
        entry?.platform?.os === "linux" &&
        entry?.platform?.architecture === "amd64",
    ).length !== 1
  ) {
    throw new ProductionReleaseError("Docker image index identity mismatch");
  }
  return { imageId: expectedImageId, platform: "linux/amd64" };
}

function validateTrivyReport(bytes, expectedTag, expectedImageId) {
  const report = JSON.parse(bytes.toString("utf8"));
  if (
    report.SchemaVersion !== 2 ||
    report.ArtifactType !== "container_image" ||
    report.ArtifactName !== expectedTag ||
    report.Metadata?.ImageID !== expectedImageId ||
    !report.Metadata?.RepoTags?.includes(expectedTag)
  ) {
    throw new ProductionReleaseError("Trivy report is not bound to the image");
  }
  const highRiskFindings = (report.Results ?? []).flatMap((result) =>
    (result.Vulnerabilities ?? []).filter((finding) =>
      ["HIGH", "CRITICAL"].includes(finding.Severity),
    ),
  );
  if (highRiskFindings.length > 0) {
    throw new ProductionReleaseError(
      "Trivy report contains HIGH or CRITICAL findings",
    );
  }
}

function validateSpdxReport(bytes, expectedTag) {
  const report = JSON.parse(bytes.toString("utf8"));
  if (
    report.spdxVersion !== "SPDX-2.3" ||
    report.SPDXID !== "SPDXRef-DOCUMENT" ||
    report.name !== expectedTag ||
    !Array.isArray(report.packages) ||
    report.packages.length === 0
  ) {
    throw new ProductionReleaseError("SPDX report is not bound to the image");
  }
}

function walkFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ProductionReleaseError(
        "Release staging contains a symbolic link",
      );
    }
    if (entry.isDirectory()) return walkFiles(path, relativePath);
    if (!entry.isFile()) {
      throw new ProductionReleaseError(
        "Release staging contains a special file",
      );
    }
    return [relativePath];
  });
}

function verifySource(sourceDirectory, sourceManifest) {
  const expected = new Set(sourceManifest.files.map((file) => file.path));
  const actual = walkFiles(sourceDirectory).filter(
    (path) => ![SOURCE_MANIFEST_NAME, RELEASE_MANIFEST_NAME].includes(path),
  );
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new ProductionReleaseError("Source manifest file set mismatch");
  }
  for (const file of sourceManifest.files) {
    if (
      isForbiddenReleasePath(file.path) ||
      !HEX_SHA256_PATTERN.test(file.sha256) ||
      !["100644", "100755"].includes(file.mode)
    ) {
      throw new ProductionReleaseError("Invalid source manifest record");
    }
    const path = join(sourceDirectory, file.path);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== file.size ||
      sha256File(path) !== file.sha256
    ) {
      throw new ProductionReleaseError(
        `Source checksum mismatch: ${file.path}`,
      );
    }
  }
}

function verifyArtifactSet(artifactsDirectory) {
  const expected = [IMAGE_ARCHIVE_NAME, SCAN_REPORT_NAME, SBOM_REPORT_NAME];
  const actual = walkFiles(artifactsDirectory).sort();
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected.sort()[index])
  ) {
    throw new ProductionReleaseError("Release artifact file set mismatch");
  }
}

export function verifyReleaseBundle(bundlePath, trust = {}) {
  const bundle = realpathSync(resolve(bundlePath));
  const sourceDirectory = join(bundle, "source");
  const artifactsDirectory = join(bundle, "artifacts");
  const releaseManifestBytes = readOwnedRegularFile(
    join(sourceDirectory, RELEASE_MANIFEST_NAME),
    1024 * 1024,
  );
  const sourceManifestBytes = readOwnedRegularFile(
    join(sourceDirectory, SOURCE_MANIFEST_NAME),
    64 * 1024 * 1024,
  );
  const releaseManifest = JSON.parse(releaseManifestBytes.toString("utf8"));
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (
    releaseManifest.schema !== "slopproof.release.v1" ||
    sourceManifest.schema !== "slopproof.source-manifest.v1" ||
    !RELEASE_ID_PATTERN.test(releaseManifest.releaseId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(releaseManifest.commit ?? "") ||
    !/^[0-9a-f]{40}$/u.test(releaseManifest.tree ?? "") ||
    releaseManifest.source?.manifest !== SOURCE_MANIFEST_NAME ||
    releaseManifest.source?.sha256 !== sha256Bytes(sourceManifestBytes) ||
    sourceManifest.commit !== releaseManifest.commit ||
    sourceManifest.tree !== releaseManifest.tree ||
    releaseManifest.dependencies?.postgresImage !== POSTGRES_IMAGE ||
    releaseManifest.dependencies?.postgresPlatform !== "linux/amd64"
  ) {
    throw new ProductionReleaseError("Release metadata binding mismatch");
  }
  verifySource(sourceDirectory, sourceManifest);
  verifyArtifactSet(artifactsDirectory);
  if (trust.repository) {
    verifySourceAgainstRepository(
      trust.repository,
      sourceDirectory,
      sourceManifest,
      releaseManifest,
    );
  }

  const image = releaseManifest.image;
  if (
    image?.archive !== IMAGE_ARCHIVE_NAME ||
    image?.scanReport !== SCAN_REPORT_NAME ||
    image?.sbomReport !== SBOM_REPORT_NAME ||
    image?.platform !== "linux/amd64" ||
    !SHA256_PATTERN.test(image?.id ?? "") ||
    !/^slopproof-app:[a-z0-9._-]+$/u.test(image?.tag ?? "") ||
    !/^[0-9a-f]{40}$/u.test(image?.sourceCommit ?? "") ||
    !image.sourceCommit.startsWith(
      /^slopproof-app:([0-9a-f]{7,40})-gate9-amd64$/u.exec(image.tag)?.[1] ??
        "not-a-prefix",
    )
  ) {
    throw new ProductionReleaseError("Invalid release image metadata");
  }
  if (
    trust.expectedImageId &&
    (image.id !== trust.expectedImageId ||
      image.tag !== trust.expectedImageTag ||
      image.sourceCommit !== trust.expectedImageSourceCommit ||
      image.archiveSha256 !== trust.expectedArchiveSha256 ||
      image.scanReportSha256 !== trust.expectedScanSha256 ||
      image.sbomReportSha256 !== trust.expectedSbomSha256)
  ) {
    throw new ProductionReleaseError(
      "Release image evidence does not match the external trust boundary",
    );
  }
  for (const [name, expectedHash] of [
    [IMAGE_ARCHIVE_NAME, image.archiveSha256],
    [SCAN_REPORT_NAME, image.scanReportSha256],
    [SBOM_REPORT_NAME, image.sbomReportSha256],
  ]) {
    if (
      !HEX_SHA256_PATTERN.test(expectedHash ?? "") ||
      sha256File(join(artifactsDirectory, name)) !== expectedHash
    ) {
      throw new ProductionReleaseError(`${name} checksum mismatch`);
    }
  }
  inspectDockerArchive(
    join(artifactsDirectory, IMAGE_ARCHIVE_NAME),
    image.tag,
    image.id,
  );
  validateTrivyReport(
    readOwnedRegularFile(
      join(artifactsDirectory, SCAN_REPORT_NAME),
      512 * 1024 * 1024,
    ),
    image.tag,
    image.id,
  );
  validateSpdxReport(
    readOwnedRegularFile(
      join(artifactsDirectory, SBOM_REPORT_NAME),
      512 * 1024 * 1024,
    ),
    image.tag,
  );
  return releaseManifest;
}

export function createReleaseBundle(options) {
  const repository = realpathSync(resolve(options.repository));
  const output = resolve(options.output);
  if (!options.repository.startsWith("/") || !options.output.startsWith("/")) {
    throw new ProductionReleaseError(
      "Repository and output paths must be absolute",
    );
  }
  if (!RELEASE_ID_PATTERN.test(options.releaseId)) {
    throw new ProductionReleaseError(
      "Release ID must be a compact UTC timestamp",
    );
  }
  if (existsSync(output)) {
    throw new ProductionReleaseError("Release output must not already exist");
  }
  const relativeOutput = relative(repository, output);
  if (
    relativeOutput === "" ||
    (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== "..")
  ) {
    throw new ProductionReleaseError(
      "Release output must be outside the repository",
    );
  }
  if (git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new ProductionReleaseError(
      "Repository must be clean before release preparation",
    );
  }
  const commit = git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tree = git(repository, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw new ProductionReleaseError(
      "Expected SHA-1 commit and tree identities",
    );
  }
  if (!SHA256_PATTERN.test(options.imageId)) {
    throw new ProductionReleaseError(
      "Image ID must be an explicit sha256 identity",
    );
  }
  const imageSourceCommit = git(repository, [
    "rev-parse",
    "--verify",
    `${options.imageSourceCommit}^{commit}`,
  ]);
  if (
    !/^[0-9a-f]{40}$/u.test(imageSourceCommit) ||
    options.imageTag !==
      `slopproof-app:${options.imageSourceCommit}-gate9-amd64`
  ) {
    throw new ProductionReleaseError(
      "Image tag must bind the explicit source commit and Gate 9 amd64 build",
    );
  }

  const files = trackedFiles(repository);
  assertOwnedRegularFile(options.imageArchive, 20 * 1024 * 1024 * 1024);
  const imageArchiveSha256 = sha256File(options.imageArchive);
  const scanReportBytes = readOwnedRegularFile(
    options.scanReport,
    512 * 1024 * 1024,
  );
  const sbomReportBytes = readOwnedRegularFile(
    options.sbomReport,
    512 * 1024 * 1024,
  );
  inspectDockerArchive(options.imageArchive, options.imageTag, options.imageId);
  validateTrivyReport(scanReportBytes, options.imageTag, options.imageId);
  validateSpdxReport(sbomReportBytes, options.imageTag);

  mkdirSync(output, { mode: 0o700 });
  const sourceDirectory = join(output, "source");
  const artifactsDirectory = join(output, "artifacts");
  mkdirSync(sourceDirectory, { mode: 0o700 });
  mkdirSync(artifactsDirectory, { mode: 0o700 });
  const temporaryArchive = join(output, ".source.tar");
  try {
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "archive",
        "--format=tar",
        `--output=${temporaryArchive}`,
        "HEAD",
        "--",
        ...files.map(({ path }) => path),
      ],
      {
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    execFileSync("tar", ["-xf", temporaryArchive, "-C", sourceDirectory], {
      stdio: "pipe",
    });
  } finally {
    rmSync(temporaryArchive, { force: true });
  }

  const sourceManifest = {
    schema: "slopproof.source-manifest.v1",
    commit,
    tree,
    files: files.map((file) => {
      const path = join(sourceDirectory, file.path);
      return {
        path: file.path,
        mode: file.mode,
        size: statSync(path).size,
        sha256: sha256File(path),
      };
    }),
  };
  const sourceManifestBytes = Buffer.from(stableJson(sourceManifest));
  writeFileSync(
    join(sourceDirectory, SOURCE_MANIFEST_NAME),
    sourceManifestBytes,
    {
      mode: 0o600,
      flag: "wx",
    },
  );

  for (const [source, target] of [
    [options.imageArchive, IMAGE_ARCHIVE_NAME],
    [options.scanReport, SCAN_REPORT_NAME],
    [options.sbomReport, SBOM_REPORT_NAME],
  ]) {
    copyFileSync(
      source,
      join(artifactsDirectory, target),
      constants.COPYFILE_EXCL,
    );
    chmodSync(join(artifactsDirectory, target), 0o600);
  }

  const releaseManifest = {
    schema: "slopproof.release.v1",
    releaseId: options.releaseId,
    createdAt: releaseCreatedAt(options.releaseId),
    commit,
    tree,
    source: {
      manifest: SOURCE_MANIFEST_NAME,
      sha256: sha256Bytes(sourceManifestBytes),
    },
    image: {
      archive: IMAGE_ARCHIVE_NAME,
      archiveSha256: imageArchiveSha256,
      id: options.imageId,
      tag: options.imageTag,
      sourceCommit: imageSourceCommit,
      platform: "linux/amd64",
      scanReport: SCAN_REPORT_NAME,
      scanReportSha256: sha256Bytes(scanReportBytes),
      scanPolicy: "no-high-or-critical-v1",
      sbomReport: SBOM_REPORT_NAME,
      sbomReportSha256: sha256Bytes(sbomReportBytes),
    },
    dependencies: {
      postgresImage: POSTGRES_IMAGE,
      postgresPlatform: "linux/amd64",
    },
  };
  writeFileSync(
    join(sourceDirectory, RELEASE_MANIFEST_NAME),
    stableJson(releaseManifest),
    { mode: 0o600, flag: "wx" },
  );
  verifyReleaseBundle(output);
  return releaseManifest;
}

function main() {
  const [command, ...argumentList] = process.argv.slice(2);
  if (command === "verify") {
    const values = parseArguments(argumentList);
    const manifest = verifyReleaseBundle(
      requiredArgument(values, "--bundle"),
      values.has("--repository")
        ? {
            repository: requiredArgument(values, "--repository"),
            expectedImageId: requiredArgument(values, "--expected-image-id"),
            expectedImageTag: requiredArgument(values, "--expected-image-tag"),
            expectedImageSourceCommit: requiredArgument(
              values,
              "--expected-image-source-commit",
            ),
            expectedArchiveSha256: requiredArgument(
              values,
              "--expected-archive-sha256",
            ),
            expectedScanSha256: requiredArgument(
              values,
              "--expected-scan-sha256",
            ),
            expectedSbomSha256: requiredArgument(
              values,
              "--expected-sbom-sha256",
            ),
          }
        : {},
    );
    process.stdout.write(
      `Verified release ${manifest.releaseId} at commit ${manifest.commit}.\n`,
    );
    return;
  }
  if (command !== "create") {
    throw new ProductionReleaseError("Expected create or verify command");
  }
  const values = parseArguments(argumentList);
  const manifest = createReleaseBundle({
    repository: requiredArgument(values, "--repository"),
    output: requiredArgument(values, "--output"),
    releaseId: requiredArgument(values, "--release-id"),
    imageArchive: requiredArgument(values, "--image-archive"),
    imageTag: requiredArgument(values, "--image-tag"),
    imageId: requiredArgument(values, "--image-id"),
    imageSourceCommit: requiredArgument(values, "--image-source-commit"),
    scanReport: requiredArgument(values, "--scan-report"),
    sbomReport: requiredArgument(values, "--sbom-report"),
  });
  process.stdout.write(
    `Prepared release ${manifest.releaseId} at commit ${manifest.commit}.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    if (error instanceof ProductionReleaseError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("Production release preparation failed.\n");
    }
    process.exitCode = 1;
  }
}
