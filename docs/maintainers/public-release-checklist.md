# Public release checklist

## Source and legal

- [x] Add the `AGPL-3.0-or-later` license and repository metadata.
- [ ] Confirm every tracked source and asset may be redistributed under it.
- [x] Run `pnpm audit:secrets` and `pnpm audit:history-secrets` with the operator
      secret environment loaded so exact live values are checked.
- [x] Review large blobs and every historical path.
- [x] Publish the reviewed existing history. Its reachable patches and paths
      passed the secret audit; no history rewrite is planned.

Audit evidence from 2026-08-14: 451 working-tree files and 432 historical paths
passed the secret scanners, including an exact-value run with the hosted
operator environment loaded. The largest reachable blob is the archived
2.1 MB generated contact sheet; no release bundle, backup, credential or
evidence artifact is reachable from a Git ref.

## Repository surface

- [x] README describes the verified pre-1.0 state without stale claims.
- [x] CONTRIBUTING, SECURITY, SUPPORT, GOVERNANCE and Code of Conduct are present.
- [x] Issue forms, pull-request template, CODEOWNERS and Dependabot files are present.
- [x] CI actions and service images are pinned by full digest.
- [x] Private vulnerability reporting is enabled.
- [x] Repository description, homepage and topics are set.

Suggested metadata:

- Description: `A self-hosted GitHub accountability gate: understand the patch, explain it live, let a maintainer decide.`
- Homepage: `https://slopproof.paskie.me`
- Topics: `github-app`, `pull-requests`, `code-review`, `self-hosted`,
  `accountability`, `typescript`, `privacy`

## Publication and dogfood

- [x] Create `pascalkienast/slopproof` without auto-generated files.
- [ ] Push the reviewed release branch and confirm every workflow passes.
- [ ] Install the GitHub App on this repository only.
- [ ] Complete the bootstrap SlopProof pull request.
- [ ] Activate the main-branch ruleset with the App-bound check and PR-only
      break-glass actor.
- [ ] Complete a second pull request under the active ruleset.
- [ ] Tag `v0.1.0` only after both dogfood pull requests and retention pass.

Do not copy production secrets, encrypted backups, evidence or compiled process
files into a GitHub release.
