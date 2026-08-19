import { describe, expect, it } from "vitest";
import { publicCheckCtas } from "./public-check-ctas";

describe("public check CTAs", () => {
  it("shows contributor, not maintainer, on a fresh current understanding check", () => {
    expect(
      publicCheckCtas({
        isCurrent: true,
        conclusion: null,
        hasAttempt: false,
      }),
    ).toEqual({ showContributor: true, showMaintainer: false });
  });

  it("keeps contributor on a current understanding check after an attempt exists", () => {
    expect(
      publicCheckCtas({
        isCurrent: true,
        conclusion: "action_required",
        hasAttempt: true,
      }),
    ).toEqual({ showContributor: true, showMaintainer: true });
  });

  it("hides contributor on historical heads and shows maintainer only when an attempt exists", () => {
    expect(
      publicCheckCtas({
        isCurrent: false,
        conclusion: "neutral",
        hasAttempt: true,
      }),
    ).toEqual({ showContributor: false, showMaintainer: true });
    expect(
      publicCheckCtas({
        isCurrent: false,
        conclusion: null,
        hasAttempt: false,
      }),
    ).toEqual({ showContributor: false, showMaintainer: false });
  });

  it("hides contributor once understanding is confirmed or the check is cancelled", () => {
    expect(
      publicCheckCtas({
        isCurrent: true,
        conclusion: "success",
        hasAttempt: true,
      }),
    ).toEqual({ showContributor: false, showMaintainer: true });
    expect(
      publicCheckCtas({
        isCurrent: true,
        conclusion: "cancelled",
        hasAttempt: false,
      }),
    ).toEqual({ showContributor: false, showMaintainer: false });
  });
});
