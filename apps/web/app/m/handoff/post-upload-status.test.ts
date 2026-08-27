import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostUploadStatusCard } from "./post-upload-status";

describe("mobile proof post-upload status", () => {
  it("confirms submission and explains where the contributor will see the result", () => {
    const html = renderToStaticMarkup(
      createElement(PostUploadStatusCard, {
        status: "processing",
        detail:
          "Your recording was uploaded successfully. SlopProof is checking your explanation now.",
      }),
    );

    expect(html).toContain("Proof submitted");
    expect(html).toContain("Your proof is in.");
    expect(html).toContain("uploaded successfully");
    expect(html).toContain("The result will appear on your pull request");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Validating before review");
    expect(html).not.toContain("private processing");
  });

  it("keeps maintainer review framed as a completed submission, not contributor action", () => {
    const html = renderToStaticMarkup(
      createElement(PostUploadStatusCard, {
        status: "review_required",
        detail:
          "Processing is complete. Your proof is waiting for a maintainer decision.",
      }),
    );

    expect(html).toContain("Proof submitted");
    expect(html).toContain("Your proof is in.");
    expect(html).toContain("waiting for a maintainer decision");
    expect(html).not.toContain("Review required");
  });

  it("shows an already-passed result instead of another waiting state", () => {
    const html = renderToStaticMarkup(
      createElement(PostUploadStatusCard, {
        status: "passed",
        detail: "This revision has been approved.",
      }),
    );

    expect(html).toContain("Proof complete");
    expect(html).toContain("Your proof passed.");
    expect(html).toContain("return to your pull request");
  });
});
