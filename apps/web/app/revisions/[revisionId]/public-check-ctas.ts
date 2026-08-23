export type PublicCheckConclusion =
  "action_required" | "success" | "neutral" | "cancelled" | null;

export function publicCheckCtas(input: {
  isCurrent: boolean;
  conclusion: PublicCheckConclusion;
  hasAttempt: boolean;
  preparationAvailable: boolean;
}): { showContributor: boolean; showMaintainer: boolean } {
  return {
    showContributor:
      input.isCurrent &&
      input.preparationAvailable &&
      revisionRequiresUnderstanding(input.conclusion),
    showMaintainer: input.hasAttempt,
  };
}

function revisionRequiresUnderstanding(
  conclusion: PublicCheckConclusion,
): boolean {
  return conclusion !== "success" && conclusion !== "cancelled";
}
