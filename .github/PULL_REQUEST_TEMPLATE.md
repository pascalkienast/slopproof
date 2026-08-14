## Change

Describe the behavior changed by this pull request.

## Failure mode

What can fail, and how does the change fail closed?

## Verification

- [ ] Unit or contract tests
- [ ] PostgreSQL integration tests when state or concurrency changed
- [ ] Playwright coverage when a user flow changed
- [ ] Threat model or provider data-flow update when a boundary changed
- [ ] `pnpm audit:secrets`
- [ ] No credentials, private repository data or evidence artifacts included

## Privacy and public output

List any new stored field, provider field, log field, metric label, HTTP route,
GitHub permission or Check output. Write `none` when the patch adds none.
