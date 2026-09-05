# Security policy

## Supported versions

UnderstandProof is pre-1.0. Security fixes target the current `main` branch and the
hosted instance. Older commits and development branches are unsupported.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** form in the Security tab. This opens a
private security advisory with the maintainers.

If private vulnerability reporting is unavailable, open a public issue that
asks for a private contact channel. Include no exploit details, credentials,
repository content, evidence, transcripts, frames, private URLs or personal
data in that issue.

Provide these details privately when possible:

- affected commit, route, process or protocol version;
- prerequisites and impact;
- a minimal reproduction without private user material;
- whether a credential, active attempt or retained artifact may be exposed;
- any deadline before planned disclosure.

The maintainer will acknowledge a complete report, establish a private repair
channel and coordinate disclosure. Response times are best effort while the
project remains pre-1.0.

## Scope

The project welcomes reports about authorization, SHA binding, retention,
cryptography use, provider isolation, webhook/OAuth handling, storage access,
queue replay, log leakage, deployment boundaries and supply-chain integrity.

Provider privacy terms, operator policy mistakes and attacks that require full
control of both the Worker host and its active private keys may fall outside the
product's technical guarantees. See the
[threat model](docs/security/threat-model.md) for the exact boundaries.

Do not test against the hosted service with another person's repository or
evidence. Use the local fake-adapter profile for research.
