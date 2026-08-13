import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspaceDirectory = fileURLToPath(new URL("../..", import.meta.url));
const composePath = fileURLToPath(
  new URL("../../compose.production.yaml", import.meta.url),
);

const MEBIBYTE = 1024 * 1024;
const MOBILEUP_HOST_BUDGET = Object.freeze({
  cpu: 2,
  memoryMiB: Math.floor(3.73 * 1024),
  swapMiB: 0,
  reservedCpu: 0.25,
  reservedMemoryMiB: 1024,
});
const STEADY_STATE_SERVICES = ["postgres", "worker", "github-control", "web"];
const MINIMUM_SERVICE_BUDGETS = Object.freeze({
  postgres: { cpu: 0.25, memoryMiB: 512 },
  migrate: { cpu: 0.125, memoryMiB: 256 },
  worker: { cpu: 0.5, memoryMiB: 768 },
  "github-control": { cpu: 0.1, memoryMiB: 192 },
  web: { cpu: 0.25, memoryMiB: 384 },
});
const STAGED_POSTGRES_ID = `sha256:${"b".repeat(64)}`;

function loadProductionCompose() {
  const rendered = execFileSync(
    "docker",
    ["compose", "-f", composePath, "config", "--format", "json"],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: "slopproof-production",
        S3_PUBLIC_ENDPOINT: "https://r2.contract.invalid",
        SLOPPROOF_DATA_DIR: "/var/lib/slopproof-production",
        SLOPPROOF_IMAGE: "slopproof-app:production",
        SLOPPROOF_POSTGRES_IMAGE: STAGED_POSTGRES_ID,
        SLOPPROOF_SECRET_DIR: "/etc/slopproof/secrets",
      },
    },
  );
  return JSON.parse(rendered);
}

test("production Compose source parses without interpolation", () => {
  execFileSync(
    "docker",
    ["compose", "-f", composePath, "config", "--no-interpolate", "--quiet"],
    { cwd: workspaceDirectory, stdio: "pipe" },
  );
});

test("production Compose is isolated from the local demo topology", () => {
  const compose = loadProductionCompose();
  assert.equal(compose.name, "slopproof-production");
  assert.equal(compose.services.postgres.image, STAGED_POSTGRES_ID);
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "github-control",
    "migrate",
    "postgres",
    "web",
    "worker",
  ]);
  assert.equal(compose.networks.backend.internal, true);
  assert.equal(compose.networks.egress.internal, undefined);
  assert.equal(compose.volumes, undefined);

  const webPort = compose.services.web.ports;
  assert.deepEqual(webPort, [
    {
      host_ip: "127.0.0.1",
      mode: "ingress",
      protocol: "tcp",
      published: "3000",
      target: 3000,
    },
  ]);
  for (const [name, service] of Object.entries(compose.services)) {
    if (name !== "web") assert.equal(service.ports, undefined);
  }

  assert.deepEqual(Object.keys(compose.services.postgres.networks), [
    "backend",
  ]);
  assert.deepEqual(Object.keys(compose.services.migrate.networks), ["backend"]);
  for (const name of ["web", "worker", "github-control"]) {
    assert.deepEqual(Object.keys(compose.services[name].networks).sort(), [
      "backend",
      "egress",
    ]);
  }

  const postgresVolume = compose.services.postgres.volumes;
  assert.equal(postgresVolume.length, 1);
  assert.equal(postgresVolume[0].type, "bind");
  assert.equal(
    postgresVolume[0].source,
    "/var/lib/slopproof-production/postgres",
  );
  assert.equal(postgresVolume[0].target, "/var/lib/postgresql");
});

test("production processes receive only read-only file-backed secrets", () => {
  const compose = loadProductionCompose();
  const expectedEnvironmentFiles = {
    web: "/run/secrets/web.env",
    worker: "/run/secrets/worker.env",
    "github-control": "/run/secrets/github-control.env",
    migrate: "/run/secrets/migrate.env",
  };

  for (const [name, environmentFile] of Object.entries(
    expectedEnvironmentFiles,
  )) {
    const service = compose.services[name];
    assert.deepEqual(service.environment, {
      SLOPPROOF_ENV_FILE: environmentFile,
    });
    assert.equal(service.env_file, undefined);
    assert.ok(
      service.secrets.some(
        (secret) => `/run/secrets/${secret.target}` === environmentFile,
      ),
    );
  }

  assert.deepEqual(compose.services.postgres.environment, {
    POSTGRES_DB: "slopproof",
    POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password",
    POSTGRES_USER: "slopproof",
  });
  assert.ok(
    compose.services.postgres.secrets.some(
      (secret) => secret.target === "postgres-password",
    ),
  );

  for (const secret of Object.values(compose.secrets)) {
    assert.match(secret.file, /^\/etc\/slopproof\/secrets\//u);
  }

  const source = readFileSync(composePath, "utf8");
  assert.doesNotMatch(source, /^\s*env_file:/mu);
  assert.match(source, /create_host_path:\s*false/u);
  assert.match(source, /S3_PUBLIC_ENDPOINT:\s*\$\{S3_PUBLIC_ENDPOINT:\?/u);
});

test("migrate gates restartable hardened services", () => {
  const compose = loadProductionCompose();
  assert.equal(
    compose.services.migrate.depends_on.postgres.condition,
    "service_healthy",
  );
  assert.equal(compose.services.migrate.restart, "no");
  for (const name of ["web", "worker", "github-control"]) {
    assert.equal(
      compose.services[name].depends_on.migrate.condition,
      "service_completed_successfully",
    );
    assert.equal(compose.services[name].restart, "unless-stopped");
  }
  assert.equal(
    compose.services.web.depends_on.worker.condition,
    "service_healthy",
  );
  assert.equal(
    compose.services.web.depends_on["github-control"].condition,
    "service_healthy",
  );
  assert.match(
    compose.services.web.healthcheck.test.join(" "),
    /\/api\/health\/ready/u,
  );
  assert.match(
    compose.services.worker.healthcheck.test.join(" "),
    /\/healthz/u,
  );
  assert.match(
    compose.services["github-control"].healthcheck.test.join(" "),
    /127\.0\.0\.1:4002\/healthz/u,
  );

  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.read_only, true, `${name} rootfs`);
    assert.ok(service.cap_drop.includes("ALL"), `${name} capabilities`);
    assert.ok(
      service.security_opt.includes("no-new-privileges:true"),
      `${name} privilege escalation`,
    );
    assert.ok(service.cpus > 0, `${name} CPU limit`);
    assert.ok(Number(service.mem_limit) > 0, `${name} memory limit`);
    assert.ok(service.pids_limit > 0, `${name} PID limit`);
    assert.equal(service.stop_signal, "SIGTERM", `${name} stop signal`);
    assert.equal(service.logging.driver, "local", `${name} log driver`);
    assert.equal(service.logging.options["max-size"], "10m");
    assert.equal(service.logging.options["max-file"], "3");
  }
  const rendered = execFileSync(
    "docker",
    ["compose", "-f", composePath, "config"],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        S3_PUBLIC_ENDPOINT: "https://r2.contract.invalid",
        SLOPPROOF_DATA_DIR: "/var/lib/slopproof-production",
        SLOPPROOF_IMAGE: "slopproof-app:production",
        SLOPPROOF_POSTGRES_IMAGE: STAGED_POSTGRES_ID,
        SLOPPROOF_SECRET_DIR: "/etc/slopproof/secrets",
      },
    },
  );
  assert.equal(rendered.match(/core:\n\s+soft: 0\n\s+hard: 0/gmu)?.length, 5);
  assert.equal(compose.services.postgres.user, "70:70");
  assert.equal(compose.services.postgres.image, STAGED_POSTGRES_ID);
  for (const name of ["web", "worker", "github-control", "migrate"]) {
    assert.equal(compose.services[name].user, "1000:1000");
  }
});

test("production resource ceilings fit the no-swap Mobileup host during migration overlap", () => {
  const compose = loadProductionCompose();

  assert.equal(MOBILEUP_HOST_BUDGET.memoryMiB, 3819);
  assert.equal(MOBILEUP_HOST_BUDGET.swapMiB, 0);

  for (const [name, minimum] of Object.entries(MINIMUM_SERVICE_BUDGETS)) {
    const service = compose.services[name];
    assert.ok(
      service.cpus >= minimum.cpu,
      `${name} retains its conservative CPU floor`,
    );
    assert.ok(
      service.mem_limit >= minimum.memoryMiB * MEBIBYTE,
      `${name} retains its conservative memory floor`,
    );
    assert.equal(
      service.memswap_limit,
      service.mem_limit,
      `${name} cannot begin using swap if host policy later drifts`,
    );
    assert.ok(
      service.tmpfs.every((mount) => /(?:^|,)size=\d+m(?:,|$)/u.test(mount)),
      `${name} tmpfs mounts are explicitly bounded inside its memory cgroup`,
    );
  }
  assert.equal(Number(compose.services.postgres.shm_size), 128 * MEBIBYTE);
  assert.ok(
    Number(compose.services.postgres.shm_size) <
      compose.services.postgres.mem_limit,
    "PostgreSQL shared memory remains bounded inside its memory cgroup",
  );

  const aggregate = (names) =>
    names.reduce(
      (total, name) => ({
        cpu: total.cpu + compose.services[name].cpus,
        memoryMiB:
          total.memoryMiB + compose.services[name].mem_limit / MEBIBYTE,
      }),
      { cpu: 0, memoryMiB: 0 },
    );
  const steadyState = aggregate(STEADY_STATE_SERVICES);
  const migrationOverlap = aggregate([...STEADY_STATE_SERVICES, "migrate"]);

  assert.deepEqual(steadyState, { cpu: 1.5, memoryMiB: 2368 });
  assert.deepEqual(migrationOverlap, { cpu: 1.75, memoryMiB: 2752 });
  assert.ok(
    migrationOverlap.cpu <=
      MOBILEUP_HOST_BUDGET.cpu - MOBILEUP_HOST_BUDGET.reservedCpu,
    "migration overlap preserves the host CPU reserve",
  );
  assert.ok(
    migrationOverlap.memoryMiB <=
      MOBILEUP_HOST_BUDGET.memoryMiB - MOBILEUP_HOST_BUDGET.reservedMemoryMiB,
    "migration overlap preserves at least 1 GiB for host and cohosted services",
  );
  assert.ok(
    compose.services.worker.cpus > compose.services.web.cpus &&
      compose.services.worker.mem_limit > compose.services.web.mem_limit,
    "the FFmpeg worker remains the highest-budget application service",
  );
});
