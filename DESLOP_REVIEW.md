# SlopProof de-slop review — 2026-08-18

This is the architecture review that preceded the implementation. It maps
the 2026-08-12 plan onto this checkout and records what was cut versus
what was left as a real safety or demo boundary.

## What was actually over-engineered

### 1. Semantic fallback cascades (review points 1, 4, 6)

`invokeWithOneRepair` always called a deterministic template builder after
a timeout, 429/5xx, network error, or a failed one-shot repair:

- `deterministicLearningFallbackV1`
- `deterministicPracticeFeedbackFallbackV1`
- `deterministicProofFallbackV2`

Practice already withheld stored `generation_outcome = 'fallback'` rows
and showed `generation_failed`. Proof did not. An unavailable proof
provider still froze template questions and created a live Attempt. That
matches the 2026-08-14 Hetzner-400 example: cosmetic success instead of
an honest retryable failure.

### 2. Judge swallowing provider failure (review points 1, 6)

`runMultimodalJudgeEvaluation` converted provider errors, bad hashes, and
frame-loader failures into a synthetic `not_evaluable` candidate. The
pipeline then wrote a `manual-review-projection` /
`multimodal-compatibility-v1` bundle as if the judge had completed. Gate 5
already has a fail-closed path (`technical_retry` or `manual_review`) for
thrown `ProviderError`s. The fallback prevented that path from running.

## What is a real boundary and was left alone

- Technical transport retries inside Hetzner providers (timeout / 429 /
  5xx / network), then a safe public error.
- One semantic repair attempt with a validation code. Repair stays.
- Secrets and raw provider bodies stay private.
- Encrypted recording, SHA binding, retention, and production-profile
  fail-closed config.
- `DEMO_MODE` / local-fake providers. Those are the offline golden path,
  not a hidden fallback after a live provider dies.
- `deterministic*FallbackV1/V2` remain exported as **test/demo fixtures**.
  Production generation no longer calls them.
- Empty-frame judge path still writes an authoritative `not_evaluable`
  review. Skipping vision when no frame exists is a product decision and
  is required for the local empty-frame adapter. Documented, not guessed.
- `createConservativeCompatibilityEvaluationBundle` still projects a
  Gate-5 compatibility evaluation from a **successful** Gate-6 sidecar.
  That is the persisted review contract, not a semantic fallback.

## What this change does

| Change                                                                                                         | Review point | Why                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| Generation throws `SemanticGenerationFailedError` after bounded retries instead of building template artifacts | 1, 4         | Honest failure; no fake intelligence                            |
| Failed Learning/Feedback runs persist metadata only (`artifact_id` null, `degraded`)                           | 1, 6         | Practice can show `generation_failed` without storing templates |
| Failed Proof runs persist no plan and create no Attempt                                                        | 1            | Technical provider failure must not consume a Proof try         |
| Persistence refuses `generationOutcome = fallback` artifacts                                                   | 1, 3         | Defense in depth if a caller regresses                          |
| Judge throws on provider / frame-load / invalid-output failure                                                 | 1, 6         | Fail closed to `technical_retry` or maintainer review           |
| Tests that only conserved the fallback cascade now assert the fail-closed invariant                            | 7            | Keep invariant tests; drop template-success expectations        |

## Ambiguous cuts left in the PR notes, not guessed

- Empty-frame → `not_evaluable` review (see above).
- Invocation metadata still uses `outcome: "fallback"` for “no accepted
  provider output” so historical rows and the versioned schema stay
  readable. New artifacts are never written with that outcome.
- Historical Learning rows with `generation_outcome = 'fallback'` remain
  withheld by the repository and by the Practice UI.
