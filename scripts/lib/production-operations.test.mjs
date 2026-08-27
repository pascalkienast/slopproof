import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  LANDING_ASSETS,
  LANDING_PUBLISH,
  LANDING_SOURCE,
  prepareLanding,
} from "../prepare-landing.mjs";

function read(relativePath) {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

function readBytes(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url));
}

test("the repository root exposes only public project markdown", () => {
  const rootMarkdown = readdirSync(new URL("../..", import.meta.url))
    .filter((entry) => entry.endsWith(".md"))
    .sort();

  assert.deepEqual(rootMarkdown, [
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "THIRD_PARTY_NOTICES.md",
  ]);
  assert.match(read("docs/README.md"), /# SlopProof documentation/u);
  assert.match(read("docs/project-status.md"), /# Project status/u);
});

test("Caddy keeps the landing root exact and proxies only named app paths", () => {
  const caddy = read("infra/caddy/Caddyfile.production");

  assert.match(caddy, /@landing \{\s*method GET HEAD\s*path \/\s*\}/u);
  assert.match(
    caddy,
    /@landing_script \{\s*method GET HEAD\s*path \/landing\.js\s*\}/u,
  );
  assert.match(
    caddy,
    /@landing_product_tour \{\s*method GET HEAD\s*path \/product-tour\/\*\s*\}/u,
  );
  assert.match(caddy, /handle @landing_script \{[\s\S]*?file_server\s*\}/u);
  assert.match(
    caddy,
    /handle @landing_product_tour \{[\s\S]*?file_server\s*\}/u,
  );
  assert.match(caddy, /handle @landing \{[\s\S]*?file_server\s*\}/u);
  assert.match(
    caddy,
    /@app path \/api \/api\/\* \/_next \/_next\/\* \/revisions \/revisions\/\* \/m \/m\/\* \/review \/review\/\* \/icon\.svg/u,
  );
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/u);
  assert.match(caddy, /handle \{\s*respond "Not found" 404\s*\}/u);
  assert.doesNotMatch(caddy, /reverse_proxy\s+(?!127\.0\.0\.1:3000)/u);
  assert.match(caddy, />Strict-Transport-Security/u);
  assert.match(caddy, />X-Content-Type-Options "nosniff"/u);
  assert.match(caddy, />X-Frame-Options "DENY"/u);
  assert.match(caddy, />Referrer-Policy "no-referrer"/u);
});

test("landing interactions obey the strict script policy and default to Proof", () => {
  prepareLanding();
  const landing = read(LANDING_SOURCE.html);
  const published = read(LANDING_PUBLISH.html);
  const behavior = read(LANDING_SOURCE.script);
  const publishedBehavior = read(LANDING_PUBLISH.script);

  assert.equal(landing, published);
  assert.equal(behavior, publishedBehavior);
  for (const asset of LANDING_ASSETS) {
    assert.deepEqual(
      readBytes(`${LANDING_SOURCE.assetsDirectory}/${asset}`),
      readBytes(`${LANDING_PUBLISH.assetsDirectory}/${asset}`),
    );
  }
  assert.match(landing, /<script src="\/landing\.js" defer><\/script>/u);
  assert.doesNotMatch(landing, /<script(?:\s|>)(?![^>]*\bsrc=)/u);
  assert.match(
    landing,
    /id="proof-tab"[^>]*aria-selected="true"[^>]*>Prove · required</u,
  );
  assert.match(
    landing,
    /class="mode-panel proof-ui active"[^>]*id="proof-panel"/u,
  );
  assert.match(landing, /class="check-choice proof active"/u);
  assert.match(landing, /class="check-choice optional"/u);
  assert.match(landing, /aria-roledescription="carousel"/u);
  assert.match(
    landing,
    /\.journey-image img \{[^}]*min-width: 0;[^}]*min-height: 0;[^}]*object-fit: contain;/u,
  );
  assert.match(landing, /The real product · 9 steps/u);
  assert.match(landing, /Start with the GitHub App comment\./u);
  assert.match(landing, /Open the linked understanding check\./u);
  assert.match(
    landing,
    /GitHub pull request comment from the SlopProof app, including its avatar and contributor-flow link/u,
  );
  assert.equal(
    [...landing.matchAll(/src="\/product-tour\/[^"\s]+\.webp"/gu)].length,
    LANDING_ASSETS.length,
  );
  for (const asset of LANDING_ASSETS) {
    assert.match(landing, new RegExp(`src="/product-tour/${asset}"`, "u"));
  }
  assert.match(behavior, /function showJourneyStep\(index\)/u);
  assert.match(behavior, /data-journey-direction/u);
  assert.match(behavior, /ArrowLeft/u);
  assert.match(behavior, /ArrowRight/u);
  assert.doesNotMatch(behavior, /setInterval|setTimeout/u);
  assert.doesNotMatch(landing, /Optional: practice the patch/u);
  assert.match(
    landing,
    /class="button github" href="https:\/\/github\.com\/pascalkienast\/slopproof"/u,
  );
  assert.match(
    landing,
    /class="button primary" href="#closed-beta">Join the beta/u,
  );
  assert.doesNotMatch(landing, /closed beta/iu);
  assert.doesNotMatch(
    landing,
    /Small batches · manual admission · no newsletter/iu,
  );
  assert.match(landing, /id="closed-beta-form"/u);
  assert.match(landing, /name="email"[^>]*type="email"/u);
  assert.match(landing, /name="githubUsername"/u);
  assert.match(landing, /name="contactConsent"[^>]*required/u);
  assert.match(landing, /not added to a newsletter/u);
  assert.match(landing, /role="status" aria-live="polite"/u);
  assert.match(behavior, /fetch\("\/api\/public\/closed-beta"/u);
  assert.match(behavior, /response\.status === 202/u);
  assert.doesNotMatch(landing, /forms\.google|typeform/iu);
  assert.match(
    landing,
    /href="https:\/\/github\.com\/pascalkienast\/slopproof"[^>]*>Open source · Live on GitHub · 2026<\/a>/u,
  );
  assert.match(landing, /One continuous take\. The tab stays in front\./u);
  assert.match(
    landing,
    /Leave the tab, open another app, or use a second screen, and the proof aborts\./u,
  );
  assert.match(
    landing,
    /A multimodal model reviews the recording\. A maintainer can review it too\./u,
  );
  assert.doesNotMatch(
    landing,
    /A maintainer decides|The check stays with a human|cannot turn the GitHub check green/u,
  );
  assert.doesNotMatch(landing, /Open-source MVP|Open-source product concept/u);
  assert.doesNotMatch(landing, /15 sec|90 sec|open-proof|proof-dialog/u);
  assert.doesNotMatch(landing, /Preview mobile preflight/u);
  assert.doesNotMatch(landing, /visibility_lost/u);
  assert.doesNotMatch(behavior, /#open-proof|#proof-dialog|#demo-start/u);
  assert.doesNotMatch(landing, /fonts\.(?:googleapis|gstatic)\.com/u);
  assert.match(landing, /rel="icon" href="data:image\/svg\+xml/u);
  assert.match(behavior, /panel\.hidden = !selected/u);
  assert.match(behavior, /\[data-open-mode\]/u);
});

test("public product copy leads with the product benefit", () => {
  const readme = read("README.md");

  assert.match(read("apps/web/app/page.tsx"), /Open the local demo/u);
  assert.doesNotMatch(read("apps/web/app/page.tsx"), /Open the local MVP/u);
  assert.doesNotMatch(readme, /The MVP does not|Open the local MVP/u);
  assert.match(readme, /visibility_lost/u);
  assert.match(readme, /help\/no-help guarantee/u);
  assert.match(
    readme,
    /You cannot read\s+notes on a second screen while the take runs/u,
  );
  assert.match(
    readme,
    /SlopProof turns that understanding into a required GitHub check/u,
  );
  assert.match(readme, /patch-bound evidence\s+before merge/u);
  assert.doesNotMatch(
    readme,
    /does not try to detect AI-generated code|`GET \/`\s+is the static marketing page/u,
  );
  assert.match(readme, /## Product tour/u);
  assert.match(readme, /docs\/assets\/product-tour\/github-comment\.webp/u);
  assert.match(readme, /docs\/assets\/product-tour\/contributor-proof\.webp/u);
  assert.doesNotMatch(readme, /Screenshot slots, empty/u);
  assert.match(
    read("docs/operations/self-hosting.md"),
    /aborts as\s+`visibility_lost`/u,
  );
  assert.doesNotMatch(read("docs/operations/self-hosting.md"), /\bMVP\b/u);
  assert.doesNotMatch(
    read("docs/operations/production-deployment.md"),
    /\bMVP\b/u,
  );
});

test("production review chrome does not expose the local demo", () => {
  const reviewPage = read("apps/web/app/review/page.tsx");
  const revisionPage = read("apps/web/app/revisions/[revisionId]/page.tsx");

  assert.match(
    reviewPage,
    /demoMode \? \([\s\S]*?← Local demo[\s\S]*?\) : null/u,
  );
  assert.match(
    reviewPage,
    /Authorize with\s+GitHub to open the protected maintainer queue/u,
  );
  assert.match(reviewPage, /Choose the repository to review/u);
  assert.match(
    reviewPage,
    /returnTo=\$\{encodeURIComponent\("\/review"\)\}&repositoryId=\$\{encodeURIComponent\(repositoryId\)\}/u,
  );
  assert.match(
    revisionPage,
    /\/review\?repositoryId=\$\{encodeURIComponent\(revision\.repository_id\)\}/u,
  );
  assert.doesNotMatch(revisionPage, /href="\/review"/u);
  assert.doesNotMatch(reviewPage, /githubRepositoryId/u);
  assert.doesNotMatch(reviewPage, /The local MVP exposes a demo maintainer/u);
});

test("Caddy preserves mobile capture and strips private access-log fields", () => {
  const caddy = read("infra/caddy/Caddyfile.production");

  assert.match(
    caddy,
    /@mobile path \/m \/m\/\*[\s\S]*?>Permissions-Policy "camera=\(self\), microphone=\(self\), geolocation=\(\)"/u,
  );
  assert.match(
    caddy,
    /@non_mobile \{\s*not path \/m \/m\/\*\s*\}[\s\S]*?>Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)"/u,
  );
  for (const field of [
    "request>uri",
    "request>remote_ip",
    "request>client_ip",
    "request>headers",
    "resp_headers",
  ]) {
    assert.ok(caddy.includes(`${field} delete`), field);
  }
  assert.doesNotMatch(caddy, /request>headers>[A-Za-z]/u);
});

test("supply-chain workflow pins actions and fails high-risk image findings", () => {
  const workflow = read(".github/workflows/supply-chain.yml");
  const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map(
    (match) => match[1],
  );

  assert.ok(actionReferences.length >= 4);
  for (const reference of actionReferences) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/u);
  }
  assert.match(workflow, /fail-on-severity: high/u);
  assert.match(workflow, /format: spdx-json/u);
  assert.match(workflow, /version: v0\.73\.0/u);
  assert.match(workflow, /pnpm audit --prod --audit-level high/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /exit-code: "1"/u);
  assert.match(workflow, /severity: HIGH,CRITICAL/u);
});

test("the production application base image is pinned by multi-arch digest", () => {
  const dockerfile = read("Dockerfile");
  const stages = [
    ...dockerfile.matchAll(
      /^FROM node:24\.13\.0-bookworm-slim@sha256:([0-9a-f]{64}) AS (builder|runtime)$/gmu,
    ),
  ];

  assert.deepEqual(
    stages.map((match) => match[2]),
    ["builder", "runtime"],
  );
  assert.equal(stages[0]?.[1], stages[1]?.[1]);
});

test("production runbooks cover the irreversible operator boundaries", () => {
  const expected = [
    "docs/operations/production-deployment.md",
    "docs/operations/database-backup-restore.md",
    "docs/operations/key-rotation.md",
    "docs/operations/observability.md",
    "docs/security/threat-model.md",
    "docs/security/incident-response.md",
    "docs/privacy/provider-data-flow.md",
  ];
  const combined = expected.map((path) => read(path)).join("\n");

  assert.match(combined, /separate database/iu);
  assert.match(combined, /single active read key/iu);
  assert.match(combined, /never record row content/iu);
  assert.match(combined, /not a claim[\s\S]*zero-data retention/iu);
  assert.match(combined, /current-SHA/iu);
});

test("the backup reads the unpublished database and restores only into tmpfs", () => {
  const runbook = read("docs/operations/database-backup-restore.md");
  const workflow = read("scripts/production-backup/run-backup-rehearsal.sh");

  assert.match(workflow, /backup-compose[\s\S]*pg_dump/u);
  assert.match(workflow, /restore-start[\s\S]*restore-exec[\s\S]*pg_restore/u);
  assert.match(workflow, /restore-stop[\s\S]*restore-absent/u);
  assert.doesNotMatch(workflow, /\bcreatedb\b|\bdropdb\b/u);
  assert.match(workflow, /psql[\s\S]*--file=-/u);
  assert.match(
    runbook,
    /must therefore never be[\s\S]*redirected to a VM path/iu,
  );
  assert.match(
    runbook,
    /streams authenticated CMS decryption[\s\S]*directly into its `pg_restore`/u,
  );
});
