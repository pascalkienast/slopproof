import { describe, expect, it } from "vitest";
import { contributorPreparationState } from "./contributor-preparation-state";

describe("contributor preparation state", () => {
  it("shows ready only after a bounded question budget exists", () => {
    expect(
      contributorPreparationState({
        questionBudget: 4,
        checkStatus: "in_progress",
        checkConclusion: null,
        checkReason: "analysis_ready",
      }),
    ).toBe("ready");
  });

  it("shows a terminal system failure without turning it into a 404", () => {
    expect(
      contributorPreparationState({
        questionBudget: null,
        checkStatus: "completed",
        checkConclusion: "action_required",
        checkReason: "preparation_failed",
      }),
    ).toBe("failed");
  });

  it("keeps a revision without a budget in preparing", () => {
    expect(
      contributorPreparationState({
        questionBudget: null,
        checkStatus: "in_progress",
        checkConclusion: null,
        checkReason: "webhook_ingested",
      }),
    ).toBe("preparing");
  });
});
