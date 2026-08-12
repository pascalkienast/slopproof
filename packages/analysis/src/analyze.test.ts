import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generatedOutputChange,
  highRiskAuthMigrationChange,
  mediumMultiComponentChange,
  megaUnreviewableChange,
  smallLocalFix,
} from "./__fixtures__/synthetic-diffs";
import {
  AnalysisSnapshotSchema,
  PullRequestPatchSchema,
  analyzePullRequestPatch,
} from "./index";

describe("bounded deterministic patch analysis", () => {
  it("classifies a small local behavior fix and anchors every claim", () => {
    const first = analyzePullRequestPatch(smallLocalFix);
    const second = analyzePullRequestPatch(smallLocalFix);

    expect(first).toEqual(second);
    expect(first.riskLevel).toBe("small");
    expect(first.anchors).toHaveLength(1);
    expect(first.behavioralChanges).toEqual([
      expect.objectContaining({ anchorId: "a0", kind: "behavior" }),
    ]);
    expect(first.risks.every((risk) => risk.anchorId.startsWith("a"))).toBe(
      true,
    );
  });

  it("classifies a multi-component patch as medium and detects tests", () => {
    const snapshot = analyzePullRequestPatch(mediumMultiComponentChange);

    expect(snapshot.riskLevel).toBe("medium");
    expect(snapshot.changedAreas.map((area) => area.area)).toEqual([
      "apps",
      "packages",
    ]);
    expect(snapshot.testSignals).toContainEqual(
      expect.objectContaining({ kind: "tests_changed" }),
    );
  });

  it("classifies auth, migration and concurrency evidence as high risk", () => {
    const snapshot = analyzePullRequestPatch(highRiskAuthMigrationChange);

    expect(snapshot.riskLevel).toBe("high_risk");
    expect(snapshot.risks.map((risk) => risk.kind)).toEqual(
      expect.arrayContaining([
        "authentication",
        "authorization",
        "migration",
        "concurrency",
      ]),
    );
    expect(snapshot.riskVector.migration).toBe(5);
    expect(snapshot.riskVector.concurrency).toBe(5);
  });

  it("does not let 10,000 generated lines inflate the proof risk", () => {
    const snapshot = analyzePullRequestPatch(generatedOutputChange);

    expect(snapshot.generatedFiles).toEqual([
      "src/generated/colors.generated.ts",
    ]);
    expect(snapshot.generatedChangedLines).toBe(10_000);
    expect(snapshot.nonGeneratedChangedLines).toBe(2);
    expect(snapshot.riskLevel).toBe("small");
    expect(snapshot.limitsHit).toContain("generated_patch_skipped");
  });

  it("marks an unreviewable mega patch for split without reading beyond limits", () => {
    const snapshot = analyzePullRequestPatch(megaUnreviewableChange, {
      maximumFiles: 50,
      maximumPatchBytes: 1_000_000,
      maximumFilePatchBytes: 256_000,
      maximumChangedLines: 5_000,
      megaFileThreshold: 40,
    });

    expect(snapshot.riskLevel).toBe("mega");
    expect(snapshot.analyzedFileCount).toBe(50);
    expect(snapshot.limitsHit).toContain("file_count");
    expect(snapshot.summary).toContain("split or narrow");
  });

  it("marks binary, symlink, lockfile and hostile-looking path metadata as data", () => {
    const snapshot = analyzePullRequestPatch({
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      files: [
        {
          path: "assets/demo.bin",
          kind: "binary",
          additions: 0,
          deletions: 0,
        },
        {
          path: "../outside-link",
          kind: "symlink",
          additions: 1,
          deletions: 1,
        },
        {
          path: "pnpm-lock.yaml",
          kind: "text",
          additions: 2,
          deletions: 2,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });

    expect(snapshot.binaryFiles).toEqual(["assets/demo.bin"]);
    expect(snapshot.symlinks).toEqual(["../outside-link"]);
    expect(snapshot.lockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(snapshot.unusualPaths).toEqual(["../outside-link"]);
    expect(snapshot.anchors).toEqual([]);
  });

  it("uses strict Zod schemas at input and snapshot boundaries", () => {
    expect(() =>
      PullRequestPatchSchema.parse({
        ...smallLocalFix,
        checkoutCommand: "npm test",
      }),
    ).toThrow(z.ZodError);

    const snapshot = analyzePullRequestPatch(smallLocalFix);
    expect(() =>
      AnalysisSnapshotSchema.parse({ ...snapshot, hiddenScore: 0.9 }),
    ).toThrow(z.ZodError);
  });
});
