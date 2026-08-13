import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  finalizeCmsArtifact,
  verifyCmsArtifact,
} from "../production-backup/cms-artifact.mjs";
import {
  parseDatabaseAudit,
  validateDatabaseAudit,
} from "../production-backup/validate-database-audit.mjs";
import { writeBackupReceipt } from "../production-backup/write-receipt.mjs";
import { verifyBackupReceipt } from "../production-backup/verify-receipt.mjs";
import { syncBackupPublication } from "../production-backup/sync-publication.mjs";

const RELEASE_ID = "20260813T080000Z";
const COMMIT = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const KEY_PASSPHRASE = "production-fixture-passphrase";
const EXPECT_PATH = "/usr/bin/expect";

function productionPtyIsUsable() {
  if (process.platform !== "darwin" || !existsSync(EXPECT_PATH)) return false;
  const probe = spawnSync(
    EXPECT_PATH,
    [
      "-c",
      String.raw`
set timeout 5
spawn -noecho /bin/bash -c { builtin printf tty-probe > /dev/tty }
expect eof
set child_status [wait]
exit [lindex $child_status 3]
`,
    ],
    { encoding: "utf8" },
  );
  return probe.status === 0 && probe.stdout.includes("tty-probe");
}

function utc(offsetSeconds = 0) {
  return new Date(Math.floor(Date.now() / 1000) * 1000 + offsetSeconds * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function createDirectoryFixture() {
  const parent = mkdtempSync(
    join(realpathSync(tmpdir()), "slopproof-workflow-"),
  );
  chmodSync(parent, 0o700);
  const backupRoot = join(parent, "backups");
  const releaseDirectory = join(backupRoot, RELEASE_ID);
  const keyDirectory = join(parent, "keys");
  for (const path of [backupRoot, releaseDirectory, keyDirectory]) {
    execFileSync("mkdir", ["-m", "0700", path]);
  }
  const privateKey = join(keyDirectory, "recipient-private.pem");
  const certificate = join(keyDirectory, "recipient-cert.pem");
  const keyGeneration = spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-aes-256-cbc",
      "-passout",
      "stdin",
      "-keyout",
      privateKey,
      "-out",
      certificate,
      "-days",
      "2",
      "-sha256",
      "-subj",
      "/CN=SlopProof workflow test",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,keyEncipherment",
    ],
    { input: `${KEY_PASSPHRASE}\n`, encoding: "utf8" },
  );
  assert.equal(keyGeneration.status, 0);
  assert.equal(
    readFileSync(privateKey, "utf8").split("\n", 1)[0],
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  );
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o644);
  return {
    parent,
    backupRoot,
    releaseDirectory,
    keyDirectory,
    privateKey,
    certificate,
  };
}

function decryptCmsWithPassphrase(
  ciphertext,
  certificate,
  privateKey,
  passphraseInput,
) {
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -o pipefail
backup_passphrase=''
if ! IFS= read -r backup_passphrase; then
  exit 97
fi
printf '%s\n' "$backup_passphrase" |
  openssl cms -decrypt -binary -inform DER -in "$1" \
    -recip "$2" -inkey "$3" -passin stdin \
    -keyopt rsa_padding_mode:oaep \
    -keyopt rsa_oaep_md:sha256 \
    -keyopt rsa_mgf1_md:sha256 2>/dev/null
pipeline_status=$?
backup_passphrase=''
unset backup_passphrase
exit "$pipeline_status"`,
      "encrypted-key-roundtrip",
      ciphertext,
      certificate,
      privateKey,
    ],
    { input: passphraseInput, maxBuffer: 16 * 1024 * 1024 },
  );
}

function decryptCmsWithProductionHelperInPty(
  ciphertext,
  certificate,
  privateKey,
  passphraseInput,
) {
  const expectProgram = String.raw`
set timeout 15
if {[gets stdin backup_passphrase] < 0} {
  set backup_passphrase ""
}
set helper $env(SLOPPROOF_TEST_DECRYPT_HELPER)
set ciphertext $env(SLOPPROOF_TEST_CIPHERTEXT)
set certificate $env(SLOPPROOF_TEST_CERTIFICATE)
set private_key $env(SLOPPROOF_TEST_PRIVATE_KEY)
spawn -noecho /bin/bash -o pipefail -c {
  initial_terminal_state=$(/bin/stty -g < /dev/tty) || exit 96
  "$1" --ciphertext "$2" --recipient-certificate "$3" --recipient-key "$4" |
    shasum -a 256
  pipeline_status=$?
  final_terminal_state=$(/bin/stty -g < /dev/tty) || exit 97
  [[ "$final_terminal_state" == "$initial_terminal_state" ]] || exit 97
  exit "$pipeline_status"
} production-decrypt "$helper" "$ciphertext" "$certificate" "$private_key"
expect {
  -exact "Backup private-key passphrase: " {}
  timeout { exit 98 }
  eof { exit 99 }
}
send -- "$backup_passphrase\r"
set backup_passphrase ""
unset backup_passphrase
expect eof
set child_status [wait]
exit [lindex $child_status 3]
`;
  return spawnSync(EXPECT_PATH, ["-c", expectProgram], {
    input: `${passphraseInput}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      SLOPPROOF_TEST_DECRYPT_HELPER: join(
        process.cwd(),
        "scripts/production-backup/decrypt-cms-stream.sh",
      ),
      SLOPPROOF_TEST_CIPHERTEXT: ciphertext,
      SLOPPROOF_TEST_CERTIFICATE: certificate,
      SLOPPROOF_TEST_PRIVATE_KEY: privateKey,
    },
  });
}

function encryptCms(source, certificate, output) {
  const result = spawnSync(
    "openssl",
    [
      "cms",
      "-encrypt",
      "-binary",
      "-stream",
      "-outform",
      "DER",
      "-aes-256-gcm",
      "-recip",
      certificate,
      "-keyopt",
      "rsa_padding_mode:oaep",
      "-keyopt",
      "rsa_oaep_md:sha256",
      "-keyopt",
      "rsa_mgf1_md:sha256",
      "-out",
      output,
    ],
    { input: source },
  );
  assert.equal(result.status, 0);
  chmodSync(output, 0o600);
}

function encryptCmsViaReservedFd(source, certificate, output) {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail
umask 077
set -o noclobber
exec 9>"$1"
set +o noclobber
openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm \\
  -recip "$2" \\
  -keyopt rsa_padding_mode:oaep \\
  -keyopt rsa_oaep_md:sha256 \\
  -keyopt rsa_mgf1_md:sha256 \\
  >&9 2>/dev/null
exec 9>&-`,
      "reserved-fd-cms-test",
      output,
      certificate,
    ],
    { input: source },
  );
  assert.equal(result.status, 0);
  chmodSync(output, 0o600);
}

function encryptCmsForTwoRecipients(
  source,
  intendedCertificate,
  extraCertificate,
  output,
) {
  const result = spawnSync(
    "openssl",
    [
      "cms",
      "-encrypt",
      "-binary",
      "-stream",
      "-outform",
      "DER",
      "-aes-256-gcm",
      "-recip",
      intendedCertificate,
      "-keyopt",
      "rsa_padding_mode:oaep",
      "-keyopt",
      "rsa_oaep_md:sha256",
      "-keyopt",
      "rsa_mgf1_md:sha256",
      "-recip",
      extraCertificate,
      "-out",
      output,
    ],
    { input: source },
  );
  assert.equal(result.status, 0);
  chmodSync(output, 0o600);
}

function audit() {
  return {
    schema: "slopproof.database-audit.v1",
    postgresVersion: "18.4",
    migrationCount: 17,
    tableCount: 44,
    constraintCount: 622,
    triggerCount: 81,
    retentionInvariantViolations: 0,
  };
}

test("full CMS, audit, receipt and verification roundtrip is release-bound", async (t) => {
  const fixture = createDirectoryFixture();
  t.after(() => rmSync(fixture.parent, { recursive: true, force: true }));
  const plaintext = Buffer.alloc(9 * 1024 * 1024 + 31, 0x5a);
  plaintext.write("PGDMP\0workflow-fixture\n", 0, "binary");
  const partial = join(fixture.releaseDirectory, `${RELEASE_ID}.cms.partial`);
  const ciphertext = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
  encryptCmsViaReservedFd(plaintext, fixture.certificate, partial);
  await finalizeCmsArtifact({
    partialPath: partial,
    finalPath: ciphertext,
    releaseId: RELEASE_ID,
  });
  assert.equal(lstatSync(ciphertext).nlink, 1);
  await verifyCmsArtifact(ciphertext, RELEASE_ID);

  const decrypted = decryptCmsWithPassphrase(
    ciphertext,
    fixture.certificate,
    fixture.privateKey,
    `${KEY_PASSPHRASE}\n`,
  );
  assert.equal(decrypted.status, 0);
  assert.deepEqual(decrypted.stdout, plaintext);
  for (const passphraseInput of ["wrong-passphrase\n", ""]) {
    const rejected = decryptCmsWithPassphrase(
      ciphertext,
      fixture.certificate,
      fixture.privateKey,
      passphraseInput,
    );
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout.length, 0);
  }

  const sourceAudit = join(fixture.releaseDirectory, ".source-audit.json");
  const restoreAudit = join(fixture.releaseDirectory, ".restore-audit.json");
  for (const path of [sourceAudit, restoreAudit]) {
    writeFileSync(path, `${JSON.stringify(audit())}\n`, { mode: 0o600 });
  }
  const restoreDatabase = "slopproof_restore_20260813_080001";
  const dropProof = join(fixture.releaseDirectory, ".drop-proof.json");
  writeFileSync(
    dropProof,
    `${JSON.stringify({ schema: "slopproof.database-drop-proof.v1", databaseName: restoreDatabase, databasePresent: false })}\n`,
    { mode: 0o600 },
  );
  const receipt = join(fixture.releaseDirectory, `${RELEASE_ID}.receipt.json`);
  const timestamp = utc();
  await writeBackupReceipt({
    releaseId: RELEASE_ID,
    commit: COMMIT,
    imageDigest: IMAGE_DIGEST,
    timestamp,
    ciphertextPath: ciphertext,
    recipientCertificatePath: fixture.certificate,
    sourceAuditPath: sourceAudit,
    restoreAuditPath: restoreAudit,
    dropProofPath: dropProof,
    restoreDatabaseName: restoreDatabase,
    restoreStartedAt: utc(1),
    restoreCompletedAt: utc(2),
    outputPath: receipt,
  });
  const ciphertextSha256 = createHash("sha256")
    .update(readFileSync(ciphertext))
    .digest("hex");
  const verified = await verifyBackupReceipt({
    receiptPath: receipt,
    recipientCertificatePath: fixture.certificate,
    expectedReleaseId: RELEASE_ID,
    expectedCommit: COMMIT,
    expectedImageDigest: IMAGE_DIGEST,
    expectedCiphertextSha256: ciphertextSha256,
  });
  assert.equal(verified.ciphertextSha256, ciphertextSha256);
  const parsed = JSON.parse(readFileSync(receipt, "utf8"));
  const certificate = new X509Certificate(readFileSync(fixture.certificate));
  assert.equal(
    parsed.recipient.certificateSha256,
    createHash("sha256").update(certificate.raw).digest("hex"),
  );
});

test("CMS structure validation rejects a non-CMS or wrong filename", async (t) => {
  const fixture = createDirectoryFixture();
  t.after(() => rmSync(fixture.parent, { recursive: true, force: true }));
  const path = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
  writeFileSync(path, "not cms", { mode: 0o600 });
  await assert.rejects(verifyCmsArtifact(path, RELEASE_ID));
  const wrong = join(fixture.releaseDirectory, "wrong.cms");
  encryptCms("test", fixture.certificate, wrong);
  await assert.rejects(verifyCmsArtifact(wrong, RELEASE_ID));
});

test("CMS structure validation rejects an additional recipient", async (t) => {
  const fixture = createDirectoryFixture();
  t.after(() => rmSync(fixture.parent, { recursive: true, force: true }));
  const extraPrivateKey = join(fixture.keyDirectory, "extra-private.pem");
  const extraCertificate = join(fixture.keyDirectory, "extra-cert.pem");
  const extraRecipientGeneration = spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-aes-256-cbc",
      "-passout",
      "stdin",
      "-keyout",
      extraPrivateKey,
      "-out",
      extraCertificate,
      "-days",
      "2",
      "-sha256",
      "-subj",
      "/CN=Unexpected backup recipient",
    ],
    { input: `${KEY_PASSPHRASE}\n`, encoding: "utf8" },
  );
  assert.equal(extraRecipientGeneration.status, 0);
  const path = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
  encryptCmsForTwoRecipients(
    "two-recipient-ciphertext",
    fixture.certificate,
    extraCertificate,
    path,
  );
  await assert.rejects(verifyCmsArtifact(path, RELEASE_ID));
});

test("production decryption rejects an unencrypted private key before prompting", async (t) => {
  const fixture = createDirectoryFixture();
  t.after(() => rmSync(fixture.parent, { recursive: true, force: true }));
  const unencryptedKey = join(fixture.keyDirectory, "unencrypted-private.pem");
  execFileSync(
    "openssl",
    [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:3072",
      "-out",
      unencryptedKey,
    ],
    { stdio: "ignore" },
  );
  chmodSync(unencryptedKey, 0o600);
  const ciphertext = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
  encryptCms("encrypted-key-required", fixture.certificate, ciphertext);
  const helper = join(
    process.cwd(),
    "scripts/production-backup/decrypt-cms-stream.sh",
  );
  const result = spawnSync(helper, [
    "--ciphertext",
    ciphertext,
    "--recipient-certificate",
    fixture.certificate,
    "--recipient-key",
    unencryptedKey,
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(
    result.stderr.toString("utf8"),
    "Backup private key is not encrypted\n",
  );
});

test(
  "production helper handles encrypted keys and fails closed on wrong or empty passphrases",
  { skip: !productionPtyIsUsable() },
  async (t) => {
    const fixture = createDirectoryFixture();
    t.after(() => rmSync(fixture.parent, { recursive: true, force: true }));
    const plaintext = Buffer.from("PGDMP encrypted production helper fixture");
    const ciphertext = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
    encryptCms(plaintext, fixture.certificate, ciphertext);
    const plaintextDigest = createHash("sha256")
      .update(plaintext)
      .digest("hex");
    const emptyDigest = createHash("sha256").update("").digest("hex");

    // Immediate PTY sends previously raced the helper's separate prompt and
    // `read -s`; repeat the real helper path so terminal echo regressions are
    // caught even when the scheduler happens to hide one attempt.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const accepted = decryptCmsWithProductionHelperInPty(
        ciphertext,
        fixture.certificate,
        fixture.privateKey,
        KEY_PASSPHRASE,
      );
      assert.equal(accepted.status, 0);
      assert.match(accepted.stdout, new RegExp(plaintextDigest, "u"));
      assert.equal(accepted.stdout.includes(KEY_PASSPHRASE), false);
    }

    for (const [passphrase, diagnostic] of [
      ["intentionally-wrong-fixture", "Authenticated CMS decryption failed"],
      ["", "Backup private-key passphrase is empty"],
    ]) {
      const rejected = decryptCmsWithProductionHelperInPty(
        ciphertext,
        fixture.certificate,
        fixture.privateKey,
        passphrase,
      );
      assert.equal(rejected.status, 1);
      assert.match(rejected.stdout, new RegExp(emptyDigest, "u"));
      assert.match(rejected.stdout, new RegExp(diagnostic, "u"));
      assert.equal(
        rejected.stdout.includes(passphrase) && passphrase !== "",
        false,
      );
    }
  },
);

test("database audit validation rejects claims outside the scalar contract", () => {
  assert.deepEqual(parseDatabaseAudit(JSON.stringify(audit())), audit());
  assert.throws(() =>
    validateDatabaseAudit({ ...audit(), retentionInvariantViolations: 1 }),
  );
  assert.throws(() => validateDatabaseAudit({ ...audit(), rows: [] }));
});

test("workflow is path-bound, bounded and never stages a plaintext dump", () => {
  const workflow = readFileSync(
    new URL("../production-backup/run-backup-rehearsal.sh", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /MAX_FILE_BLOCKS_1_GIB=1048576/u);
  assert.match(workflow, /SCRIPT_ROOT=.*BASH_SOURCE/u);
  assert.match(workflow, /alarm shift; exec @ARGV/u);
  assert.match(workflow, /ulimit -c 0/u);
  assert.match(workflow, /require_encrypted_private_key "\$recipient_key"/u);
  assert.match(workflow, /set -o noclobber[\s\S]*exec 9>/u);
  assert.match(workflow, /rsa_mgf1_md:sha256[\s\\\n]*>&9 2>\/dev\/null/u);
  assert.doesNotMatch(workflow, /-out \/dev\/fd\/9/u);
  assert.match(workflow, /pg_dump[\s\S]*\|[\s\S]*openssl cms -encrypt/u);
  assert.match(workflow, /decrypt-cms-stream\.sh[\s\S]*\|[\s\S]*pg_restore/u);
  assert.match(workflow, /cleanup_restore_failed=true/u);
  assert.match(
    workflow,
    /Restore-only cleanup failed; production is locked until the stale container is removed\./u,
  );
  assert.doesNotMatch(workflow, />[^\n]*(?:\.dump|pg_dump)/u);
  assert.doesNotMatch(workflow, /--command=.*SELECT/u);
});

test("restore runs only in the remote release-bound tmpfs lifecycle", () => {
  const workflow = readFileSync(
    new URL("../production-backup/run-backup-rehearsal.sh", import.meta.url),
    "utf8",
  );
  const restore = workflow.slice(workflow.indexOf('restore_database="'));
  assert.match(restore, /restore-start "\$release_id" "\$restore_database"/u);
  assert.match(
    restore,
    /restore-exec "\$release_id" "\$restore_database"[\s\S]*pg_restore/u,
  );
  assert.match(
    restore,
    /restore-exec "\$release_id" "\$restore_database"[\s\S]*database-audit\.sql/u,
  );
  assert.match(restore, /restore-stop "\$release_id" "\$restore_database"/u);
  assert.match(restore, /restore-absent "\$release_id" "\$restore_database"/u);
  assert.doesNotMatch(
    restore,
    /remote_compose[\s\S]{0,180}(?:pg_restore|dropdb|createdb)/u,
  );
  assert.match(workflow, /trap 'cleanup 129' HUP/u);
  assert.match(workflow, /trap 'cleanup 130' INT/u);
  assert.match(workflow, /trap 'cleanup 143' TERM/u);
});

test("decryption helper prompts on the terminal without argv, env or file passphrase", () => {
  const helper = readFileSync(
    new URL("../production-backup/decrypt-cms-stream.sh", import.meta.url),
    "utf8",
  );
  assert.match(helper, /\[\[ \$- != \*x\* \]\]/u);
  assert.match(helper, /BEGIN ENCRYPTED PRIVATE KEY/u);
  assert.match(helper, /terminal_state=\$\(\/bin\/stty -g/u);
  assert.match(helper, /terminal_echo_disabled=true/u);
  assert.match(helper, /\/bin\/stty -echo/u);
  assert.match(helper, /> \/dev\/tty/u);
  assert.match(
    helper,
    /IFS= builtin read -r backup_passphrase 2>\/dev\/null < \/dev\/tty/u,
  );
  assert.match(helper, /builtin printf '%s\\n' "\$backup_passphrase" \|/u);
  assert.match(helper, /-passin stdin/u);
  assert.match(helper, /unset backup_passphrase/u);
  for (const signalStatus of [129, 130, 143]) {
    assert.match(helper, new RegExp(`cleanup_on_signal ${signalStatus}`, "u"));
  }
  assert.match(helper, /restore_terminal \|\| true/u);
  assert.doesNotMatch(helper, /export backup_passphrase/u);
  assert.doesNotMatch(helper, /-passin (?:pass|env|file):/u);
  assert.ok(
    helper.indexOf("/bin/stty -echo") <
      helper.indexOf("Backup private-key passphrase: "),
  );
  assert.ok(
    helper.indexOf("Backup private-key passphrase: ") <
      helper.indexOf("builtin read -r backup_passphrase"),
  );
  const runbook = readFileSync(
    new URL(
      "../../docs/operations/database-backup-restore.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(runbook, /-newkey rsa:3072 -cipher aes-256-cbc/u);
  assert.doesNotMatch(runbook, /-newkey rsa:3072 -aes-256-cbc/u);
});

test("CMS publication fsyncs the held partial inode before final linking", () => {
  const finalizer = readFileSync(
    new URL("../production-backup/cms-artifact.mjs", import.meta.url),
    "utf8",
  );
  const openIndex = finalizer.indexOf(
    "constants.O_RDONLY | constants.O_NOFOLLOW",
  );
  const fileSyncIndex = finalizer.indexOf("fsyncSync(partialDescriptor)");
  const linkIndex = finalizer.indexOf("linkSync(partialPath, finalPath)");
  const unlinkIndex = finalizer.indexOf("unlinkSync(partialPath)");
  const directorySyncIndex = finalizer.indexOf(
    "fsyncSync(directoryDescriptor)",
  );
  assert.ok(openIndex !== -1);
  assert.ok(openIndex < fileSyncIndex);
  assert.ok(fileSyncIndex < linkIndex);
  assert.ok(linkIndex < unlinkIndex);
  assert.ok(unlinkIndex < directorySyncIndex);
});

test("final backup publication syncs the release directory before its parent", () => {
  const fixture = createDirectoryFixture();
  const cmsPath = join(fixture.releaseDirectory, `${RELEASE_ID}.cms`);
  const receiptPath = join(
    fixture.releaseDirectory,
    `${RELEASE_ID}.receipt.json`,
  );
  writeFileSync(cmsPath, "cms");
  writeFileSync(receiptPath, "receipt");
  chmodSync(cmsPath, 0o600);
  chmodSync(receiptPath, 0o600);

  assert.doesNotThrow(() =>
    syncBackupPublication({
      backupRoot: fixture.backupRoot,
      releaseDirectory: fixture.releaseDirectory,
      releaseId: RELEASE_ID,
    }),
  );
  writeFileSync(join(fixture.releaseDirectory, ".unexpected"), "unsafe");
  assert.throws(
    () =>
      syncBackupPublication({
        backupRoot: fixture.backupRoot,
        releaseDirectory: fixture.releaseDirectory,
        releaseId: RELEASE_ID,
      }),
    /artifact set/u,
  );

  const helper = readFileSync(
    new URL("../production-backup/sync-publication.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    helper.indexOf("fsyncSync(releaseDescriptor)") <
      helper.indexOf("fsyncSync(backupRootDescriptor)"),
  );
  const workflow = readFileSync(
    new URL("../production-backup/run-backup-rehearsal.sh", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.indexOf('rm -f -- "$source_audit"') <
      workflow.indexOf("sync-publication.mjs"),
  );
  assert.ok(
    workflow.indexOf("sync-publication.mjs") <
      workflow.lastIndexOf("trap - EXIT HUP INT TERM"),
  );
});

test("workflow emits only fixed value-free failure diagnostics from local helpers", () => {
  const helper = join(
    process.cwd(),
    "scripts/production-backup/validate-drop-proof.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "--expected-database",
      "slopproof_restore_20260813_080001",
      "--output",
      "/definitely/not/a/valid/output",
    ],
    { input: '{"secret":"must-not-print"}', encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Restore database absence verification failed.\n",
  );
  assert.equal(result.stderr.includes("must-not-print"), false);
});
