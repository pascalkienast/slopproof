# PostgreSQL backup and restore

Stand: 2026-08-13

Backups contain private repository metadata, encrypted evidence artifacts and
wrapped keys. Treat them as confidential even though media and provider payloads
are ciphertext.

## Backup

1. Create a new mode-0700 directory on an encrypted host filesystem. Resolve an
   explicit filename; never target `/`, `$HOME`, the repository or a glob.
2. Record the application commit, image digest and migration list separately.
3. Create a custom-format dump through the internal PostgreSQL service:

   ```bash
   umask 077
   docker compose -f compose.production.yaml exec -T postgres \
     pg_dump --username=slopproof --dbname=slopproof \
     --format=custom --no-owner --no-acl > /absolute/backup/slopproof.dump
   docker compose -f compose.production.yaml exec -T postgres \
     pg_restore --list < /absolute/backup/slopproof.dump \
     > /absolute/backup/slopproof.list
   sha256sum /absolute/backup/slopproof.dump > /absolute/backup/slopproof.dump.sha256
   ```

4. Encrypt the dump with the operator's approved offline backup key before it
   leaves the host. The backup key must not be a SlopProof runtime secret.
5. Retain neither shell history containing credentials nor unencrypted scratch
   copies. Do not log table rows or dump contents.

## Restore rehearsal

A successful `pg_dump` exit alone is not evidence of recoverability.

1. From the exact deployed release directory, choose a unique explicit
   rehearsal name matching `^slopproof_restore_[0-9]{8}_[0-9]{6}$`. Require
   the production PostgreSQL service to be healthy. PostgreSQL deliberately
   has no host port, so every database command must execute inside that
   service.
2. Restore into that database only:

   ```bash
   docker compose -f compose.production.yaml exec -T postgres \
     createdb --username=slopproof slopproof_restore_YYYYMMDD_HHMMSS
   docker compose -f compose.production.yaml exec -T postgres \
     pg_restore --username=slopproof --exit-on-error --single-transaction \
       --no-owner --no-acl --dbname=slopproof_restore_YYYYMMDD_HHMMSS \
     < /absolute/backup/slopproof.dump
   ```

3. Run migration idempotence, schema constraints, value-free health and a
   read-only count/invariant audit. Do not start Worker, providers or GitHub
   Control against the rehearsal database.
4. Verify encrypted artifacts remain encrypted and retention deadlines remain
   present. Do not decrypt evidence to test the backup.
5. Drop only the explicitly created rehearsal database through the same
   unpublished service and verify it is absent:

   ```bash
   docker compose -f compose.production.yaml exec -T postgres \
     dropdb --username=slopproof slopproof_restore_YYYYMMDD_HHMMSS
   docker compose -f compose.production.yaml exec -T postgres \
     psql --username=slopproof --dbname=slopproof --tuples-only \
       --command="SELECT count(*) FROM pg_database WHERE datname = 'slopproof_restore_YYYYMMDD_HHMMSS'"
   ```

   The final count must be zero. Never interpolate an unchecked name into
   these commands.

Record date, dump hash, PostgreSQL version, restore duration and invariant
result. Never record row content, repository identity, SHA, author or evidence
identifiers.

## Disaster restore

- Stop new Web intake and all effect workers first.
- Preserve the failed database read-only for investigation.
- Restore into a new database/volume, validate, then atomically change the
  protected process files and recreate services.
- Reconcile queue/check/outbox state before accepting traffic. Idempotent jobs
  may replay; external provider and GitHub effects must use their persisted
  recovery paths.
- Run retention immediately. A restore never extends `delete_after`.

## Verified rehearsal

On 2026-08-13, Gate 7 exercised this procedure against two newly created,
explicitly named disposable local PostgreSQL 18.4 databases after migrations
0000–0015. `pg_dump --format=custom --no-owner --no-acl`, `pg_restore --list`
and `pg_restore --exit-on-error --single-transaction` all succeeded. The dump
SHA-256 was
`0b2f7ac997fbf620485e9e86a25fef1ab1b024607892ed392b6857d3acda3aa8`.
Source and restore both reported 16 migration rows, 43 public/pg-boss tables,
621 constraints and 80 triggers; migration idempotence on the restored target
also passed. The dump and both disposable databases were then deleted and
their absence was confirmed. This empty-fixture rehearsal proves the schema
and procedure, not recovery of live production evidence; production still
requires a scheduled encrypted backup and restore rehearsal after deployment.
