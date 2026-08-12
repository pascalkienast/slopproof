import { createHash } from "node:crypto";
import { z } from "zod";
import { analyzePullRequestPatch } from "./analyze";
import {
  AnalysisSnapshotSchema,
  GitShaSchema,
  PullRequestPatchSchema,
  type AnalysisSnapshot,
  type PullRequestPatch,
} from "./schema";

const textEncoder = new TextEncoder();
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/u;
const AnchorIdSchema = z
  .string()
  .max(4)
  .regex(/^a(?:0|[1-9][0-9]{0,2})$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const UuidSchema = z.string().uuid();

const GENERATED_PATH_PATTERNS = [
  /(?:^|\/)dist\//iu,
  /(?:^|\/)build\//iu,
  /(?:^|\/)generated\//iu,
  /(?:^|\/)__generated__(?:\/|$)/iu,
  /(?:^|\/)vendor\//iu,
  /\.generated\./iu,
  /\.gen\.[^/]+$/iu,
  /\.g\.dart$/iu,
  /\.pb\.(?:go|cc|h|py|ts)$/iu,
  /_generated\.go$/iu,
  /\.min\.(?:js|css)$/iu,
  /(?:^|\/)coverage\//iu,
];

const LOCKFILE_PATH_PATTERNS = [
  /(?:^|\/)package-lock\.json$/u,
  /(?:^|\/)pnpm-lock\.yaml$/u,
  /(?:^|\/)yarn\.lock$/u,
  /(?:^|\/)bun\.lockb?$/u,
  /(?:^|\/)Cargo\.lock$/u,
  /(?:^|\/)poetry\.lock$/u,
  /(?:^|\/)Gemfile\.lock$/u,
  /(?:^|\/)composer\.lock$/u,
  /(?:^|\/)Pipfile\.lock$/u,
  /(?:^|\/)uv\.lock$/u,
  /(?:^|\/)flake\.lock$/u,
  /(?:^|\/)pubspec\.lock$/u,
  /(?:^|\/)packages\.lock\.json$/u,
  /(?:^|\/)gradle\.lockfile$/u,
  /(?:^|\/)gradle\/dependency-locks\/[^/]+\.lockfile$/u,
  /(?:^|\/)go\.sum$/u,
];

const ARCHIVE_PATH_PATTERN =
  /\.(?:7z|a|apk|bz2|cab|dmg|ear|egg|gz|iso|jar|rar|rpm|tar|tbz2|tgz|txz|war|whl|xz|zip)$/iu;
const LFS_POINTER_PATTERN =
  /(?:^|\n)[ +\-]?version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/u;
const SUBMODULE_PATCH_PATTERN =
  /(?:^|\n)[+-]Subproject commit [a-f0-9]{40,64}(?:-dirty)?(?:\n|$)/u;

export const GithubChangedFileV1Schema = z
  .object({
    sha: GitShaSchema.nullable(),
    filename: z.string().min(1).max(1_024),
    previousFilename: z.string().min(1).max(1_024).nullable(),
    status: z.enum([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
    ]),
    additions: z.number().int().nonnegative().safe(),
    deletions: z.number().int().nonnegative().safe(),
    changes: z.number().int().nonnegative().safe(),
    patch: z
      .string()
      .max(128 * 1_024)
      .nullable(),
    gitKind: z.enum(["blob", "symlink", "submodule"]),
  })
  .strict();

/** Exact projection of the immutable github_revision_sources.source contract. */
export const GithubRevisionSourceV1Schema = z
  .object({
    githubPullRequestId: z.string().regex(/^[1-9][0-9]{0,15}$/u),
    number: z.number().int().positive().max(2_147_483_647),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    title: z.string().max(4_096),
    body: z.string().max(65_536).nullable(),
    authorId: z.string().regex(/^[1-9][0-9]{0,15}$/u),
    authorLogin: z.string().min(1).max(100),
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    changedFiles: z.number().int().nonnegative().safe(),
    isFork: z.boolean(),
    files: z.array(GithubChangedFileV1Schema).max(300),
    limitsHit: z
      .object({
        files: z.boolean(),
        patchBytes: z.boolean(),
        patchUnavailable: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    const patchBytes = source.files.reduce(
      (total, file) => total + utf8Bytes(file.patch ?? ""),
      0,
    );
    const oversizedFile = source.files.some(
      (file) => utf8Bytes(file.patch ?? "") > 128 * 1_024,
    );
    if (patchBytes > 2 * 1_024 * 1_024 || oversizedFile) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "total patch data exceeds 2 MiB",
      });
    }
    const expectedFiles = Math.min(source.changedFiles, 300);
    const filesTruncated = source.changedFiles > 300;
    const missingPatch = source.files.some((file) => file.patch === null);
    if (
      source.files.length !== expectedFiles ||
      source.limitsHit.files !== filesTruncated ||
      (source.limitsHit.patchUnavailable || source.limitsHit.patchBytes) !==
        missingPatch
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitsHit"],
        message: "source truncation flags require exact bounded evidence",
      });
    }
  });

export type GithubRevisionSourceV1 = z.infer<
  typeof GithubRevisionSourceV1Schema
>;

export const GenerationContextLimitsV1Schema = z
  .object({
    maximumFiles: z.number().int().min(1).max(120),
    maximumHunks: z.number().int().min(1).max(400),
    maximumTotalBytes: z
      .number()
      .int()
      .min(1_024)
      .max(512 * 1_024),
    maximumFileBytes: z
      .number()
      .int()
      .min(512)
      .max(64 * 1_024),
    maximumTitleBytes: z
      .number()
      .int()
      .min(64)
      .max(2 * 1_024),
    maximumBodyBytes: z
      .number()
      .int()
      .min(128)
      .max(16 * 1_024),
    maximumExcerpts: z.number().int().min(0).max(12),
    maximumExcerptBytes: z.number().int().min(128).max(4_096),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maximumFileBytes > limits.maximumTotalBytes) {
      context.addIssue({
        code: "custom",
        path: ["maximumFileBytes"],
        message: "file bytes cannot exceed total bytes",
      });
    }
    if (limits.maximumExcerptBytes > limits.maximumTotalBytes) {
      context.addIssue({
        code: "custom",
        path: ["maximumExcerptBytes"],
        message: "excerpt bytes cannot exceed total bytes",
      });
    }
    if (limits.maximumTitleBytes > limits.maximumTotalBytes) {
      context.addIssue({
        code: "custom",
        path: ["maximumTitleBytes"],
        message: "title bytes cannot exceed total bytes",
      });
    }
    if (limits.maximumBodyBytes > limits.maximumTotalBytes) {
      context.addIssue({
        code: "custom",
        path: ["maximumBodyBytes"],
        message: "body bytes cannot exceed total bytes",
      });
    }
  });

export type GenerationContextLimitsV1 = z.infer<
  typeof GenerationContextLimitsV1Schema
>;

export const DEFAULT_GENERATION_CONTEXT_LIMITS_V1 = Object.freeze({
  maximumFiles: 120,
  maximumHunks: 400,
  maximumTotalBytes: 512 * 1_024,
  maximumFileBytes: 64 * 1_024,
  maximumTitleBytes: 2 * 1_024,
  maximumBodyBytes: 16 * 1_024,
  maximumExcerpts: 12,
  maximumExcerptBytes: 4 * 1_024,
}) satisfies GenerationContextLimitsV1;

export const GenerationContextLimitHitV1Schema = z.enum([
  "source_file_count",
  "source_patch_bytes",
  "source_patch_unavailable",
  "file_count",
  "hunk_count",
  "total_bytes",
  "file_bytes",
  "title_bytes",
  "body_bytes",
  "excerpt_count",
  "excerpt_bytes",
]);

export const GenerationContextExclusionReasonV1Schema = z.enum([
  "file_count",
  "hunk_count",
  "total_bytes",
  "file_bytes",
  "patch_unavailable",
  "archive",
  "lfs_pointer",
  "submodule",
  "symlink",
  "generated",
  "lockfile",
  "unusual_path",
  "malformed_patch",
  "excerpt_not_changed_text",
  "excerpt_count",
  "excerpt_bytes",
]);

export const GenerationContextExclusionV1Schema = z
  .object({
    path: z.string().min(1).max(1_024).optional(),
    reason: GenerationContextExclusionReasonV1Schema,
  })
  .strict();

export type GenerationContextExclusionV1 = z.infer<
  typeof GenerationContextExclusionV1Schema
>;

const BoundedRevisionFileV1Schema = z
  .object({
    path: z.string().min(1).max(1_024),
    previousPath: z.string().min(1).max(1_024).optional(),
    status: GithubChangedFileV1Schema.shape.status,
    kind: z.enum(["text", "binary"]),
    patch: z.string().optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    sourceAdditions: z.number().int().nonnegative(),
    sourceDeletions: z.number().int().nonnegative(),
    includedHunks: z.number().int().nonnegative(),
    testFile: z.boolean(),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.kind === "text" && file.patch === undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "bounded text files require patch data",
      });
    }
    if (file.kind === "binary" && file.patch !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "metadata-only files cannot contain patch data",
      });
    }
  });

export const BoundedRevisionSourceV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    sourceVersion: z.literal("github-revision-source-bounded-v1"),
    sourceHash: Sha256Schema,
    baseSha: GitShaSchema,
    headSha: GitShaSchema,
    title: z.string().max(4_096),
    body: z.string().max(65_536).nullable(),
    files: z.array(BoundedRevisionFileV1Schema).max(120),
    deterministicTestFiles: z.array(z.string().min(1).max(1_024)).max(120),
    limits: GenerationContextLimitsV1Schema,
    limitsHit: z.array(GenerationContextLimitHitV1Schema).max(20),
    exclusions: z.array(GenerationContextExclusionV1Schema).max(600),
    usage: z
      .object({
        sourceFiles: z.number().int().nonnegative().max(300),
        includedFiles: z.number().int().nonnegative().max(120),
        includedTextFiles: z.number().int().nonnegative().max(120),
        includedHunks: z.number().int().nonnegative().max(400),
        titleBytes: z.number().int().nonnegative().max(4_096),
        bodyBytes: z.number().int().nonnegative().max(65_536),
        patchBytes: z
          .number()
          .int()
          .nonnegative()
          .max(512 * 1_024),
        totalBytes: z
          .number()
          .int()
          .nonnegative()
          .max(512 * 1_024),
      })
      .strict(),
  })
  .strict()
  .superRefine((bounded, context) => {
    if (new Set(bounded.limitsHit).size !== bounded.limitsHit.length) {
      context.addIssue({
        code: "custom",
        path: ["limitsHit"],
        message: "limit markers must be unique",
      });
    }
    if (
      new Set(bounded.files.map((file) => file.path)).size !==
      bounded.files.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "bounded file paths must be unique",
      });
    }
    for (const [fileIndex, file] of bounded.files.entries()) {
      if (
        file.testFile !==
        (file.kind === "text" && isDeterministicTestFile(file.path))
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "testFile"],
          message: "test classification must be deterministic",
        });
      }
      if (file.kind === "binary") {
        if (file.includedHunks !== 0) {
          context.addIssue({
            code: "custom",
            path: ["files", fileIndex, "includedHunks"],
            message: "metadata-only files cannot include hunks",
          });
        }
        continue;
      }
      const patch = file.patch ?? "";
      const hunks = parsePatchHunks(patch);
      const additions = hunks.reduce(
        (total, hunk) => total + hunk.additions,
        0,
      );
      const deletions = hunks.reduce(
        (total, hunk) => total + hunk.deletions,
        0,
      );
      if (
        hunks.length === 0 ||
        file.includedHunks !== hunks.length ||
        file.additions !== additions ||
        file.deletions !== deletions ||
        file.additions > file.sourceAdditions ||
        file.deletions > file.sourceDeletions ||
        isNonSemanticBoundedTextFile(file)
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex],
          message: "bounded text file projection is invalid",
        });
      }
    }
    const expectedUsage = {
      includedFiles: bounded.files.length,
      includedTextFiles: bounded.files.filter((file) => file.kind === "text")
        .length,
      includedHunks: bounded.files.reduce(
        (total, file) => total + file.includedHunks,
        0,
      ),
      titleBytes: utf8Bytes(bounded.title),
      bodyBytes: bounded.body === null ? 0 : utf8Bytes(bounded.body),
      patchBytes: bounded.files.reduce(
        (total, file) => total + utf8Bytes(file.patch ?? ""),
        0,
      ),
    };
    if (
      bounded.files.length > bounded.limits.maximumFiles ||
      expectedUsage.includedHunks > bounded.limits.maximumHunks ||
      bounded.files.some(
        (file) => utf8Bytes(file.patch ?? "") > bounded.limits.maximumFileBytes,
      ) ||
      bounded.usage.includedFiles !== expectedUsage.includedFiles ||
      bounded.usage.includedTextFiles !== expectedUsage.includedTextFiles ||
      bounded.usage.includedHunks !== expectedUsage.includedHunks ||
      bounded.usage.titleBytes !== expectedUsage.titleBytes ||
      bounded.usage.bodyBytes !== expectedUsage.bodyBytes ||
      bounded.usage.patchBytes !== expectedUsage.patchBytes ||
      bounded.usage.totalBytes !==
        expectedUsage.titleBytes +
          expectedUsage.bodyBytes +
          expectedUsage.patchBytes ||
      bounded.usage.totalBytes > bounded.limits.maximumTotalBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "usage or content exceeds the declared bounded limits",
      });
    }
    if (bounded.usage.sourceFiles < bounded.usage.includedFiles) {
      context.addIssue({
        code: "custom",
        path: ["usage", "sourceFiles"],
        message: "source file count cannot be lower than included files",
      });
    }
    const expectedTests = bounded.files
      .filter((file) => file.testFile)
      .map((file) => file.path)
      .sort();
    if (
      stableJson(expectedTests) !==
      stableJson([...bounded.deterministicTestFiles].sort())
    ) {
      context.addIssue({
        code: "custom",
        path: ["deterministicTestFiles"],
        message: "test paths must match deterministic file classification",
      });
    }
  });

export type BoundedRevisionSourceV1 = z.infer<
  typeof BoundedRevisionSourceV1Schema
>;

export const GenerationExcerptCandidateV1Schema = z
  .object({
    path: z.string().min(1).max(1_024),
    side: z.enum(["base", "head"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string().min(1).max(16_384),
  })
  .strict()
  .refine((excerpt) => excerpt.endLine >= excerpt.startLine, {
    path: ["endLine"],
    message: "excerpt end must not precede its start",
  });

export const UntrustedGenerationDataV1Schema = z
  .object({
    trust: z.literal("untrusted"),
    source: z.enum([
      "pull_request_title",
      "pull_request_body",
      "pull_request_filename",
      "pull_request_patch",
      "changed_file_excerpt",
      "analysis_hunk_header",
      "analysis_anchor_evidence",
    ]),
    content: z.string().max(128 * 1_024),
  })
  .strict();

const GenerationContextFileV1Schema = z
  .object({
    filename: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "filename data requires filename trust label" },
    ),
    previousFilename: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "previous filename data requires filename trust label" },
    ).optional(),
    status: GithubChangedFileV1Schema.shape.status,
    testFile: z.boolean(),
    patch: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_patch",
      { message: "patch data requires patch trust label" },
    ),
    patchBytes: z
      .number()
      .int()
      .positive()
      .max(128 * 1_024),
    anchorIds: z.array(AnchorIdSchema).min(1).max(400),
  })
  .strict();

const GenerationContextExcerptV1Schema = z
  .object({
    filename: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "excerpt filename requires filename trust label" },
    ),
    side: z.enum(["base", "head"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerpt: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "changed_file_excerpt",
      { message: "excerpt requires changed-file trust label" },
    ),
    excerptBytes: z.number().int().positive().max(4_096),
  })
  .strict();

const GenerationContextAnchorV1Schema = z
  .object({
    id: AnchorIdSchema,
    filename: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "anchor filenames require filename trust labels" },
    ),
    hunkHeader: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "analysis_hunk_header",
      { message: "anchor hunk headers require hunk trust labels" },
    ),
    oldStart: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    changedLines: z.number().int().positive(),
    evidence: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "analysis_anchor_evidence",
      { message: "anchor evidence requires evidence trust labels" },
    ),
  })
  .strict();

const GenerationContextProviderExclusionV1Schema = z
  .object({
    filename: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "exclusion paths require filename trust labels" },
    ).optional(),
    reason: GenerationContextExclusionReasonV1Schema,
  })
  .strict();

export const GenerationProviderMaterialV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    trust: z.literal("untrusted_github_revision"),
    title: UntrustedGenerationDataV1Schema,
    body: UntrustedGenerationDataV1Schema.nullable(),
    files: z.array(GenerationContextFileV1Schema).max(120),
    anchors: z.array(GenerationContextAnchorV1Schema).max(400),
    excerpts: z.array(GenerationContextExcerptV1Schema).max(12),
    deterministicTestFiles: z.array(UntrustedGenerationDataV1Schema).max(120),
    allowedAnchorIds: z.array(AnchorIdSchema).max(400),
    limits: GenerationContextLimitsV1Schema,
    limitsHit: z.array(GenerationContextLimitHitV1Schema).max(20),
    exclusions: z.array(GenerationContextProviderExclusionV1Schema).max(600),
  })
  .strict();

export type GenerationProviderMaterialV1 = z.infer<
  typeof GenerationProviderMaterialV1Schema
>;

const GenerationContextV1BaseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    contextVersion: z.literal("generation-context-v1"),
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    analysisSnapshotId: UuidSchema,
    sourceHash: Sha256Schema,
    analyzerVersion: z.literal("bounded-diff-v1"),
    contextHash: Sha256Schema,
    title: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_title",
      { message: "title requires title trust label" },
    ),
    body: UntrustedGenerationDataV1Schema.refine(
      (value) => value.source === "pull_request_body",
      { message: "body requires body trust label" },
    ).nullable(),
    files: z.array(GenerationContextFileV1Schema).max(120),
    anchors: z.array(GenerationContextAnchorV1Schema).max(400),
    excerpts: z.array(GenerationContextExcerptV1Schema).max(12),
    deterministicTestFiles: z
      .array(
        UntrustedGenerationDataV1Schema.refine(
          (value) => value.source === "pull_request_filename",
          { message: "test paths require filename trust labels" },
        ),
      )
      .max(120),
    allowedAnchorIds: z.array(AnchorIdSchema).max(400),
    limits: GenerationContextLimitsV1Schema,
    limitsHit: z.array(GenerationContextLimitHitV1Schema).max(20),
    exclusions: z.array(GenerationContextProviderExclusionV1Schema).max(600),
    usage: z
      .object({
        includedFiles: z.number().int().nonnegative().max(120),
        includedHunks: z.number().int().nonnegative().max(400),
        titleBytes: z.number().int().nonnegative().max(4_096),
        bodyBytes: z.number().int().nonnegative().max(65_536),
        patchBytes: z
          .number()
          .int()
          .nonnegative()
          .max(512 * 1_024),
        excerptBytes: z
          .number()
          .int()
          .nonnegative()
          .max(48 * 1_024),
        totalBytes: z
          .number()
          .int()
          .nonnegative()
          .max(512 * 1_024),
        providerBytes: z
          .number()
          .int()
          .nonnegative()
          .max(512 * 1_024),
      })
      .strict(),
  })
  .strict();

export const GenerationContextV1Schema =
  GenerationContextV1BaseSchema.superRefine((generationContext, context) => {
    const knownAnchors = new Set(generationContext.allowedAnchorIds);
    if (knownAnchors.size !== generationContext.allowedAnchorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedAnchorIds"],
        message: "allowed anchor IDs must be unique",
      });
    }
    if (
      new Set(generationContext.limitsHit).size !==
      generationContext.limitsHit.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitsHit"],
        message: "limit markers must be unique",
      });
    }
    const filePaths = generationContext.files.map(
      (file) => file.filename.content,
    );
    if (new Set(filePaths).size !== filePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "context filenames must be unique",
      });
    }

    const referencedAnchors: string[] = [];
    for (const [fileIndex, file] of generationContext.files.entries()) {
      if (new Set(file.anchorIds).size !== file.anchorIds.length) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "anchorIds"],
          message: "file anchor IDs must be unique",
        });
      }
      for (const anchorId of file.anchorIds) {
        referencedAnchors.push(anchorId);
        if (!knownAnchors.has(anchorId)) {
          context.addIssue({
            code: "custom",
            path: ["files", fileIndex, "anchorIds"],
            message: "file references an anchor outside the analyzer set",
          });
        }
      }
      const actualPatchBytes = utf8Bytes(file.patch.content);
      if (
        file.patchBytes !== actualPatchBytes ||
        actualPatchBytes > generationContext.limits.maximumFileBytes ||
        file.testFile !== isDeterministicTestFile(file.filename.content)
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex],
          message: "context file projection exceeds or misstates its limits",
        });
      }
    }
    if (
      stableJson([...referencedAnchors].sort(anchorIdOrder)) !==
      stableJson([...generationContext.allowedAnchorIds].sort(anchorIdOrder))
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "context files must cover exactly the allowed anchors",
      });
    }
    if (
      stableJson(
        generationContext.anchors
          .map((anchor) => anchor.id)
          .sort(anchorIdOrder),
      ) !==
        stableJson(
          [...generationContext.allowedAnchorIds].sort(anchorIdOrder),
        ) ||
      new Set(generationContext.anchors.map((anchor) => anchor.id)).size !==
        generationContext.anchors.length ||
      generationContext.anchors.some((anchor) => {
        const file = generationContext.files.find(
          (item) => item.filename.content === anchor.filename.content,
        );
        return !file?.anchorIds.includes(anchor.id);
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "context anchors must exactly map the analyzer anchor set",
      });
    }

    const expectedTestFiles = generationContext.files
      .filter((file) => file.testFile)
      .map((file) => file.filename.content)
      .sort();
    const actualTestFiles = generationContext.deterministicTestFiles
      .map((file) => file.content)
      .sort();
    if (stableJson(expectedTestFiles) !== stableJson(actualTestFiles)) {
      context.addIssue({
        code: "custom",
        path: ["deterministicTestFiles"],
        message: "test file projection does not match included context files",
      });
    }
    const changedTextPaths = new Set(filePaths);
    for (const [
      excerptIndex,
      excerpt,
    ] of generationContext.excerpts.entries()) {
      const actualExcerptBytes = utf8Bytes(excerpt.excerpt.content);
      if (
        !changedTextPaths.has(excerpt.filename.content) ||
        excerpt.endLine < excerpt.startLine ||
        excerpt.excerptBytes !== actualExcerptBytes ||
        actualExcerptBytes > generationContext.limits.maximumExcerptBytes
      ) {
        context.addIssue({
          code: "custom",
          path: ["excerpts", excerptIndex],
          message: "excerpt is not a bounded changed-text projection",
        });
      }
    }
    const expectedUsage = {
      includedFiles: generationContext.files.length,
      includedHunks: generationContext.allowedAnchorIds.length,
      titleBytes: utf8Bytes(generationContext.title.content),
      bodyBytes:
        generationContext.body === null
          ? 0
          : utf8Bytes(generationContext.body.content),
      patchBytes: generationContext.files.reduce(
        (total, file) => total + file.patchBytes,
        0,
      ),
      excerptBytes: generationContext.excerpts.reduce(
        (total, excerpt) => total + excerpt.excerptBytes,
        0,
      ),
    };
    if (
      generationContext.usage.includedFiles !== expectedUsage.includedFiles ||
      generationContext.usage.includedHunks !== expectedUsage.includedHunks ||
      generationContext.usage.titleBytes !== expectedUsage.titleBytes ||
      generationContext.usage.bodyBytes !== expectedUsage.bodyBytes ||
      generationContext.usage.patchBytes !== expectedUsage.patchBytes ||
      generationContext.usage.excerptBytes !== expectedUsage.excerptBytes ||
      generationContext.usage.providerBytes !==
        utf8Bytes(
          stableJson(
            generationProviderMaterial(
              providerFieldsFromContext(generationContext),
            ),
          ),
        ) ||
      generationContext.usage.totalBytes !==
        generationContext.usage.providerBytes ||
      generationContext.files.length > generationContext.limits.maximumFiles ||
      generationContext.allowedAnchorIds.length >
        generationContext.limits.maximumHunks ||
      generationContext.excerpts.length >
        generationContext.limits.maximumExcerpts ||
      expectedUsage.titleBytes > generationContext.limits.maximumTitleBytes ||
      expectedUsage.bodyBytes > generationContext.limits.maximumBodyBytes ||
      generationContext.usage.providerBytes >
        generationContext.limits.maximumTotalBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "usage does not match bounded context content",
      });
    }
    if (
      generationContext.contextHash !==
      computeGenerationContextHash(generationContext)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contextHash"],
        message: "context hash does not match canonical context material",
      });
    }
  });

export type GenerationContextV1 = z.infer<typeof GenerationContextV1Schema>;

export const AnchoredSemanticItemV1Schema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    text: z.string().min(1).max(2_000),
    anchorIds: z.array(AnchorIdSchema).min(1).max(10),
  })
  .strict()
  .superRefine((item, context) => {
    if (new Set(item.anchorIds).size !== item.anchorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["anchorIds"],
        message: "semantic anchor IDs must be unique",
      });
    }
  });

export type AnchoredSemanticItemV1 = z.infer<
  typeof AnchoredSemanticItemV1Schema
>;

export class GenerationContextValidationError extends Error {
  readonly code = "GENERATION_CONTEXT_INVALID" as const;

  constructor() {
    super("Generation context material is invalid.");
    this.name = "GenerationContextValidationError";
  }
}

export function githubRevisionSourceHash(rawSource: unknown): string {
  const parsed = GithubRevisionSourceV1Schema.safeParse(rawSource);
  if (!parsed.success) throw new GenerationContextValidationError();
  // This intentionally matches packages/db's existing source_hash contract:
  // strict Zod projection followed by JSON.stringify and SHA-256.
  return sha256(JSON.stringify(parsed.data));
}

export function buildBoundedRevisionSourceV1(
  rawSource: unknown,
  rawLimits: GenerationContextLimitsV1 = DEFAULT_GENERATION_CONTEXT_LIMITS_V1,
): BoundedRevisionSourceV1 {
  const sourceResult = GithubRevisionSourceV1Schema.safeParse(rawSource);
  const limitsResult = GenerationContextLimitsV1Schema.safeParse(rawLimits);
  if (!sourceResult.success || !limitsResult.success) {
    throw new GenerationContextValidationError();
  }
  const source = sourceResult.data;
  const limits = limitsResult.data;
  const limitsHit = new Set<
    z.infer<typeof GenerationContextLimitHitV1Schema>
  >();
  const exclusions: GenerationContextExclusionV1[] = [];

  if (source.limitsHit.files) limitsHit.add("source_file_count");
  if (source.limitsHit.patchBytes) limitsHit.add("source_patch_bytes");
  if (source.limitsHit.patchUnavailable) {
    limitsHit.add("source_patch_unavailable");
  }

  const title = truncateUtf8(source.title, limits.maximumTitleBytes);
  if (title.truncated) limitsHit.add("title_bytes");
  let remainingBytes = Math.max(0, limits.maximumTotalBytes - title.byteLength);
  const rawBody = source.body ?? "";
  const bodyLimit = Math.min(limits.maximumBodyBytes, remainingBytes);
  const body = truncateUtf8(rawBody, bodyLimit);
  if (body.truncated) {
    limitsHit.add("body_bytes");
    if (bodyLimit < Math.min(limits.maximumBodyBytes, utf8Bytes(rawBody))) {
      limitsHit.add("total_bytes");
    }
  }
  remainingBytes -= body.byteLength;

  const orderedFiles = [...source.files].sort(compareSourceFiles);
  const selectedSourceFiles = orderedFiles.slice(0, limits.maximumFiles);
  for (const file of orderedFiles.slice(limits.maximumFiles)) {
    exclusions.push({ path: file.filename, reason: "file_count" });
    limitsHit.add("file_count");
  }

  const files: BoundedRevisionSourceV1["files"] = [];
  let includedHunks = 0;
  let patchBytes = 0;
  for (const file of selectedSourceFiles) {
    const metadata = metadataOnlyFile(file);
    const exclusionReason = nonSemanticFileReason(file);
    if (exclusionReason !== null) {
      exclusions.push({ path: file.filename, reason: exclusionReason });
      files.push(metadata);
      continue;
    }
    if (file.patch === null) {
      exclusions.push({ path: file.filename, reason: "patch_unavailable" });
      limitsHit.add("source_patch_unavailable");
      files.push(metadata);
      continue;
    }

    const hunks = parsePatchHunks(file.patch);
    if (hunks.length === 0) {
      exclusions.push({ path: file.filename, reason: "malformed_patch" });
      files.push(metadata);
      continue;
    }

    const selectedHunks: PatchHunk[] = [];
    let fileBytes = 0;
    for (const hunk of hunks) {
      if (includedHunks >= limits.maximumHunks) {
        exclusions.push({ path: file.filename, reason: "hunk_count" });
        limitsHit.add("hunk_count");
        break;
      }
      const separatorBytes = selectedHunks.length === 0 ? 0 : 1;
      if (
        fileBytes + separatorBytes + hunk.byteLength >
        limits.maximumFileBytes
      ) {
        exclusions.push({ path: file.filename, reason: "file_bytes" });
        limitsHit.add("file_bytes");
        break;
      }
      if (separatorBytes + hunk.byteLength > remainingBytes) {
        exclusions.push({ path: file.filename, reason: "total_bytes" });
        limitsHit.add("total_bytes");
        break;
      }
      selectedHunks.push(hunk);
      fileBytes += separatorBytes + hunk.byteLength;
      remainingBytes -= separatorBytes + hunk.byteLength;
      patchBytes += separatorBytes + hunk.byteLength;
      includedHunks += 1;
    }
    if (selectedHunks.length === 0) {
      files.push(metadata);
      continue;
    }
    const boundedPatch = selectedHunks.map((hunk) => hunk.content).join("\n");
    files.push({
      ...metadata,
      kind: "text",
      patch: boundedPatch,
      additions: selectedHunks.reduce(
        (total, hunk) => total + hunk.additions,
        0,
      ),
      deletions: selectedHunks.reduce(
        (total, hunk) => total + hunk.deletions,
        0,
      ),
      includedHunks: selectedHunks.length,
      testFile: isDeterministicTestFile(file.filename),
    });
  }

  const bounded = {
    schemaVersion: "1" as const,
    sourceVersion: "github-revision-source-bounded-v1" as const,
    sourceHash: githubRevisionSourceHash(source),
    baseSha: source.baseSha,
    headSha: source.headSha,
    title: title.value,
    body: source.body === null ? null : body.value,
    files,
    deterministicTestFiles: files
      .filter((file) => file.testFile)
      .map((file) => file.path)
      .sort(),
    limits,
    limitsHit: [...limitsHit].sort(),
    exclusions: sortExclusions(exclusions),
    usage: {
      sourceFiles: source.files.length,
      includedFiles: files.length,
      includedTextFiles: files.filter((file) => file.kind === "text").length,
      includedHunks,
      titleBytes: title.byteLength,
      bodyBytes: source.body === null ? 0 : body.byteLength,
      patchBytes,
      totalBytes:
        title.byteLength +
        (source.body === null ? 0 : body.byteLength) +
        patchBytes,
    },
  };
  const parsed = BoundedRevisionSourceV1Schema.safeParse(bounded);
  if (!parsed.success) throw new GenerationContextValidationError();
  return fitBoundedSourceToProviderEnvelope(parsed.data);
}

function fitBoundedSourceToProviderEnvelope(
  initial: BoundedRevisionSourceV1,
): BoundedRevisionSourceV1 {
  let bounded = initial;
  while (true) {
    const analysis = analyzePullRequestPatch(
      boundedRevisionSourcePatch(bounded),
    );
    try {
      buildGenerationContextV1({
        revisionId: "00000000-0000-4000-8000-000000000001",
        analysisSnapshotId: "00000000-0000-4000-8000-000000000002",
        boundedSource: bounded,
        analysis,
      });
      return bounded;
    } catch (error) {
      if (!(error instanceof GenerationContextValidationError)) throw error;
      const reduced = removeLastBoundedHunk(bounded);
      if (reduced === null) throw error;
      bounded = reduced;
    }
  }
}

function removeLastBoundedHunk(
  bounded: BoundedRevisionSourceV1,
): BoundedRevisionSourceV1 | null {
  const index = bounded.files.findLastIndex((file) => file.kind === "text");
  if (index < 0) return null;
  const target = bounded.files[index]!;
  const hunks = parsePatchHunks(target.patch ?? "");
  if (hunks.length === 0) return null;
  const remainingHunks = hunks.slice(0, -1);
  const replacement: BoundedRevisionSourceV1["files"][number] =
    remainingHunks.length === 0
      ? {
          path: target.path,
          ...(target.previousPath === undefined
            ? {}
            : { previousPath: target.previousPath }),
          status: target.status,
          kind: "binary",
          additions: target.sourceAdditions,
          deletions: target.sourceDeletions,
          sourceAdditions: target.sourceAdditions,
          sourceDeletions: target.sourceDeletions,
          includedHunks: 0,
          testFile: false,
        }
      : {
          ...target,
          patch: remainingHunks.map((hunk) => hunk.content).join("\n"),
          additions: remainingHunks.reduce(
            (total, hunk) => total + hunk.additions,
            0,
          ),
          deletions: remainingHunks.reduce(
            (total, hunk) => total + hunk.deletions,
            0,
          ),
          includedHunks: remainingHunks.length,
        };
  const files = bounded.files.map((file, fileIndex) =>
    fileIndex === index ? replacement : file,
  );
  const patchBytes = files.reduce(
    (total, file) => total + utf8Bytes(file.patch ?? ""),
    0,
  );
  const candidate = {
    ...bounded,
    files,
    deterministicTestFiles: files
      .filter((file) => file.testFile)
      .map((file) => file.path)
      .sort(codeUnitCompare),
    limitsHit: [
      ...new Set([...bounded.limitsHit, "total_bytes" as const]),
    ].sort(codeUnitCompare),
    exclusions: sortExclusions([
      ...bounded.exclusions,
      { path: target.path, reason: "total_bytes" },
    ]),
    usage: {
      ...bounded.usage,
      includedTextFiles: files.filter((file) => file.kind === "text").length,
      includedHunks: files.reduce(
        (total, file) => total + file.includedHunks,
        0,
      ),
      patchBytes,
      totalBytes:
        bounded.usage.titleBytes + bounded.usage.bodyBytes + patchBytes,
    },
  };
  const parsed = BoundedRevisionSourceV1Schema.safeParse(candidate);
  if (!parsed.success) throw new GenerationContextValidationError();
  return parsed.data;
}

export function boundedRevisionSourcePatch(
  rawBounded: unknown,
): PullRequestPatch {
  const bounded = BoundedRevisionSourceV1Schema.safeParse(rawBounded);
  if (!bounded.success) throw new GenerationContextValidationError();
  return PullRequestPatchSchema.parse({
    baseSha: bounded.data.baseSha,
    headSha: bounded.data.headSha,
    files: bounded.data.files.map((file) => ({
      path: file.path,
      ...(file.previousPath === undefined
        ? {}
        : { previousPath: file.previousPath }),
      kind: file.kind,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      additions: file.additions,
      deletions: file.deletions,
    })),
  });
}

export function buildGenerationContextV1(
  rawInput: unknown,
): GenerationContextV1 {
  const inputSchema = z
    .object({
      revisionId: UuidSchema,
      analysisSnapshotId: UuidSchema,
      boundedSource: BoundedRevisionSourceV1Schema,
      analysis: AnalysisSnapshotSchema,
      excerpts: z
        .array(GenerationExcerptCandidateV1Schema)
        .max(100)
        .default([]),
    })
    .strict();
  const inputResult = inputSchema.safeParse(rawInput);
  if (!inputResult.success) throw new GenerationContextValidationError();
  const input = inputResult.data;
  if (
    input.analysis.baseSha !== input.boundedSource.baseSha ||
    input.analysis.headSha !== input.boundedSource.headSha
  ) {
    throw new GenerationContextValidationError();
  }

  const anchorsByFile = new Map<string, string[]>();
  for (const anchor of input.analysis.anchors) {
    const boundedFile = input.boundedSource.files.find(
      (file) => file.path === anchor.file && file.kind === "text",
    );
    if (
      boundedFile?.patch === undefined ||
      !patchContainsAnchor(boundedFile.patch, anchor)
    ) {
      throw new GenerationContextValidationError();
    }
    const current = anchorsByFile.get(anchor.file) ?? [];
    current.push(anchor.id);
    anchorsByFile.set(anchor.file, current);
  }

  const files = input.boundedSource.files.flatMap((file) => {
    const anchorIds = anchorsByFile.get(file.path);
    if (
      file.kind !== "text" ||
      file.patch === undefined ||
      !anchorIds?.length
    ) {
      return [];
    }
    return [
      {
        filename: untrusted("pull_request_filename", file.path),
        ...(file.previousPath === undefined
          ? {}
          : {
              previousFilename: untrusted(
                "pull_request_filename" as const,
                file.previousPath,
              ),
            }),
        status: file.status,
        testFile: file.testFile,
        patch: untrusted("pull_request_patch", file.patch),
        patchBytes: utf8Bytes(file.patch),
        anchorIds: [...anchorIds].sort(anchorIdOrder),
      },
    ];
  });

  let remainingBytes =
    input.boundedSource.limits.maximumTotalBytes -
    input.boundedSource.usage.totalBytes;
  const exclusions = [...input.boundedSource.exclusions];
  const limitsHit = new Set(input.boundedSource.limitsHit);
  const changedTextPaths = new Set(files.map((file) => file.filename.content));
  const excerpts: Array<z.infer<typeof GenerationContextExcerptV1Schema>> = [];
  for (const excerpt of [...input.excerpts].sort(compareExcerpts)) {
    if (!changedTextPaths.has(excerpt.path)) {
      exclusions.push({
        path: excerpt.path,
        reason: "excerpt_not_changed_text",
      });
      continue;
    }
    if (excerpts.length >= input.boundedSource.limits.maximumExcerpts) {
      exclusions.push({ path: excerpt.path, reason: "excerpt_count" });
      limitsHit.add("excerpt_count");
      continue;
    }
    const content = truncateUtf8(
      excerpt.content,
      Math.min(
        input.boundedSource.limits.maximumExcerptBytes,
        Math.max(0, remainingBytes),
      ),
    );
    if (content.byteLength === 0) {
      exclusions.push({ path: excerpt.path, reason: "total_bytes" });
      limitsHit.add("total_bytes");
      continue;
    }
    if (content.truncated) {
      exclusions.push({ path: excerpt.path, reason: "excerpt_bytes" });
      limitsHit.add("excerpt_bytes");
      if (remainingBytes < input.boundedSource.limits.maximumExcerptBytes) {
        limitsHit.add("total_bytes");
      }
    }
    excerpts.push({
      filename: untrusted("pull_request_filename", excerpt.path),
      side: excerpt.side,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      excerpt: untrusted("changed_file_excerpt", content.value),
      excerptBytes: content.byteLength,
    });
    remainingBytes -= content.byteLength;
  }

  const providerFields = fitGenerationProviderMaterial(
    {
      title: untrusted("pull_request_title", input.boundedSource.title),
      body:
        input.boundedSource.body === null
          ? null
          : untrusted("pull_request_body", input.boundedSource.body),
      files,
      anchors: input.analysis.anchors
        .map((anchor) => ({
          id: anchor.id,
          filename: untrusted("pull_request_filename" as const, anchor.file),
          hunkHeader: untrusted(
            "analysis_hunk_header" as const,
            anchor.hunkHeader,
          ),
          oldStart: anchor.oldStart,
          newStart: anchor.newStart,
          changedLines: anchor.changedLines,
          evidence: untrusted(
            "analysis_anchor_evidence" as const,
            anchor.evidence,
          ),
        }))
        .sort((left, right) => anchorIdOrder(left.id, right.id)),
      excerpts,
      deterministicTestFiles: files
        .filter((file) => file.testFile)
        .map((file) =>
          untrusted("pull_request_filename" as const, file.filename.content),
        ),
      allowedAnchorIds: input.analysis.anchors
        .map((anchor) => anchor.id)
        .sort(anchorIdOrder),
      limits: input.boundedSource.limits,
      limitsHit: [...limitsHit].sort(),
      exclusions: sortExclusions(exclusions).map((exclusion) => ({
        ...(exclusion.path === undefined
          ? {}
          : {
              filename: untrusted(
                "pull_request_filename" as const,
                exclusion.path,
              ),
            }),
        reason: exclusion.reason,
      })),
    },
    input.boundedSource.limits.maximumTotalBytes,
  );
  const providerMaterial = generationProviderMaterial(providerFields);
  const providerBytes = utf8Bytes(stableJson(providerMaterial));
  const contextWithoutHash = {
    schemaVersion: "1" as const,
    contextVersion: "generation-context-v1" as const,
    revisionId: input.revisionId,
    headSha: input.analysis.headSha,
    baseSha: input.analysis.baseSha,
    analysisSnapshotId: input.analysisSnapshotId,
    sourceHash: input.boundedSource.sourceHash,
    analyzerVersion: input.analysis.analyzerVersion,
    ...providerFields,
    usage: {
      includedFiles: files.length,
      includedHunks: input.analysis.anchors.length,
      titleBytes: utf8Bytes(providerFields.title.content),
      bodyBytes:
        providerFields.body === null
          ? 0
          : utf8Bytes(providerFields.body.content),
      patchBytes: input.boundedSource.usage.patchBytes,
      excerptBytes: providerFields.excerpts.reduce(
        (total, excerpt) => total + excerpt.excerptBytes,
        0,
      ),
      totalBytes: providerBytes,
      providerBytes,
    },
  };
  const contextHash = sha256(stableJson(contextWithoutHash));
  const parsed = GenerationContextV1Schema.safeParse({
    ...contextWithoutHash,
    contextHash,
  });
  if (!parsed.success) throw new GenerationContextValidationError();
  return parsed.data;
}

type GenerationProviderFieldsV1 = Omit<
  GenerationProviderMaterialV1,
  "schemaVersion" | "trust"
>;

function generationProviderMaterial(
  fields: GenerationProviderFieldsV1,
): GenerationProviderMaterialV1 {
  return GenerationProviderMaterialV1Schema.parse({
    schemaVersion: "1",
    trust: "untrusted_github_revision",
    ...fields,
  });
}

function providerFieldsFromContext(
  context: GenerationProviderFieldsV1,
): GenerationProviderFieldsV1 {
  return {
    title: context.title,
    body: context.body,
    files: context.files,
    anchors: context.anchors,
    excerpts: context.excerpts,
    deterministicTestFiles: context.deterministicTestFiles,
    allowedAnchorIds: context.allowedAnchorIds,
    limits: context.limits,
    limitsHit: context.limitsHit,
    exclusions: context.exclusions,
  };
}

export function projectGenerationProviderMaterialV1(
  rawContext: unknown,
): GenerationProviderMaterialV1 {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  if (!context.success) throw new GenerationContextValidationError();
  return generationProviderMaterial(providerFieldsFromContext(context.data));
}

export function generationProviderMaterialBytesV1(rawContext: unknown): number {
  return utf8Bytes(canonicalGenerationProviderMaterialV1(rawContext));
}

export function canonicalGenerationProviderMaterialV1(
  rawContext: unknown,
): string {
  return stableJson(projectGenerationProviderMaterialV1(rawContext));
}

function fitGenerationProviderMaterial(
  rawFields: GenerationProviderFieldsV1,
  maximumBytes: number,
): GenerationProviderFieldsV1 {
  let fields: GenerationProviderFieldsV1 = {
    ...rawFields,
    excerpts: [...rawFields.excerpts],
    exclusions: [...rawFields.exclusions],
    limitsHit: [...rawFields.limitsHit],
  };
  let trimmed = false;
  const bytes = (): number =>
    utf8Bytes(stableJson(generationProviderMaterial(fields)));

  while (bytes() > maximumBytes && fields.exclusions.length > 0) {
    fields = { ...fields, exclusions: fields.exclusions.slice(0, -1) };
    trimmed = true;
  }
  while (bytes() > maximumBytes && fields.excerpts.length > 0) {
    fields = { ...fields, excerpts: fields.excerpts.slice(0, -1) };
    trimmed = true;
  }
  if (bytes() > maximumBytes && fields.body !== null) {
    fields = {
      ...fields,
      body: {
        ...fields.body,
        content: fitContentToProviderBudget(
          fields.body.content,
          maximumBytes,
          (content) => ({
            ...fields,
            body: fields.body === null ? null : { ...fields.body, content },
          }),
        ),
      },
    };
    trimmed = true;
  }
  if (bytes() > maximumBytes) {
    fields = {
      ...fields,
      title: {
        ...fields.title,
        content: fitContentToProviderBudget(
          fields.title.content,
          maximumBytes,
          (content) => ({
            ...fields,
            title: { ...fields.title, content },
          }),
        ),
      },
    };
    trimmed = true;
  }
  if (trimmed && !fields.limitsHit.includes("total_bytes")) {
    const nextLimitsHit: GenerationProviderFieldsV1["limitsHit"] = [
      ...fields.limitsHit,
      "total_bytes",
    ];
    fields = {
      ...fields,
      limitsHit: nextLimitsHit.sort(codeUnitCompare),
    };
    while (bytes() > maximumBytes && fields.exclusions.length > 0) {
      fields = { ...fields, exclusions: fields.exclusions.slice(0, -1) };
    }
    while (bytes() > maximumBytes && fields.excerpts.length > 0) {
      fields = { ...fields, excerpts: fields.excerpts.slice(0, -1) };
    }
    if (bytes() > maximumBytes && fields.body !== null) {
      fields = {
        ...fields,
        body: {
          ...fields.body,
          content: fitContentToProviderBudget(
            fields.body.content,
            maximumBytes,
            (content) => ({
              ...fields,
              body: fields.body === null ? null : { ...fields.body, content },
            }),
          ),
        },
      };
    }
    if (bytes() > maximumBytes) {
      fields = {
        ...fields,
        title: {
          ...fields.title,
          content: fitContentToProviderBudget(
            fields.title.content,
            maximumBytes,
            (content) => ({
              ...fields,
              title: { ...fields.title, content },
            }),
          ),
        },
      };
    }
  }
  if (bytes() > maximumBytes) throw new GenerationContextValidationError();
  return fields;
}

function fitContentToProviderBudget(
  content: string,
  maximumBytes: number,
  withContent: (content: string) => GenerationProviderFieldsV1,
): string {
  const symbols = [...content];
  let low = 0;
  let high = symbols.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = symbols.slice(0, midpoint).join("");
    const candidateBytes = utf8Bytes(
      stableJson(generationProviderMaterial(withContent(candidate))),
    );
    if (candidateBytes <= maximumBytes) low = midpoint;
    else high = midpoint - 1;
  }
  return symbols.slice(0, low).join("");
}

/** Invalid, empty, duplicate, or unknown-anchor semantic items are discarded. */
export function filterAnchoredSemanticItemsV1(
  rawItems: unknown,
  rawContext: unknown,
): AnchoredSemanticItemV1[] {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  if (!context.success || !Array.isArray(rawItems)) return [];
  const allowed = new Set(context.data.allowedAnchorIds);
  const accepted: AnchoredSemanticItemV1[] = [];
  for (const rawItem of rawItems) {
    const item = AnchoredSemanticItemV1Schema.safeParse(rawItem);
    if (
      item.success &&
      item.data.anchorIds.every((anchorId) => allowed.has(anchorId))
    ) {
      accepted.push(item.data);
    }
  }
  return accepted;
}

/** Fail closed unless every context anchor is the exact analyzer anchor/file set. */
export function verifyGenerationContextV1AgainstAnalysis(
  rawContext: unknown,
  rawAnalysis: unknown,
): void {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  const analysis = AnalysisSnapshotSchema.safeParse(rawAnalysis);
  if (!context.success || !analysis.success) {
    throw new GenerationContextValidationError();
  }
  const expected = new Map(
    analysis.data.anchors.map((anchor) => [anchor.id, anchor.file]),
  );
  const referenced = context.data.files.flatMap((file) =>
    file.anchorIds.map(
      (anchorId) => [anchorId, file.filename.content] as const,
    ),
  );
  const projectedAnchors = context.data.anchors.map((anchor) => ({
    id: anchor.id,
    file: anchor.filename.content,
    hunkHeader: anchor.hunkHeader.content,
    oldStart: anchor.oldStart,
    newStart: anchor.newStart,
    changedLines: anchor.changedLines,
    evidence: anchor.evidence.content,
  }));
  if (
    context.data.baseSha !== analysis.data.baseSha ||
    context.data.headSha !== analysis.data.headSha ||
    context.data.analyzerVersion !== analysis.data.analyzerVersion ||
    referenced.length !== expected.size ||
    new Set(referenced.map(([anchorId]) => anchorId)).size !==
      referenced.length ||
    referenced.some(
      ([anchorId, filename]) => expected.get(anchorId) !== filename,
    ) ||
    stableJson(projectedAnchors) !== stableJson(analysis.data.anchors)
  ) {
    throw new GenerationContextValidationError();
  }
}

export function computeGenerationContextHash(
  context: z.infer<typeof GenerationContextV1BaseSchema>,
): string {
  return sha256(canonicalGenerationContextMaterialV1(context));
}

export function canonicalGenerationContextMaterialV1(
  context: z.infer<typeof GenerationContextV1BaseSchema>,
): string {
  const { contextHash: _contextHash, ...material } = context;
  return stableJson(material);
}

function nonSemanticFileReason(
  file: GithubRevisionSourceV1["files"][number],
): GenerationContextExclusionV1["reason"] | null {
  if (
    file.gitKind === "symlink" ||
    file.gitKind === "submodule" ||
    isUnusualPath(file.filename) ||
    (file.previousFilename !== null && isUnusualPath(file.previousFilename))
  ) {
    return file.gitKind === "symlink"
      ? "symlink"
      : file.gitKind === "submodule"
        ? "submodule"
        : "unusual_path";
  }
  if (GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(file.filename))) {
    return "generated";
  }
  if (LOCKFILE_PATH_PATTERNS.some((pattern) => pattern.test(file.filename))) {
    return "lockfile";
  }
  if (ARCHIVE_PATH_PATTERN.test(file.filename)) return "archive";
  if (file.patch !== null && LFS_POINTER_PATTERN.test(file.patch)) {
    return "lfs_pointer";
  }
  if (file.patch !== null && SUBMODULE_PATCH_PATTERN.test(file.patch)) {
    return "submodule";
  }
  return null;
}

function metadataOnlyFile(
  file: GithubRevisionSourceV1["files"][number],
): BoundedRevisionSourceV1["files"][number] {
  return {
    path: file.filename,
    ...(file.previousFilename === null
      ? {}
      : { previousPath: file.previousFilename }),
    status: file.status,
    kind: "binary",
    additions: file.additions,
    deletions: file.deletions,
    sourceAdditions: file.additions,
    sourceDeletions: file.deletions,
    includedHunks: 0,
    testFile: false,
  };
}

type PatchHunk = {
  content: string;
  byteLength: number;
  additions: number;
  deletions: number;
  header: string;
  oldStart: number;
  newStart: number;
  changedLines: string[];
};

function parsePatchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: string[] | undefined;
  const flush = () => {
    if (current === undefined) return;
    const content = current.join("\n");
    const header = current[0] ?? "";
    const match = HUNK_HEADER_PATTERN.exec(header);
    if (match === null) return;
    const changedLines = current
      .slice(1)
      .filter(
        (line) =>
          (line.startsWith("+") && !line.startsWith("+++")) ||
          (line.startsWith("-") && !line.startsWith("---")),
      )
      .map((line) => line.slice(1));
    hunks.push({
      content,
      byteLength: utf8Bytes(content),
      additions: current
        .slice(1)
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .length,
      deletions: current
        .slice(1)
        .filter((line) => line.startsWith("-") && !line.startsWith("---"))
        .length,
      header,
      oldStart: Number(match[1]),
      newStart: Number(match[2]),
      changedLines,
    });
  };
  for (const line of patch.split("\n")) {
    if (HUNK_HEADER_PATTERN.test(line)) {
      flush();
      current = [line];
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  flush();
  return hunks;
}

function patchContainsAnchor(
  patch: string,
  anchor: AnalysisSnapshot["anchors"][number],
): boolean {
  return parsePatchHunks(patch).some(
    (hunk) =>
      hunk.header.slice(0, 500) === anchor.hunkHeader &&
      hunk.oldStart === anchor.oldStart &&
      hunk.newStart === anchor.newStart &&
      hunk.changedLines.length === anchor.changedLines &&
      compactAnchorEvidence(hunk.changedLines) === anchor.evidence,
  );
}

function compactAnchorEvidence(lines: string[]): string {
  const evidence = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  return (evidence || "Changed lines in bounded patch hunk").slice(0, 500);
}

function isNonSemanticBoundedTextFile(
  file: z.infer<typeof BoundedRevisionFileV1Schema>,
): boolean {
  return (
    isUnusualPath(file.path) ||
    (file.previousPath !== undefined && isUnusualPath(file.previousPath)) ||
    GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(file.path)) ||
    LOCKFILE_PATH_PATTERNS.some((pattern) => pattern.test(file.path)) ||
    ARCHIVE_PATH_PATTERN.test(file.path) ||
    LFS_POINTER_PATTERN.test(file.patch ?? "") ||
    SUBMODULE_PATCH_PATTERN.test(file.patch ?? "")
  );
}

function compareSourceFiles(
  left: GithubRevisionSourceV1["files"][number],
  right: GithubRevisionSourceV1["files"][number],
): number {
  return (
    codeUnitCompare(left.filename, right.filename) ||
    codeUnitCompare(
      left.previousFilename ?? "",
      right.previousFilename ?? "",
    ) ||
    codeUnitCompare(left.status, right.status) ||
    codeUnitCompare(left.sha ?? "", right.sha ?? "")
  );
}

function compareExcerpts(
  left: z.infer<typeof GenerationExcerptCandidateV1Schema>,
  right: z.infer<typeof GenerationExcerptCandidateV1Schema>,
): number {
  return (
    codeUnitCompare(left.path, right.path) ||
    codeUnitCompare(left.side, right.side) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    codeUnitCompare(left.content, right.content)
  );
}

function sortExclusions(
  exclusions: readonly GenerationContextExclusionV1[],
): GenerationContextExclusionV1[] {
  return [...exclusions].sort(
    (left, right) =>
      codeUnitCompare(left.path ?? "", right.path ?? "") ||
      codeUnitCompare(left.reason, right.reason),
  );
}

function isUnusualPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("-") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  );
}

export function isDeterministicTestFile(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^./]+$/iu.test(
    path,
  );
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { value: string; byteLength: number; truncated: boolean } {
  if (maximumBytes <= 0) {
    return { value: "", byteLength: 0, truncated: value.length > 0 };
  }
  let byteLength = 0;
  let bounded = "";
  for (const symbol of value) {
    const symbolBytes = utf8Bytes(symbol);
    if (byteLength + symbolBytes > maximumBytes) break;
    bounded += symbol;
    byteLength += symbolBytes;
  }
  return { value: bounded, byteLength, truncated: bounded !== value };
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function untrusted<
  TSource extends z.infer<typeof UntrustedGenerationDataV1Schema>["source"],
>(source: TSource, content: string) {
  return { trust: "untrusted" as const, source, content };
}

function anchorIdOrder(left: string, right: string): number {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
