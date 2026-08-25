/**
 * GitHub required status checks treat `queued` / `in_progress` as pending
 * (merge blocked) and treat `completed` + `neutral` as successful (merge
 * allowed). Waiting for a maintainer must therefore stay pending, while any
 * terminal state that still needs contributor action must be
 * `action_required`. SlopProof must never emit `neutral` for its required
 * understanding check.
 */
export const REVIEW_REQUIRED_GITHUB_CHECK = {
  status: "in_progress",
  conclusion: null,
} as const;

export const TECHNICAL_RETRY_GITHUB_CHECK = {
  status: "completed",
  conclusion: "action_required",
} as const;

export const ATTEMPT_EXPIRED_GITHUB_CHECK = {
  status: "completed",
  conclusion: "action_required",
} as const;

export type RequiredCheckStatus = "queued" | "in_progress" | "completed";
export type RequiredCheckConclusion =
  | "action_required"
  | "success"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "failure"
  | "timed_out"
  | "stale"
  | null;

export function requiredCheckSatisfiesMergeGate(
  status: RequiredCheckStatus,
  conclusion: RequiredCheckConclusion,
): boolean {
  if (status !== "completed" || conclusion === null) return false;
  return (
    conclusion === "success" ||
    conclusion === "neutral" ||
    conclusion === "skipped"
  );
}
