import { describe, expect, it } from "vitest";
import { octokitCheckConclusionFields } from "./octokit-client";

describe("octokitCheckConclusionFields", () => {
  it("omits conclusion while the check is pending", () => {
    expect(octokitCheckConclusionFields(null)).toEqual({});
    expect(octokitCheckConclusionFields(null)).not.toHaveProperty("conclusion");
  });

  it("sends a conclusion only when completing the check", () => {
    expect(octokitCheckConclusionFields("neutral")).toEqual({
      conclusion: "neutral",
    });
    expect(octokitCheckConclusionFields("success")).toEqual({
      conclusion: "success",
    });
    expect(octokitCheckConclusionFields("action_required")).toEqual({
      conclusion: "action_required",
    });
  });
});
