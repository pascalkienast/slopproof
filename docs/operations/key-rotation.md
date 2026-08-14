# Secret and key rotation

Stand: 2026-08-13

Rotation is a versioned deployment. Never overwrite the only readable key and
never regenerate all secrets as part of an ordinary release.

## Rotation classes

- **Session, OAuth client and webhook secrets:** deploy the new value to the
  exact owning process. Session rotation intentionally signs users out. Webhook
  rotation must be coordinated with the GitHub App so no signed delivery is
  accepted under an ambiguous boundary.
- **Worker internal secret:** rotate Web, Worker and the domain-separated Caddy
  proxy authenticator as one cutover. A partial rollout fails closed.
- **Provider and R2 credentials:** create a second bucket-scoped/provider-scoped
  credential, deploy it, verify bounded capability checks, then revoke the old
  credential. Never broaden bucket or model-provider permissions to simplify
  rotation.
- **GitHub App private key:** add and validate the replacement in GitHub first,
  deploy the protected PEM to GitHub Control, verify a repository-scoped token,
  then revoke the old key.
- **Database password:** create a new PostgreSQL credential, update every
  process-specific file consistently, recreate services, then remove the old
  credential. Do not put the password on the command line or in Compose.

## Cipher key constraints

`PROVIDER_PAYLOAD_KEY_BASE64` and the RSA wrapping private key currently have a
single active read key. They must not be rotated while undeleted ciphertext
depends on the old key.

Safe procedure:

1. Stop accepting new Practice, Proof and evidence uploads.
2. Allow active attempts to finish or invalidate them explicitly.
3. Run retention until recordings, frames, transcripts, semantic payloads,
   multimodal sidecars and wrapped keys using the old material are physically
   shredded. Verify with counts only.
4. Take and encrypt a final database backup under the separate backup key.
5. Install the new key set in a new protected directory, validate permissions
   and key shape, then recreate the owning services atomically.
6. Exercise only deterministic/local capability fixtures before reopening
   intake.

If uninterrupted rotation is required, first implement a versioned key ID and
dual-read/single-write period. Do not pretend the current single-key payload
format provides that compatibility.

## Compromise

For suspected compromise, follow
[incident-response.md](../security/incident-response.md).
Revoke network credentials first, block new private effects, preserve
evidence-free audit metadata, and accelerate deletion where policy and legal
requirements permit. Never download private evidence for convenience.
