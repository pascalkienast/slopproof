export type ContributorPreparationState = "preparing" | "ready" | "failed";

export function contributorPreparationState(input: {
  questionBudget: number | null;
  checkStatus: "queued" | "in_progress" | "completed";
  checkConclusion:
    "action_required" | "success" | "neutral" | "cancelled" | null;
  checkReason: string | null;
}): ContributorPreparationState {
  if (
    Number.isInteger(input.questionBudget) &&
    input.questionBudget !== null &&
    input.questionBudget >= 1 &&
    input.questionBudget <= 5
  ) {
    return "ready";
  }
  if (
    input.checkStatus === "completed" &&
    input.checkConclusion === "action_required" &&
    input.checkReason === "preparation_failed"
  ) {
    return "failed";
  }
  return "preparing";
}
