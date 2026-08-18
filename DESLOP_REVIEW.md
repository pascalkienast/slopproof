# SlopProof De-Slop Review — 2026-08-18

## Overview

This document reviews the codebase against the seven SlopProof review points from the 2026-08-12 plan. Each section identifies over-engineered complexity and proposes removals.

## 1. Semantic Fallback Cascades ⚠️ HIGH PRIORITY

### Finding: Practice/Proof/Learning generation has hardcoded template fallbacks

**Location:** `packages/questions/src/generative.ts`

- `deterministicLearningFallbackV1` (line 788-907): Generates hardcoded practice questions when provider fails
- `deterministicPracticeFeedbackFallbackV1` (line 909-954): Generates hardcoded feedback
- `deterministicProofFallbackV2` (line 956-1053): Generates hardcoded proof questions
- `makeLearningFallbackCollisionFree` (line 681-731): Synthetic text generation to avoid proof content collisions
- `makeFeedbackFallbackCollisionFree` (line 733-765): Same for feedback
- `collisionFreeFallbackText` (line 767-786): Helper for collision-free synthetic text

**Called from:** `apps/worker/src/semantic-generation.ts` in `invokeWithOneRepair` (lines 211-216, 268-273, 327-331)

**Problem:** When Hetzner or any LLM provider fails, the system silently shows generic template questions like "Explain the before-and-after behavior at the referenced changed hunk" instead of failing honestly. This simulates successful intelligence when the provider is down.

**Plan decision:** "SlopProof muss Fehler nicht um jeden Preis verstecken. Ein klarer, wiederholbarer Providerfehler ist ehrlicher als ein semantisch schwacher Ersatzpfad."

**Proposed change:**
- ❌ Remove all three `deterministic*Fallback` functions
- ❌ Remove `makeLearningFallbackCollisionFree`, `makeFeedbackFallbackCollisionFree`, `collisionFreeFallbackText`
- ✅ Throw a clear retryable error when provider fails
- ✅ Don't consume a proof attempt on technical provider failure

### Finding: Judge always falls back to "manual-review-projection" instead of failing

**Location:** `apps/worker/src/multimodal-judge-service.ts` (lines 113-119, 136-142) and `packages/providers/src/hetzner-multimodal.ts` (lines 635-640, 748-769)

**Problem:** When frames are unavailable or provider fails, the judge writes a fake "multimodal-compatibility-v1" result with `manualReviewRequired: true` instead of failing the evaluation attempt. This hides real provider failures behind a cosmetic "needs manual review" outcome.

**Plan decision:** "keine automatische Entscheidung bei ausgefallenem Judge"

**Proposed change:**
- ❌ Remove `manualReviewFallbackMultimodalJudgeResultV1` and `manualReviewFallbackCandidateV1`
- ✅ Throw a retryable error when provider fails or frames unavailable
- ✅ Keep the technical path for frames (it's a real availability check)

### Finding: `invokeWithOneRepair` always calls fallback on provider failure

**Location:** `apps/worker/src/semantic-generation.ts` (line 473)

**Problem:** The function accepts a `fallback()` callback and unconditionally calls it when the provider fails, setting `outcome: "fallback"` and `degraded: true`. This is the mechanism that triggers the semantic fallbacks.

**Proposed change:**
- ❌ Remove the `fallback` parameter from `invokeWithOneRepair`
- ✅ Throw a retryable provider error instead
- ✅ Preserve the technical retry logic for transport errors

### Finding: Generation outcome enum includes "fallback"

**Location:** `packages/questions/src/generative.ts` (line 202), schema definitions

**Problem:** The `generationOutcome` enum includes `"generated" | "repaired" | "fallback"`. This normalizes degraded fallback as a valid outcome.

**Proposed change:**
- ❌ Remove `"fallback"` from the enum, leaving only `"generated" | "repaired"`
- ✅ Update UI that checks for fallback state

## 2. Over-Abstractions ✅ ACCEPTABLE

**Finding:** Port/adapter patterns in GitHub production (`packages/github/src/production-ports.ts`) and provider interfaces appear justified for testing boundaries and secret isolation. No removal recommended.

## 3. Double Validation / Retry Logic ✅ MOSTLY ACCEPTABLE

**Finding:** The repair mechanism in `invokeWithOneRepair` is a legitimate semantic repair attempt (one retry with validation feedback). Technical transport retries are in the Hetzner providers. This is appropriate bounded retry logic, not fear-driven duplication.

**Exception:** If the repair fails, we currently fall back. After removing fallbacks, repair failure should throw.

## 4. Generic Template Questions ⚠️ COVERED BY #1

Already addressed in the semantic fallback section above.

## 5. Overlong Files / Unnecessary Adapters ⚠️ MINOR

**Finding:** 
- `packages/questions/src/generative.ts` is 1154 lines, but most are schemas and validators. The fallback functions (788-1053) are 265 lines of pure slop.
- After removing fallbacks, the file will be ~890 lines, which is acceptable.

**No additional changes** beyond fallback removal.

## 6. UI Texts Hiding Degradation ⚠️ MINOR

**Location:** `apps/web/app/revisions/[revisionId]/contribute/practice/practice-client.tsx` (line 259-260)

**Finding:** UI checks `view.learning.generationOutcome === "fallback"` and shows a "generation failed" message. This is actually honest, but will become unreachable after fallback removal.

**Proposed change:**
- ✅ Remove the fallback outcome check (dead code after main changes)
- ✅ Let the generation error surface naturally

## 7. Tests Conserving Self-Generated Complexity ⚠️ REQUIRES REVIEW

**Location:** Multiple test files use `deterministicLearningFallbackV1` etc. for fixtures.

**Finding:** Some tests use fallback functions to generate valid test data (e.g., `generative.test.ts`). This is acceptable fixture generation. Other tests explicitly test fallback behavior and should be updated or removed.

**Proposed change:**
- ✅ Keep tests that use fallbacks as **fixture generators** (they're just deterministic data builders)
- ❌ Remove tests that verify fallback **behavior** (we're deleting that behavior)
- ✅ Update integration tests that expect fallback outcomes

## Summary of Changes

### High-Confidence Removals
1. `deterministicLearningFallbackV1`, `deterministicPracticeFeedbackFallbackV1`, `deterministicProofFallbackV2`
2. `makeLearningFallbackCollisionFree`, `makeFeedbackFallbackCollisionFree`, `collisionFreeFallbackText`
3. `manualReviewFallbackMultimodalJudgeResultV1`, `manualReviewFallbackCandidateV1`
4. `fallback` parameter from `invokeWithOneRepair`
5. `"fallback"` from `generationOutcome` enum
6. UI code checking for fallback state

### Keep
- Technical retry logic (timeout, 429, 5xx, network)
- Security boundaries, encryption, retention
- DEMO_MODE and fake providers for offline development
- Test fixture usage of deterministic functions
- Repair mechanism (one semantic retry)

### Risk Assessment
- ✅ Low risk: Fallbacks never provided useful output, only cosmetic success
- ✅ Real errors will now be visible and retryable
- ✅ No security boundaries affected
- ✅ Demo mode unaffected (uses explicit fake providers)
