import { z } from "zod";

export const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const PatchFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0")),
    previousPath: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0"))
      .optional(),
    kind: z.enum(["text", "binary", "symlink"]),
    patch: z.string().optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.kind === "text" && file.patch === undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "Text files require bounded patch data",
      });
    }
    if (file.kind !== "text" && file.patch !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "Binary and symlink files are metadata-only inputs",
      });
    }
  });

export type PatchFile = z.infer<typeof PatchFileSchema>;

export const PullRequestPatchSchema = z
  .object({
    baseSha: GitShaSchema,
    headSha: GitShaSchema,
    files: z.array(PatchFileSchema).max(10_000),
  })
  .strict();

export type PullRequestPatch = z.infer<typeof PullRequestPatchSchema>;

export const AnalysisLimitsSchema = z
  .object({
    maximumFiles: z.number().int().min(1).max(2_000),
    maximumPatchBytes: z.number().int().min(1_024).max(20_000_000),
    maximumFilePatchBytes: z.number().int().min(512).max(2_000_000),
    maximumChangedLines: z.number().int().min(10).max(100_000),
    megaFileThreshold: z.number().int().min(10).max(2_000),
  })
  .strict();

export type AnalysisLimits = z.infer<typeof AnalysisLimitsSchema>;

export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  maximumFiles: 200,
  maximumPatchBytes: 1_000_000,
  maximumFilePatchBytes: 256_000,
  maximumChangedLines: 5_000,
  megaFileThreshold: 80,
}) satisfies AnalysisLimits;

export const DiffAnchorSchema = z
  .object({
    id: z.string().regex(/^a[0-9]+$/),
    file: z.string().min(1).max(1_024),
    hunkHeader: z.string().min(1).max(500),
    oldStart: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    changedLines: z.number().int().positive(),
    evidence: z.string().min(1).max(500),
  })
  .strict();

export type DiffAnchor = z.infer<typeof DiffAnchorSchema>;

export const ChangedAreaSchema = z
  .object({
    area: z.string().min(1).max(100),
    files: z.array(z.string().min(1).max(1_024)).min(1),
  })
  .strict();

export const BehavioralChangeSchema = z
  .object({
    kind: z.enum([
      "behavior",
      "api",
      "authentication",
      "authorization",
      "database",
      "migration",
      "concurrency",
      "configuration",
      "dependency",
      "test",
    ]),
    description: z.string().min(1).max(300),
    anchorId: z.string().regex(/^a[0-9]+$/),
  })
  .strict();

export const RiskSignalSchema = z
  .object({
    kind: z.enum([
      "authentication",
      "authorization",
      "migration",
      "concurrency",
      "public_api",
      "configuration",
      "dependency",
      "untested_behavior",
    ]),
    severity: z.enum(["low", "medium", "high"]),
    reason: z.string().min(1).max(300),
    anchorId: z.string().regex(/^a[0-9]+$/),
  })
  .strict();

export const TestSignalSchema = z
  .object({
    kind: z.enum(["tests_changed", "no_tests_changed"]),
    description: z.string().min(1).max(300),
    anchorId: z
      .string()
      .regex(/^a[0-9]+$/)
      .optional(),
  })
  .strict();

export const RiskLevelSchema = z.enum(["small", "medium", "high_risk", "mega"]);

export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskVectorSchema = z
  .object({
    scope: z.number().int().min(0).max(5),
    sensitiveSurface: z.number().int().min(0).max(5),
    migration: z.number().int().min(0).max(5),
    concurrency: z.number().int().min(0).max(5),
    testGap: z.number().int().min(0).max(3),
    unverifiable: z.number().int().min(0).max(5),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type RiskVector = z.infer<typeof RiskVectorSchema>;

export const AnalysisSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1"),
    analyzerVersion: z.literal("bounded-diff-v1"),
    baseSha: GitShaSchema,
    headSha: GitShaSchema,
    summary: z.string().min(1).max(500),
    riskLevel: RiskLevelSchema,
    riskVector: RiskVectorSchema,
    changedAreas: z.array(ChangedAreaSchema),
    behavioralChanges: z.array(BehavioralChangeSchema),
    risks: z.array(RiskSignalSchema),
    testSignals: z.array(TestSignalSchema),
    anchors: z.array(DiffAnchorSchema),
    generatedFiles: z.array(z.string().min(1).max(1_024)),
    lockfiles: z.array(z.string().min(1).max(1_024)),
    binaryFiles: z.array(z.string().min(1).max(1_024)),
    symlinks: z.array(z.string().min(1).max(1_024)),
    unusualPaths: z.array(z.string().min(1).max(1_024)),
    limitsHit: z.array(
      z.enum([
        "file_count",
        "total_patch_bytes",
        "file_patch_bytes",
        "changed_lines",
        "generated_patch_skipped",
      ]),
    ),
    analyzedFileCount: z.number().int().nonnegative(),
    nonGeneratedChangedLines: z.number().int().nonnegative(),
    generatedChangedLines: z.number().int().nonnegative(),
  })
  .strict();

export type AnalysisSnapshot = z.infer<typeof AnalysisSnapshotSchema>;
