# Incident response

Stand: 2026-08-13

## Severity

- **SEV-1:** suspected plaintext Evidence/provider payload disclosure, active
  private key compromise, unauthorized maintainer decision, public Evidence in
  checks/logs, or destructive loss of the only database.
- **SEV-2:** provider/R2/GitHub credential compromise without confirmed private
  disclosure, retention backlog beyond deadline, persistent lifecycle bypass,
  or production database unavailability.
- **SEV-3:** bounded provider/queue degradation, failed backup rehearsal,
  readiness failure or vulnerable dependency without known exploitation.

## First response

1. Name an incident lead and start an evidence-free timeline.
2. Stop new Proof/Practice/upload intake. Keep deletion and safe audit workers
   running unless they are the suspected compromised component.
3. Revoke the narrowest affected network credential. Do not rotate cipher keys
   blindly; doing so can make retained ciphertext undeletable/unreviewable.
4. If the Worker is suspect, isolate it, block provider and storage egress, and
   preserve memory/disk through the host incident procedure. Never copy media,
   transcript or frame content into tickets or chat.
5. Preserve logs, image digests, commit IDs, database audit rows and provider
   request IDs only when they are content-free. Do not enable verbose payload
   logging during the incident.
6. Accelerate retention for affected attempts when legally and operationally
   appropriate. Confirm physical object deletion and payload shredding by count.

## Investigation questions

- Which exact process, credential, repository binding and time window?
- Did lifecycle/current-SHA/retention fences hold at the database boundary?
- Was any public Check, HTTP response, log, metric, backup or provider request
  populated with private content?
- Did an external effect replay after a crash or ambiguous network response?
- Which encrypted artifacts depend on a possibly compromised key?
- Are GitHub, R2, Hetzner or OpenRouter incident/security contacts required?

## Recovery

- Deploy from a verified commit and image digest into a new release directory.
- Rotate according to [key-rotation.md](../operations/key-rotation.md), honoring
  dual-credential and old-cipher read constraints.
- Restore PostgreSQL only through the separate-database rehearsal in
  [database-backup-restore.md](../operations/database-backup-restore.md).
- Reconcile pending GitHub checks, queue work, retention and multipart orphans
  before reopening intake.
- Run value-free health, boundary, secret, retention and authorization smokes.

## Communication and learning

Follow applicable contractual and legal notification timelines; this runbook
does not replace counsel. Notify affected users with confirmed scope and avoid
including private artifacts. The post-incident review must produce a minimal
reproduction, invariant/test changes, credential timeline and deletion proof.
Do not retain Evidence beyond policy merely for a postmortem.
