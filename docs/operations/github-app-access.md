# GitHub App access gate

UnderstandProof can make its GitHub App publicly installable without admitting every
installation as a tenant. The current pre-1.0 gate is deliberately manual: a
user may install the App before or after requesting beta access, but an operator
must admit their immutable numeric GitHub account ID before UnderstandProof activates
the installation. Unknown installations remain `pending` and cannot activate
repositories, enqueue pull-request work, or mint installation tokens.

Migration `0020` stores the installation target account and, when GitHub sends
it, the immutable numeric ID of the user who created the installation. The
installer ID is set once and is not replaced by later lifecycle events. This
lets one admitted user recover both a personal installation and organization
installations they were authorized to create without asking for organization
names in the public form.

This table is an admission gate, not a subscription or billing entitlement
system. Repository-specific product settings also do not belong here.

## Review the beta queue

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

Admit the exact signup and its numeric GitHub account ID atomically. Require the
signup `UPDATE` to affect exactly one row; otherwise roll back and inspect the
queue again. The installation `UPDATE` may affect zero rows when the user has
not installed the App yet, or multiple rows when they installed it for a
personal account and one or more organizations.

```sql
BEGIN;

WITH admitted AS (
  UPDATE closed_beta_signups
     SET github_account_id = '<numeric-github-account-id>',
         status = 'admitted',
         decided_at = now(),
         updated_at = now()
   WHERE id = '<exact-signup-uuid>'
     AND github_username = '<validated-github-login>'
     AND status IN ('pending', 'contacted')
  RETURNING github_account_id
), allowlisted AS (
  INSERT INTO github_app_account_allowlist
    (github_account_id, status)
  SELECT github_account_id, 'active'
    FROM admitted
  ON CONFLICT (github_account_id) DO UPDATE SET
    status = 'active',
    updated_at = now()
  RETURNING github_account_id
), activated AS (
  UPDATE installations
     SET status = 'active',
         suspended_at = NULL,
         removed_at = NULL,
         updated_at = now()
   WHERE status = 'pending'
     AND EXISTS (
       SELECT 1
         FROM allowlisted
        WHERE installations.account_id = allowlisted.github_account_id
           OR installations.installer_account_id = allowlisted.github_account_id
     )
  RETURNING github_installation_id
)
SELECT (SELECT count(*) FROM admitted) AS admitted_signup_count,
       (SELECT count(*) FROM activated) AS activated_installation_count;

COMMIT;
```

The result must report `admitted_signup_count = 1`. If it reports zero, roll
back instead of committing. The CTE keeps the allowlist and installation
updates as no-ops when the exact signup does not match.

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

## Inspect or recover an installation that is already pending

Migration `0020` stores both the target account and the original installer when
GitHub supplies the sender. Inspect the exact row first:

```sql
SELECT github_installation_id, account_id, account_login,
       installer_account_id, status
  FROM installations
 WHERE github_installation_id = '<exact-installation-id>';
```

The normal beta-admission transaction above activates every pending personal or
organization installation tied to the admitted user. For a legacy row without
an installer ID, admit the exact target account and installation atomically:

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
suspend or uninstall the GitHub App installation and verify that UnderstandProof
invalidates its private flows.

A later account product may add billing, seats, repository settings, judge
strictness, and whether policy permits an automatic pass. Those are runtime
entitlements and repository policy. They must be enforced on every protected
operation rather than being inferred from this one-time installation gate.
