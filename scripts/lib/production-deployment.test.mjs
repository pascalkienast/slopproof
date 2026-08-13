import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { isForbiddenReleasePath } from "../production-deploy/prepare-release.mjs";
import { renderCaddyCandidate } from "../production-deploy/render-caddy.mjs";
import {
  CaddyCredentialError,
  installCaddyCredential,
} from "../production-deploy/prepare-caddy-credential.mjs";

const read = (path) => readFileSync(path, "utf8");

test("release exclusion policy rejects every secret, cache, report and bootstrap class", () => {
  for (const path of [
    ".git/config",
    "node_modules/a.js",
    ".pnpm-store/a",
    "apps/web/.next/server.js",
    "packages/db/dist/index.js",
    "coverage/report.json",
    "reports/a.json",
    "playwright-report/index.html",
    ".env",
    ".env.example",
    "nested/.env.production",
    "secret.pem",
    "secret.key",
    "bootstrap-20260812-1527/file",
  ]) {
    assert.equal(isForbiddenReleasePath(path), true, path);
  }
  assert.equal(isForbiddenReleasePath("apps/web/app/page.tsx"), false);
});

test("tracked release enumeration is recursive and archives only its filtered allowlist", () => {
  const release = read("scripts/production-deploy/prepare-release.mjs");
  assert.match(release, /"ls-tree", "-r", "-z", "HEAD"/u);
  assert.match(
    release,
    /\.filter\(\(\{ path \}\) => !isForbiddenReleasePath\(path\)\)/u,
  );
  assert.match(release, /\.\.\.files\.map\(\(\{ path \}\) => path\)/u);
  assert.match(release, /Docker image archive identity mismatch/u);
  assert.match(release, /Trivy report contains HIGH or CRITICAL findings/u);
  assert.match(release, /postgresPlatform: "linux\/amd64"/u);
});

test("Caddy renderer preserves exact non-SlopProof bytes and leaves only a runtime credential", () => {
  const prefix = "# cohost-a\ncohost.example { respond ok }\n";
  const oldBlock = "# old slopproof\nslopproof.paskie.me { respond old }\n";
  const live = `${prefix}${oldBlock}`;
  const hash = (value) =>
    execFileSync("shasum", ["-a", "256"], {
      input: value,
      encoding: "utf8",
    }).split(" ")[0];
  const candidate = renderCaddyCandidate({
    liveCaddyfile: live,
    expectedLiveSha256: hash(live),
    preservedPrefix: prefix,
    expectedPrefixSha256: hash(prefix),
    currentManagedBlock: oldBlock,
    expectedManagedBlockSha256: hash(oldBlock),
    productionTemplate: read("infra/caddy/Caddyfile.production"),
  });
  assert.ok(candidate.includes(prefix));
  assert.equal(
    candidate.split("admin unix//run/caddy/admin.sock").length - 1,
    1,
  );
  assert.equal(candidate.split("persist_config off").length - 1, 1);
  assert.equal(
    candidate.split(
      "{file./run/credentials/caddy.service/oauth-proxy-authenticator}",
    ).length - 1,
    1,
  );
  assert.doesNotMatch(candidate, /\{\$(?:OAUTH|.*SECRET)|\{env\.OAUTH/u);
  assert.match(candidate, /header @landing >Content-Security-Policy/u);
});

test("Caddy credential conversion is strict, atomic and refuses overwrite", (t) => {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "slopproof-caddy-credential-"),
  );
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, "proxy.env");
  const output = join(directory, "oauth-proxy-authenticator");
  const secret = "a".repeat(43);
  writeFileSync(input, `OAUTH_TRUSTED_PROXY_SECRET='${secret}'\n`, {
    mode: 0o600,
  });
  installCaddyCredential(input, output);
  assert.throws(
    () => installCaddyCredential(input, output),
    CaddyCredentialError,
  );
  const cli = spawnSync(
    process.execPath,
    ["scripts/production-deploy/prepare-caddy-credential.mjs", input, output],
    { encoding: "utf8" },
  );
  assert.equal(`${cli.stdout}${cli.stderr}`.includes(secret), false);
});

test("deployment phases are bounded, non-destructive and enforce ACL and backup boundaries", () => {
  const deploy = read("scripts/production-deploy/deploy.sh");
  const transfer = read("scripts/production-deploy/transfer-release.sh");
  const wait = read("scripts/production-deploy/wait-ready.sh");
  assert.match(
    deploy,
    /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\nexport PATH/u,
  );
  for (const phase of [
    "preflight",
    "install",
    "image-stage",
    "postgres-only",
    "backup-compose",
    "restore-start",
    "restore-exec",
    "restore-stop",
    "restore-absent",
    "migrate-start",
    "initial-caddy-cutover",
    "finalize",
    "rollback",
  ]) {
    assert.ok(deploy.includes(phase), phase);
  }
  assert.doesNotMatch(`${deploy}\n${transfer}`, /rsync[^\n]*--delete/u);
  assert.doesNotMatch(deploy, /docker compose[^\n]*\bdown\b|docker volume rm/u);
  assert.match(deploy, /setfacl -m u:1000:--x,u:70:--x/u);
  assert.match(deploy, /setfacl -m u:70:r--/u);
  assert.match(deploy, /slopproof\.verified-backup-boundary\.v1/u);
  assert.doesNotMatch(
    deploy,
    /phase_install_backup_boundary|install-backup-boundary\)/u,
  );
  assert.match(deploy, /pg_dump\)[\s\S]*psql\)/u);
  const backupCompose = deploy.slice(
    deploy.indexOf("phase_backup_compose()"),
    deploy.indexOf("assert_restore_container()"),
  );
  assert.match(backupCompose, /require_bootstrapped_host/u);
  assert.match(backupCompose, /verify_release "\$release_id" >\/dev\/null/u);
  assert.match(backupCompose, /assert_staged_release_images "\$release_id"/u);
  assert.match(
    backupCompose,
    /assert_release_container_images "\$release_id" postgres/u,
  );
  assert.doesNotMatch(deploy, /pg_dump\|pg_restore|createdb\|dropdb/u);
  assert.match(
    read("scripts/production-deploy/verify-and-transfer-backup.sh"),
    /production-backup\/verify-receipt\.mjs/u,
  );
  assert.match(
    deploy,
    /docker pull --platform linux\/amd64 "\$POSTGRES_IMAGE"/u,
  );
  assert.match(
    deploy,
    /grep -Fq -f "\$SECRET_ROOT\/\$release_id\/oauth-proxy-authenticator"/u,
  );
  assert.match(deploy, /--unix-socket \/run\/caddy\/admin\.sock/u);
  for (const cleanup of ["restore_failed_cutover", "restore_failed_finalize"]) {
    assert.match(deploy, new RegExp(`trap '${cleanup} \\$\\?' EXIT`, "u"));
    assert.match(deploy, new RegExp(`trap '${cleanup} 129' HUP`, "u"));
    assert.match(deploy, new RegExp(`trap '${cleanup} 130' INT`, "u"));
    assert.match(deploy, new RegExp(`trap '${cleanup} 143' TERM`, "u"));
  }
  assert.match(deploy, /sed -n '1,108p'/u);
  assert.match(deploy, /Caddy snapshot reconstruction mismatch/u);
  const cutover = deploy.slice(
    deploy.indexOf("phase_initial_caddy_cutover()"),
    deploy.indexOf("phase_finalize()"),
  );
  assert.ok(
    cutover.indexOf('sync -f "$backup"') <
      cutover.indexOf('mv -Tf "$dropin_temporary" "$CADDY_DROPIN"'),
  );
  assert.ok(
    cutover.indexOf(
      'mv -Tf "$SECRET_ROOT/current.next" "$SECRET_ROOT/current"',
    ) < cutover.indexOf('mv -Tf "$dropin_temporary" "$CADDY_DROPIN"'),
  );
  assert.ok(
    cutover.indexOf('mv -Tf "$dropin_temporary" "$CADDY_DROPIN"') <
      cutover.indexOf('mv -Tf "$caddy_temporary" "$CADDYFILE"'),
  );
  assert.match(cutover, /sync -f "\$SECRET_ROOT"/u);
  assert.match(cutover, /sync -f "\$\(dirname "\$CADDY_DROPIN"\)"/u);
  assert.match(cutover, /sync -f "\$\(dirname "\$CADDYFILE"\)"/u);
  const failedCutover = cutover.slice(
    cutover.indexOf("restore_failed_cutover()"),
    cutover.indexOf("trap 'restore_failed_cutover $?'"),
  );
  const recoveryCaddy = failedCutover.indexOf(
    'mv -Tf "$caddy_temporary.restore" "$CADDYFILE"',
  );
  const recoveryCaddySync = failedCutover.indexOf(
    'sync -f "$(dirname "$CADDYFILE")"',
  );
  const recoveryDropin = failedCutover.indexOf(
    'mv -Tf "$dropin_temporary.restore" "$CADDY_DROPIN"',
  );
  const recoveryDropinSync = failedCutover.indexOf(
    'sync -f "$(dirname "$CADDY_DROPIN")"',
  );
  const recoverySecret = failedCutover.indexOf(
    'mv -Tf "$SECRET_ROOT/current.restore" "$SECRET_ROOT/current"',
  );
  const recoverySecretSync = failedCutover.indexOf('sync -f "$SECRET_ROOT"');
  assert.ok(
    recoveryCaddy < recoveryCaddySync && recoveryCaddySync < recoveryDropin,
  );
  assert.ok(
    recoveryDropin < recoveryDropinSync && recoveryDropinSync < recoverySecret,
  );
  assert.ok(recoverySecret < recoverySecretSync);

  const rollback = deploy.slice(
    deploy.indexOf("phase_rollback()"),
    deploy.indexOf('case "${1:-}" in'),
  );
  const disableIndex = rollback.indexOf(
    "timeout --signal=TERM --kill-after=5s 30 systemctl disable slopproof-compose.service",
  );
  const caddyIndex = rollback.indexOf(
    'mv -Tf "$restore_temporary" "$CADDYFILE"',
  );
  const caddySyncIndex = rollback.indexOf('sync -f "$(dirname "$CADDYFILE")"');
  const dropinIndex = rollback.indexOf(
    'mv -Tf "$restore_temporary" "$CADDY_DROPIN"',
  );
  const dropinSyncIndex = rollback.indexOf(
    'sync -f "$(dirname "$CADDY_DROPIN")"',
  );
  const secretIndex = rollback.indexOf(
    'mv -Tf "$SECRET_ROOT/current.rollback" "$SECRET_ROOT/current"',
  );
  const secretSyncIndex = rollback.indexOf('sync -f "$SECRET_ROOT"');
  assert.ok(disableIndex !== -1 && disableIndex < caddyIndex);
  assert.match(
    rollback,
    /compose_enable_link='\/etc\/systemd\/system\/multi-user\.target\.wants\/slopproof-compose\.service'/u,
  );
  assert.match(rollback, /rm -f -- "\$compose_enable_link"/u);
  assert.match(rollback, /SlopProof Compose enable boundary is unsafe/u);
  assert.ok(caddyIndex < caddySyncIndex && caddySyncIndex < dropinIndex);
  assert.ok(dropinIndex < dropinSyncIndex && dropinSyncIndex < secretIndex);
  assert.ok(secretIndex < secretSyncIndex);
  assert.match(rollback, /sync -f "\$\(dirname "\$CURRENT_LINK"\)"/u);
  assert.match(rollback, /sync -f "\$ETC_ROOT"/u);
  assert.match(rollback, /sync -f "\$\(dirname "\$COMPOSE_UNIT"\)"/u);

  const finalize = deploy.slice(
    deploy.indexOf("phase_finalize()"),
    deploy.indexOf("phase_rollback()"),
  );
  const finalRename = finalize.indexOf(
    'mv -- "$(release_incoming "$release_id")" "$final"',
  );
  const releaseParentSync = finalize.indexOf('sync -f "$(dirname "$final")"');
  const currentRename = finalize.indexOf(
    'mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"',
  );
  const currentParentSync = finalize.indexOf(
    'sync -f "$(dirname "$CURRENT_LINK")"',
  );
  const envRename = finalize.indexOf(
    'mv -Tf "$release_env_temporary" "$ETC_ROOT/release.env"',
  );
  const envParentSync = finalize.indexOf('sync -f "$ETC_ROOT"');
  const unitRename = finalize.indexOf(
    'mv -Tf "$unit_temporary" "$COMPOSE_UNIT"',
  );
  const unitParentSync = finalize.indexOf(
    'sync -f "$(dirname "$COMPOSE_UNIT")"',
  );
  const enableIndex = finalize.indexOf(
    "systemctl enable slopproof-compose.service",
  );
  const enableParentSync = finalize.indexOf("sync -f /etc/systemd/system");
  const startIndex = finalize.indexOf(
    "systemctl start slopproof-compose.service",
  );
  assert.ok(
    finalRename < releaseParentSync && releaseParentSync < currentRename,
  );
  assert.ok(currentRename < currentParentSync && currentParentSync < envRename);
  assert.ok(envRename < envParentSync && envParentSync < unitRename);
  assert.ok(unitRename < unitParentSync && unitParentSync < enableIndex);
  assert.ok(enableIndex < enableParentSync && enableParentSync < startIndex);
  assert.match(
    deploy,
    /Automatic rollback is limited to the audited bootstrap boundary/u,
  );
  assert.match(deploy, /PostgreSQL rollback preservation proof failed/u);
  assert.match(deploy, /assert_staged_release_images "\$release_id"/u);
  assert.match(
    deploy,
    /assert_release_container_images "\$release_id" postgres migrate worker github-control web/u,
  );
  assert.match(deploy, /SLOPPROOF_IMAGE="\$app_id"/u);
  const runtimeVerifier = read(
    "scripts/production-deploy/verify-runtime-release.sh",
  );
  assert.equal(
    execFileSync(
      "stat",
      ["-f", "%Lp", "scripts/production-deploy/verify-runtime-release.sh"],
      {
        encoding: "utf8",
      },
    ).trim(),
    "755",
  );
  assert.match(runtimeVerifier, /slopproof\.image-stage\.v2/u);
  assert.match(
    runtimeVerifier,
    /Application image identity changed after staging/u,
  );
  assert.match(runtimeVerifier, /Runtime service uses an unexpected image/u);
  assert.match(
    runtimeVerifier,
    /\[\[ \$\{SLOPPROOF_IMAGE:-\} == "\$app_id" \]\]/u,
  );
  assert.match(
    runtimeVerifier,
    /\[\[ \$\{SLOPPROOF_POSTGRES_IMAGE:-\} == "\$postgres_id" \]\]/u,
  );
  assert.doesNotMatch(runtimeVerifier, /-z \$\{SLOPPROOF_(?:POSTGRES_)?IMAGE/u);
  assert.match(runtimeVerifier, /--platform linux\/amd64/u);
  assert.match(
    runtimeVerifier,
    /--format '\{\{\.Id\}\} \{\{\.Os\}\}\/\{\{\.Architecture\}\}' "\$app_id"/u,
  );
  assert.doesNotMatch(
    runtimeVerifier,
    /--platform linux\/amd64 --format '\{\{\.Id\}\}/u,
  );
  assert.match(
    deploy,
    /postgres_id=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$POSTGRES_IMAGE"\)/u,
  );
  assert.match(deploy, /DATA_ROOT=\/var\/lib\/slopproof-production/u);
  assert.match(deploy, /Production data parent identity mismatch/u);
  assert.match(
    deploy,
    /mkdir --mode=0700 -- "\$DATA_ROOT"[\s\S]*chown root:root "\$DATA_ROOT"/u,
  );
  assert.match(
    deploy,
    /realpath -e -- "\$postgres_directory"[\s\S]*'70:70 700'/u,
  );
  assert.match(deploy, /assert_all_restore_containers_absent/u);
  assert.match(deploy, /printf '%s' 'slopproof-restore-global'/u);
  assert.doesNotMatch(deploy, /slopproof-restore-%s/u);
  assert.match(deploy, /com\.slopproof\.restore\.owner=\$owner_token/u);
  assert.match(
    deploy,
    /"\$cleanup_identity" == "\$owner_token\|\$release_id\|\$restore_database\|\$postgres_image_id"/u,
  );
  assert.doesNotMatch(
    deploy,
    /if \[\[ "\$started" == true \]\][\s\S]{0,160}docker rm --force/u,
  );
  assert.match(deploy, /filter label=com\.slopproof\.restore\.release\)/u);
  assert.doesNotMatch(deploy, /install -d -o 70 -g 70/u);
  assert.match(deploy, /rollback-bootstrap/u);
  assert.doesNotMatch(
    deploy,
    /systemctl stop slopproof-compose\.service \|\| true/u,
  );
  assert.match(deploy, /bootstrap-\[0-9\]/u);
  assert.match(wait, /10#\$1 <= 900/u);
  assert.match(wait, /api\/health\/ready/u);
});

test("restore rehearsal uses only a release-bound disposable tmpfs PostgreSQL", () => {
  const deploy = read("scripts/production-deploy/deploy.sh");
  const start = deploy.slice(
    deploy.indexOf("phase_restore_start()"),
    deploy.indexOf("phase_restore_exec()"),
  );
  const inspect = deploy.slice(
    deploy.indexOf("assert_restore_container()"),
    deploy.indexOf("assert_restore_absent()"),
  );
  for (const contract of [
    "--network none",
    "--log-driver none",
    "--pull never",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--ulimit core=0:0",
    "--cpus 0.5",
    "--memory 1024m",
    "--memory-swap 1024m",
    "--pids-limit 192",
    "--tmpfs /var/lib/postgresql:rw,noexec,nosuid,nodev,size=768m",
    "PGDATA=/var/lib/postgresql/data",
    "POSTGRES_INITDB_WALDIR=/var/lib/postgresql/wal",
    "logging_collector=off",
    "log_min_error_statement=fatal",
    "log_parameter_max_length_on_error=0",
  ]) {
    assert.ok(start.includes(contract), contract);
  }
  assert.doesNotMatch(start, /DATA_ROOT|\/var\/lib\/slopproof/u);
  assert.match(start, /timeout --signal=TERM --kill-after=10s 90 docker run/u);
  assert.match(start, /ulimit -S -c[\s\S]*ulimit -H -c/u);
  assert.match(inspect, /HostConfig\.NetworkMode == "none"/u);
  assert.match(inspect, /\.\[0\]\.Image == \$image_id/u);
  assert.match(inspect, /HostConfig\.LogConfig\.Type == "none"/u);
  assert.match(inspect, /HostConfig\.Binds == null/u);
  assert.match(inspect, /HostConfig\.Mounts == null/u);
  assert.match(inspect, /\(\.\[0\]\.Mounts \| length\) == 0/u);
  assert.match(inspect, /HostConfig\.Tmpfs\["\/var\/lib\/postgresql"\]/u);
  assert.match(inspect, /\.HostConfig\.Ulimits/u);
  assert.match(deploy, /docker rm --volumes/u);
  assert.match(deploy, /label=com\.slopproof\.restore\.release/u);
  assert.match(
    deploy,
    /restore-start[\s\S]*restore-exec[\s\S]*restore-stop[\s\S]*restore-absent/u,
  );
});

test("systemd units never ingest raw secret environments and prohibit implicit image pulls", () => {
  const composeUnit = read("infra/systemd/slopproof-compose.service");
  const caddyDropin = read(
    "infra/systemd/caddy.service.d/10-slopproof-credential.conf",
  );
  assert.match(
    composeUnit,
    /ConditionPathExists=\/opt\/slopproof\/current\/compose\.production\.yaml/u,
  );
  assert.match(
    composeUnit,
    /--no-build --pull never --remove-orphans --wait --wait-timeout 240/u,
  );
  assert.doesNotMatch(composeUnit, /EnvironmentFile=.*secrets|env_file/u);
  assert.match(
    composeUnit,
    /verify-runtime-release\.sh images[\s\S]*compose[\s\S]*up[\s\S]*verify-runtime-release\.sh containers postgres migrate worker github-control web/u,
  );
  assert.match(caddyDropin, /LoadCredential=oauth-proxy-authenticator:/u);
  assert.doesNotMatch(
    caddyDropin.replace(/^#.*$/gmu, ""),
    /--environ|EnvironmentFile/u,
  );
  assert.match(caddyDropin, /--address unix\/\/run\/caddy\/admin\.sock/u);
  assert.match(caddyDropin, /RuntimeDirectoryMode=0700/u);
});

test("production smoke covers exact app boundaries and every existing cohost", () => {
  const smoke = read("scripts/production-deploy/smoke-production.sh");
  for (const value of [
    "https://slopproof.paskie.me",
    "https://paskie.me",
    "https://wunderbluete.club",
    "https://replikator.paskie.me/api/health",
    "sec-fetch-site: same-origin",
    "invalid_signature",
    '"$BASE_URL/api/health/$endpoint"',
    "rollback-bootstrap",
  ])
    assert.ok(smoke.includes(value), value);
  assert.match(smoke, /findmnt -n -o FSTYPE -T \/run\) == tmpfs/u);
  assert.match(smoke, /mktemp -d \/run\/slopproof-smoke/u);
  assert.doesNotMatch(
    smoke,
    /mktemp -d \/tmp|find "\$scratch" -depth -delete/u,
  );
});

test("release resolution is exact for both pre-final and post-final backup phases", () => {
  const deploy = read("scripts/production-deploy/deploy.sh");
  assert.match(deploy, /-d "\$incoming"[\s\S]*! -e "\$final"/u);
  assert.match(deploy, /-d "\$final"[\s\S]*! -e "\$incoming"/u);
  assert.match(deploy, /Release source is absent or ambiguous/u);
  assert.match(deploy, /phase_backup_compose/u);
  assert.match(
    read("docs/operations/database-backup-restore.md"),
    /releases\/<id>\.incoming\/source/u,
  );
});

test("backup boundary transfer uses a clean trusted verifier and bounded exact cleanup", () => {
  const transfer = read(
    "scripts/production-deploy/verify-and-transfer-backup.sh",
  );
  const installer = read(
    "scripts/production-deploy/install-backup-boundary-remote.sh",
  );
  assert.match(transfer, /--trusted-checkout/u);
  assert.match(transfer, /git -C "\$trusted_checkout" status --porcelain/u);
  assert.match(transfer, /trusted_release_verifier" verify --bundle/u);
  assert.match(transfer, /trusted_verifier"/u);
  assert.match(transfer, /trusted_remote_installer/u);
  assert.match(transfer, /alarm shift; exec @ARGV or exit 127' 120/u);
  assert.match(transfer, /ServerAliveInterval=10/u);
  assert.match(transfer, /trap 'rm -f -- "\$boundary"' EXIT/u);
  for (const script of [transfer, installer]) {
    assert.match(script, /\$\{#(?:boundary_base64|encoded_boundary)\} -ge 1/u);
    assert.match(
      script,
      /\$\{#(?:boundary_base64|encoded_boundary)\} -le 4096/u,
    );
    assert.doesNotMatch(script, /\{1,4096\}/u);
  }
  assert.doesNotMatch(transfer, /\bscp\b|find .* -delete/u);
  assert.match(installer, /set -o noclobber/u);
  assert.match(installer, /ln -- "\$incoming" "\$target"/u);
  assert.match(installer, /sync -f "\$target"/u);
  assert.match(installer, /slopproof\.verified-backup-boundary\.v1/u);
});

test("release transfer is Mac-compatible, independently trusted and bounded", () => {
  const transfer = read("scripts/production-deploy/transfer-release.sh");
  const wrapper = read("scripts/production-deploy/verify-install-remote.sh");
  assert.match(transfer, /--trusted-checkout/u);
  assert.match(transfer, /--expected-image-source-commit/u);
  assert.equal(transfer.match(/verify_bundle/gmu)?.length, 3);
  assert.match(transfer, /bounded 900 \/usr\/bin\/rsync/u);
  assert.match(transfer, /--no-owner --no-group --timeout=120/u);
  const executableTransfer = transfer.replace(/^#.*$/gmu, "");
  assert.doesNotMatch(
    executableTransfer,
    /--protect-args|--numeric-ids|--chown/u,
  );
  assert.match(transfer, /stat -f '%u:%Lp'/u);
  assert.match(transfer, /bounded 180 ssh[\s\S]*\/usr\/bin\/bash -s/u);
  assert.match(transfer, /\/usr\/bin\/test ! -L "\$target"/u);
  assert.match(wrapper, /Remote immutable manifest hash mismatch/u);
  assert.match(wrapper, /Remote source content mismatch/u);
  assert.match(wrapper, /Remote artifact content mismatch/u);
  assert.match(
    wrapper,
    /\/usr\/bin\/bash "\$incoming\/source\/scripts\/production-deploy\/deploy\.sh"/u,
  );
});

test("trusted host bootstrap pins apt provenance, tools and zero-core service limits", () => {
  const bootstrap = read("scripts/production-deploy/bootstrap-host.sh");
  const deploy = read("scripts/production-deploy/deploy.sh");
  assert.match(bootstrap, /^#!\/usr\/bin\/env bash/u);
  assert.match(bootstrap, /ID=ubuntu/u);
  assert.match(bootstrap, /VERSION_ID="24\.04"/u);
  assert.match(bootstrap, /dpkg --print-architecture.*amd64/u);
  assert.match(bootstrap, /https:\/\/mirror\.hetzner\.com\/ubuntu\/packages/u);
  assert.match(bootstrap, /https:\/\/mirror\.hetzner\.com\/ubuntu\/security/u);
  assert.match(
    bootstrap,
    /Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/u,
  );
  assert.match(bootstrap, /Unexpected enabled apt source file/u);
  assert.match(bootstrap, /18\.19\.1\+dfsg-6ubuntu5/u);
  assert.match(bootstrap, /1\.7\.1-3ubuntu0\.24\.04\.2/u);
  assert.match(bootstrap, /apt-get install --yes --no-install-recommends/u);
  assert.match(
    bootstrap,
    /bounded 300 env DEBIAN_FRONTEND=noninteractive apt-get update/u,
  );
  assert.match(
    bootstrap,
    /awk '\$1 == "Candidate:" \{ count \+= 1; candidate = \$2 \} END \{ if \(count == 1\) print candidate; else exit 1 \}'/u,
  );
  assert.doesNotMatch(bootstrap, /Candidate:.*print \$2; exit/u);
  assert.match(bootstrap, /docker ps -aq --no-trunc/u);
  assert.match(
    bootstrap,
    /bounded 90 systemctl restart containerd\.service docker\.service/u,
  );
  assert.match(bootstrap, /LimitCORE=0/u);
  assert.match(bootstrap, /LimitCORESoft/u);
  assert.match(bootstrap, /\/proc\/\$pid\/limits/u);
  assert.match(
    bootstrap,
    /SSH_DROPIN=\/etc\/systemd\/system\/ssh\.service\.d\/99-slopproof-core-limit\.conf/u,
  );
  assert.match(bootstrap, /bounded 30 \/usr\/sbin\/sshd -t/u);
  assert.match(bootstrap, /bounded 90 systemctl restart ssh\.service/u);
  assert.match(bootstrap, /require_effective_core_limit ssh\.service/u);
  assert.match(
    bootstrap,
    /cp --archive -- "\$target" "\$state\/\$label\.dropin"/u,
  );
  assert.match(bootstrap, /\$label\.dropin\.absent/u);
  assert.match(bootstrap, /\$label\.parent\.absent/u);
  assert.match(bootstrap, /rmdir -- "\$parent"/u);
  assert.match(
    bootstrap,
    /STATE_ROOT=\/opt\/slopproof\/shared\/host-bootstrap/u,
  );
  assert.doesNotMatch(bootstrap, /\/var\/lib\/slopproof/u);
  assert.match(bootstrap, /trap 'rollback_failed_bootstrap \$\?' EXIT/u);
  assert.match(bootstrap, /trap 'rollback_failed_bootstrap 129' HUP/u);
  assert.match(bootstrap, /trap 'rollback_failed_bootstrap 130' INT/u);
  assert.match(bootstrap, /trap 'rollback_failed_bootstrap 143' TERM/u);
  assert.match(bootstrap, /ulimit -S -c 0[\s\S]*ulimit -H -c 0/u);
  assert.doesNotMatch(
    bootstrap,
    /systemctl[^\n]*apport|\/etc\/default\/apport/u,
  );

  assert.match(deploy, /ulimit -S -c 0[\s\S]*ulimit -H -c 0/u);
  assert.match(deploy, /EXPECTED_NODEJS_PACKAGE='18\.19\.1\+dfsg-6ubuntu5'/u);
  assert.match(deploy, /EXPECTED_JQ_PACKAGE='1\.7\.1-3ubuntu0\.24\.04\.2'/u);
  assert.match(deploy, /require_bootstrapped_host/u);
  assert.match(
    deploy,
    /for unit in containerd\.service docker\.service ssh\.service/u,
  );
  assert.match(deploy, /hard\/soft LimitCORE=0/u);
  assert.match(deploy, /\/proc\/\$pid\/limits/u);
  assert.match(
    deploy,
    /systemctl restart caddy[\s\S]*require_effective_service_core_limit caddy\.service/u,
  );
});

test("Caddy credential unit disables persistent core dumps", () => {
  const dropin = read(
    "infra/systemd/caddy.service.d/10-slopproof-credential.conf",
  );
  assert.match(dropin, /^LimitCORE=0$/mu);
});
