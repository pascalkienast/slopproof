# GitHub App access gate

SlopProof can make its GitHub App publicly installable without admitting every
installation as a tenant. The current pre-1.0 gate is deliberately manual:
an operator admits a numeric GitHub user or organization account ID in
PostgreSQL before that account installs the App. Unknown installations remain
`pending` and cannot activate repositories, enqueue pull-request work, or mint
installation tokens.

This table is an admission gate, not a subscription or billing entitlement
system. Repository-specific product settings also do not belong here.

## Review the closed-beta queue

The public landing page writes an explicitly consented email address and
normalized GitHub login to `closed_beta_signups`. It does not activate an
account. Treat the email as personal data: inspect the queue only in the
protected operator session, never paste rows into tickets or logs, and do not
reuse the address for a newsletter.

```sql
SELECT id, github_username, email, created_at
  FROM closed_beta_signups
 WHERE status = 'pending'
 ORDER BY created_at, id
 LIMIT 25;
```

Resolve the chosen login through the authenticated GitHub CLI on the operator
machine. Compare the returned login before copying the immutable numeric ID:

```bash
gh api "users/<validated-github-login>" --jq '{id, login}'
```

Admit the exact signup and its numeric GitHub account ID atomically. Require
both statements to affect exactly one row; otherwise roll back and inspect the
queue again.

```sql
BEGIN;

INSERT INTO github_app_account_allowlist
  (github_account_id, status)
VALUES
  ('<numeric-github-account-id>', 'active')
ON CONFLICT (github_account_id) DO UPDATE SET
  status = 'active',
  updated_at = now();

UPDATE closed_beta_signups
   SET github_account_id = '<numeric-github-account-id>',
       status = 'admitted',
       decided_at = now(),
       updated_at = now()
 WHERE id = '<exact-signup-uuid>'
   AND github_username = '<validated-github-login>'
   AND status IN ('pending', 'contacted');

COMMIT;
```

The public response is deliberately identical for a new row, a duplicate, and
the form honeypot. Do not add a lookup endpoint: the admission queue must not
be enumerable. Mark rejected or withdrawn entries with the matching status and
`decided_at`, then delete personal contact data according to the deployment's
documented retention policy.

## Admit an account before installation

Use the immutable numeric GitHub account ID, not a mutable login. Run this only
through the operator's protected PostgreSQL session:

```sql
INSERT INTO github_app_account_allowlist
  (github_account_id, status)
VALUES
  ('<numeric-github-account-id>', 'active')
ON CONFLICT (github_account_id) DO UPDATE SET
  status = 'active',
  updated_at = now();
```

For a personal installation, admit that user's account ID. For an organization
installation, either admit the organization ID or admit the installing user's
ID before installation. GitHub includes the installer as the webhook sender,
so a pre-admitted user can activate an organization installation they are
authorized to create.

After the row is committed, let the user install the App and open a disposable
pull request. Do not manually create installation, repository, or pull-request
rows; signed GitHub deliveries and fresh repository reads own those bindings.

## Recover an installation that is already pending

The pending installation stores the target account, not a durable copy of the
webhook sender. Inspect the exact row first:

```sql
SELECT github_installation_id, account_id, account_login, status
  FROM installations
 WHERE github_installation_id = '<exact-installation-id>';
```

If the target account should be admitted, activate the account and that exact
pending installation atomically:

```sql
BEGIN;

INSERT INTO github_app_account_allowlist
  (github_account_id, status)
VALUES
  ('<exact-target-account-id>', 'active')
ON CONFLICT (github_account_id) DO UPDATE SET
  status = 'active',
  updated_at = now();

UPDATE installations
   SET status = 'active',
       suspended_at = NULL,
       removed_at = NULL,
       updated_at = now()
 WHERE github_installation_id = '<exact-installation-id>'
   AND account_id = '<exact-target-account-id>'
   AND status = 'pending';

COMMIT;
```

Require the `UPDATE` to affect exactly one row. A later signed lifecycle or
pull-request delivery performs the repository-scoped fresh read and binding.
If the pull request predates admission, push a new commit or reopen it after
activation so GitHub emits a fresh event.

## Removal and future entitlements

Setting an allowlist row to `inactive` blocks future admission but deliberately
does not demote an already-active installation. For immediate access removal,
suspend or uninstall the GitHub App installation and verify that SlopProof
invalidates its private flows.

A later account product may add billing, seats, repository settings, judge
strictness, and whether policy permits an automatic pass. Those are runtime
entitlements and repository policy. They must be enforced on every protected
operation rather than being inferred from this one-time installation gate.
