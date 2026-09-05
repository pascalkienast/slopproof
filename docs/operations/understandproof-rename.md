# UnderstandProof rename and compatibility

UnderstandProof is the new name of SlopProof, not a separate service or installation.
The repository is now <https://github.com/pascalkienast/understandproof>. The brand core is **Proof of Understanding**. The first application is code;
texts and other media are a longer-term direction, not new supported inputs
in this release.
The proof supplies evidence for review, not a guarantee of understanding or
code quality.

## Changed in this release

- Product name, landing wordmark, metadata, interface copy, GitHub comment
  heading, support/security links, and documentation.
- Root package name `understandproof`, private workspace packages `@understandproof/*`, their
  imports, build filters, Next.js transpilation list, and lockfile links.
- The exported database type is `UnderstandProofDatabase`.
- The repository mark is `understandproof-mark.svg`; its artwork is unchanged.

Existing clones should update their remote:

```bash
git remote set-url origin https://github.com/pascalkienast/understandproof.git
pnpm install --frozen-lockfile
```

Do not create a new repository at `pascalkienast/slopproof`: that would replace
GitHub's redirect. GitHub does not redirect `uses: owner/repo/...` calls to an
action hosted by a renamed repository; update such consumers explicitly if
any are introduced or discovered. See [GitHub's rename documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

## Intentionally stable interfaces

Do not globally replace every occurrence of `slopproof`. These are live
compatibility contracts rather than the public brand:

- **Hosted origin and App:** `https://slopproof.paskie.me` and
  `https://github.com/apps/slopproof` remain the working service and install
  URLs. This release does not rename the registered GitHub App, change its
  numeric identity, create a replacement App, or alter OAuth/webhook settings.
- **Merge gate:** `SlopProof / understanding required` remains the exact check
  name emitted by the application, stored in check rows, and required by
  existing repository rulesets. The display name is deliberately not changed
  independently of the rulesets. Check messages and PR comment copy can use
  UnderstandProof while this gate remains stable.
- **Repository policy:** `.slopproof.yml` remains the authoritative policy
  filename. No new filename or ambiguous dual-policy precedence is introduced.
- **Authentication and protocol:** `slopproof_session`, other existing cookies,
  token issuers/audiences, `X-SlopProof-*` proxy headers, internal headers,
  cryptographic `slopproof:*` associated-data prefixes, and recording protocol
  identifiers remain unchanged. Existing encrypted records and golden vectors
  must continue to decrypt and validate.
- **Persistence and idempotency:** database names/roles, SQL migrations,
  deterministic-ID namespaces, object-storage names/prefixes, and the hidden
  PR-comment marker `<!-- slopproof:understanding-check -->` stay unchanged.
  Existing comments are updated in place, not duplicated under a new marker.
- **Versioned provider behavior:** the existing semantic prompt's historical
  name is retained. A branding release does not silently revise a versioned
  model prompt or re-evaluate existing evidence.
- **Operations:** `SLOPPROOF_*` variables, Compose project/volume names,
  systemd unit filenames, `/opt/slopproof`, `/etc/slopproof`, static landing
  paths, image tags, `.slopproof-*` manifests, receipt schemas, and
  `SlopProof-Backups` paths remain compatible with existing releases and backup
  verification. Their explanatory text can use UnderstandProof.
- **Historical screenshots:** manually selected product-tour WebPs are
  unchanged. Their captions/alt text still accurately describe the earlier
  SlopProof interface. Replace them only with newly approved captures.

No database migration, re-encryption, data move, infrastructure rename, or
change to proof policy is required by this release. A repository merge alone
does not deploy the renamed interface or static landing page.

## Release and follow-up checks

1. Run the normal verification/build and production release workflow. Publish
   the generated landing assets along with the application using the existing
   [deployment runbook](production-deployment.md).
2. On the renamed repository, verify a fresh signed PR delivery against its
   numeric repository ID and new owner/name. Confirm the existing installation
   binds to it, updates the persisted repository name, and creates the normal
   revision-bound comment/check. Do not insert replacement repository rows or
   disable the gate to work around a stale binding.
3. Verify contributor OAuth, mobile handoff, maintainer review, and the exact
   required-check name on a fresh attempt. Existing sessions and pending
   installations must retain their behavior.
4. If the registered App is later renamed, preserve its identity/installations,
   verify the new installation URL, and update links only after it works.
5. Treat a future origin or required-check rename as a coordinated migration.
   An origin move needs DNS/TLS, OAuth/webhook URLs, storage CORS, browser-origin
   checks, and old-link handling verified together. A check rename needs the
   emitter and consuming rulesets transitioned without a missing or fail-open
   required gate. Neither migration is performed by this PR.
