import {
  AnalysisLimitsSchema,
  AnalysisSnapshotSchema,
  DEFAULT_ANALYSIS_LIMITS,
  PullRequestPatchSchema,
  type AnalysisLimits,
  type AnalysisSnapshot,
  type DiffAnchor,
  type PatchFile,
  type RiskLevel,
  type RiskVector,
} from "./schema";

const textEncoder = new TextEncoder();
const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

const GENERATED_PATTERNS = [
  /(?:^|\/)dist\//i,
  /(?:^|\/)build\//i,
  /(?:^|\/)generated\//i,
  /(?:^|\/)__generated__(?:\/|$)/i,
  /(?:^|\/)vendor\//i,
  /\.generated\./i,
  /\.gen\.[^/]+$/i,
  /\.g\.dart$/i,
  /\.pb\.(?:go|cc|h|py|ts)$/i,
  /_generated\.go$/i,
  /\.min\.(?:js|css)$/i,
  /(?:^|\/)coverage\//i,
];

const LOCKFILE_PATTERNS = [
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)bun\.lockb?$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)poetry\.lock$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)composer\.lock$/,
  /(?:^|\/)Pipfile\.lock$/,
  /(?:^|\/)uv\.lock$/,
  /(?:^|\/)flake\.lock$/,
  /(?:^|\/)pubspec\.lock$/,
  /(?:^|\/)packages\.lock\.json$/,
  /(?:^|\/)gradle\.lockfile$/,
  /(?:^|\/)gradle\/dependency-locks\/[^/]+\.lockfile$/,
  /(?:^|\/)go\.sum$/,
];

type SignalKind =
  | "authentication"
  | "authorization"
  | "migration"
  | "concurrency"
  | "public_api"
  | "configuration"
  | "dependency";

const SIGNALS: readonly {
  kind: SignalKind;
  pattern: RegExp;
  reason: string;
  severity: "medium" | "high";
}[] = [
  {
    kind: "authentication",
    pattern: /\b(?:oauth|login|session|authenticate|credential|token)\b/i,
    reason:
      "Authentication behavior changes require explicit failure-path reasoning.",
    severity: "high",
  },
  {
    kind: "authorization",
    pattern:
      /\b(?:authoriz|permission|maintainer|role|scope|access[_ -]?control)\b/i,
    reason:
      "Authorization changes can alter who may perform a protected action.",
    severity: "high",
  },
  {
    kind: "migration",
    pattern:
      /\b(?:migration|alter\s+table|create\s+table|drop\s+column|schema)\b/i,
    reason:
      "Database or migration changes need rollout and rollback reasoning.",
    severity: "high",
  },
  {
    kind: "concurrency",
    pattern:
      /\b(?:transaction|mutex|semaphore|lock|race|atomic|concurr|promise\.all|queue)\b/i,
    reason:
      "Concurrency-sensitive behavior needs ordering and retry reasoning.",
    severity: "high",
  },
  {
    kind: "public_api",
    pattern: /\b(?:route|endpoint|handler|public\s+api|request|response)\b/i,
    reason: "A public interface or request path changed.",
    severity: "medium",
  },
  {
    kind: "configuration",
    pattern: /\b(?:config|environment|process\.env|feature[_ -]?flag)\b/i,
    reason: "Runtime configuration behavior changed.",
    severity: "medium",
  },
  {
    kind: "dependency",
    pattern: /\b(?:dependency|dependencies|devDependencies)\b/i,
    reason: "Dependency behavior or composition changed.",
    severity: "medium",
  },
];

function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

function isLockfile(path: string): boolean {
  return LOCKFILE_PATTERNS.some((pattern) => pattern.test(path));
}

function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(
    path,
  );
}

function isUnusualPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    /[\r\n]/.test(path) ||
    path.startsWith("-") ||
    /[\u0001-\u001f\u007f]/.test(path)
  );
}

function areaFor(path: string): string {
  const clean = path.replace(/^\.\//, "");
  const segments = clean.split("/");
  if (segments.length > 1) {
    return segments[0] ?? "root";
  }
  const extension = clean.includes(".") ? clean.split(".").pop() : undefined;
  return extension === undefined ? "root" : `${extension} files`;
}

function compactEvidence(lines: string[]): string {
  const evidence = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  return (evidence || "Changed lines in bounded patch hunk").slice(0, 500);
}

function parseAnchors(file: PatchFile, firstAnchorIndex: number): DiffAnchor[] {
  if (file.kind !== "text" || file.patch === undefined) {
    return [];
  }

  const anchors: DiffAnchor[] = [];
  let current:
    | {
        header: string;
        oldStart: number;
        newStart: number;
        changed: string[];
      }
    | undefined;

  const flush = () => {
    if (current === undefined || current.changed.length === 0) {
      return;
    }
    anchors.push({
      id: `a${String(firstAnchorIndex + anchors.length)}`,
      file: file.path,
      hunkHeader: current.header.slice(0, 500),
      oldStart: current.oldStart,
      newStart: current.newStart,
      changedLines: current.changed.length,
      evidence: compactEvidence(current.changed),
    });
  };

  for (const line of file.patch.split("\n")) {
    const match = HUNK_PATTERN.exec(line);
    if (match !== null) {
      flush();
      current = {
        header: line,
        oldStart: Number(match[1]),
        newStart: Number(match[2]),
        changed: [],
      };
      continue;
    }
    if (
      current !== undefined &&
      ((line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")))
    ) {
      current.changed.push(line.slice(1));
    }
  }
  flush();
  return anchors;
}

function classify(
  vector: RiskVector,
  stats: { files: number; changedLines: number; hardLimitHit: boolean },
): RiskLevel {
  if (stats.hardLimitHit || stats.files >= 80 || stats.changedLines >= 5_000) {
    return "mega";
  }
  if (
    vector.sensitiveSurface >= 4 ||
    vector.migration >= 4 ||
    vector.concurrency >= 4
  ) {
    return "high_risk";
  }
  if (stats.files >= 2 || stats.changedLines >= 80 || vector.total >= 5) {
    return "medium";
  }
  return "small";
}

export function analyzePullRequestPatch(
  rawPatch: unknown,
  rawLimits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS,
): AnalysisSnapshot {
  const patch = PullRequestPatchSchema.parse(rawPatch);
  const limits = AnalysisLimitsSchema.parse(rawLimits);
  const generatedFiles = patch.files.filter((file) => isGenerated(file.path));
  const lockfiles = patch.files.filter((file) => isLockfile(file.path));
  const binaryFiles = patch.files.filter((file) => file.kind === "binary");
  const symlinks = patch.files.filter((file) => file.kind === "symlink");
  const unusualPaths = patch.files.filter((file) => isUnusualPath(file.path));
  const relevantFiles = patch.files.filter(
    (file) => !isGenerated(file.path) && !isLockfile(file.path),
  );
  const limitsHit = new Set<AnalysisSnapshot["limitsHit"][number]>();
  const hardLimitHit = {
    value: false,
  };

  if (relevantFiles.length > limits.maximumFiles) {
    limitsHit.add("file_count");
    hardLimitHit.value = true;
  }

  let patchBytes = 0;
  let changedLines = 0;
  let anchorIndex = 0;
  const anchors: DiffAnchor[] = [];
  const analyzedFiles: PatchFile[] = [];

  for (const file of relevantFiles.slice(0, limits.maximumFiles)) {
    if (file.kind !== "text" || file.patch === undefined) {
      analyzedFiles.push(file);
      continue;
    }
    const fileBytes = textEncoder.encode(file.patch).byteLength;
    if (fileBytes > limits.maximumFilePatchBytes) {
      limitsHit.add("file_patch_bytes");
      hardLimitHit.value = true;
      continue;
    }
    if (patchBytes + fileBytes > limits.maximumPatchBytes) {
      limitsHit.add("total_patch_bytes");
      hardLimitHit.value = true;
      break;
    }
    if (
      changedLines + file.additions + file.deletions >
      limits.maximumChangedLines
    ) {
      limitsHit.add("changed_lines");
      hardLimitHit.value = true;
      break;
    }

    patchBytes += fileBytes;
    changedLines += file.additions + file.deletions;
    const fileAnchors = parseAnchors(file, anchorIndex);
    anchorIndex += fileAnchors.length;
    anchors.push(...fileAnchors);
    analyzedFiles.push(file);
  }

  for (const file of generatedFiles) {
    if (
      file.patch !== undefined &&
      textEncoder.encode(file.patch).byteLength > limits.maximumFilePatchBytes
    ) {
      limitsHit.add("generated_patch_skipped");
    }
  }

  const areaMap = new Map<string, Set<string>>();
  for (const file of analyzedFiles) {
    const area = areaFor(file.path);
    const files = areaMap.get(area) ?? new Set<string>();
    files.add(file.path);
    areaMap.set(area, files);
  }

  const behavioralChanges: AnalysisSnapshot["behavioralChanges"] = [];
  const risks: AnalysisSnapshot["risks"] = [];
  const seenBehavior = new Set<string>();
  const seenRisk = new Set<string>();

  for (const anchor of anchors) {
    const signalText = `${anchor.file}\n${anchor.evidence}`;
    const matched = SIGNALS.filter((signal) => signal.pattern.test(signalText));
    if (matched.length === 0) {
      behavioralChanges.push({
        kind: "behavior",
        description: "Observable behavior changed in this bounded patch hunk.",
        anchorId: anchor.id,
      });
      continue;
    }

    for (const signal of matched) {
      const behaviorKey = `${anchor.id}:${signal.kind}`;
      if (!seenBehavior.has(behaviorKey)) {
        behavioralChanges.push({
          kind:
            signal.kind === "public_api"
              ? "api"
              : signal.kind === "dependency"
                ? "dependency"
                : signal.kind,
          description: signal.reason,
          anchorId: anchor.id,
        });
        seenBehavior.add(behaviorKey);
      }
      const riskKey = `${anchor.id}:${signal.kind}`;
      if (!seenRisk.has(riskKey)) {
        risks.push({
          kind: signal.kind,
          severity: signal.severity,
          reason: signal.reason,
          anchorId: anchor.id,
        });
        seenRisk.add(riskKey);
      }
    }
  }

  const testAnchors = anchors.filter((anchor) => isTestFile(anchor.file));
  const productionAnchors = anchors.filter(
    (anchor) => !isTestFile(anchor.file),
  );
  const testSignals: AnalysisSnapshot["testSignals"] =
    testAnchors.length > 0
      ? testAnchors.map((anchor) => ({
          kind: "tests_changed" as const,
          description: "A bounded test hunk changed alongside the patch.",
          anchorId: anchor.id,
        }))
      : productionAnchors.length > 0
        ? [
            {
              kind: "no_tests_changed" as const,
              description:
                "No changed test hunk was present in the bounded patch.",
            },
          ]
        : [];

  if (testAnchors.length === 0 && productionAnchors.length > 0) {
    const first = productionAnchors[0];
    if (first !== undefined) {
      risks.push({
        kind: "untested_behavior",
        severity: "low",
        reason:
          "The bounded patch contains behavior changes but no changed test hunk.",
        anchorId: first.id,
      });
    }
  }

  const highKinds = new Set(
    risks.filter((risk) => risk.severity === "high").map((risk) => risk.kind),
  );
  const vectorWithoutTotal = {
    scope: Math.min(5, Math.ceil(analyzedFiles.length / 2)),
    sensitiveSurface: Math.min(
      5,
      (highKinds.has("authentication") ? 3 : 0) +
        (highKinds.has("authorization") ? 3 : 0),
    ),
    migration: highKinds.has("migration") ? 5 : 0,
    concurrency: highKinds.has("concurrency") ? 5 : 0,
    testGap: productionAnchors.length > 0 && testAnchors.length === 0 ? 2 : 0,
    unverifiable: Math.min(
      5,
      binaryFiles.length + symlinks.length + unusualPaths.length,
    ),
  };
  const riskVector: RiskVector = {
    ...vectorWithoutTotal,
    total: Object.values(vectorWithoutTotal).reduce(
      (sum, value) => sum + value,
      0,
    ),
  };
  const riskLevel = classify(riskVector, {
    files: relevantFiles.length,
    changedLines,
    hardLimitHit:
      hardLimitHit.value || relevantFiles.length >= limits.megaFileThreshold,
  });

  const snapshot = {
    schemaVersion: "1" as const,
    analyzerVersion: "bounded-diff-v1" as const,
    baseSha: patch.baseSha,
    headSha: patch.headSha,
    summary:
      riskLevel === "mega"
        ? `Bounded analysis found ${String(relevantFiles.length)} review-relevant files; split or narrow the pull request before proof.`
        : `Bounded analysis found ${String(analyzedFiles.length)} review-relevant files and classified the change as ${riskLevel}.`,
    riskLevel,
    riskVector,
    changedAreas: [...areaMap.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([area, files]) => ({ area, files: [...files].sort() })),
    behavioralChanges,
    risks,
    testSignals,
    anchors,
    generatedFiles: generatedFiles.map((file) => file.path).sort(),
    lockfiles: lockfiles.map((file) => file.path).sort(),
    binaryFiles: binaryFiles.map((file) => file.path).sort(),
    symlinks: symlinks.map((file) => file.path).sort(),
    unusualPaths: unusualPaths.map((file) => file.path).sort(),
    limitsHit: [...limitsHit].sort(),
    analyzedFileCount: analyzedFiles.length,
    nonGeneratedChangedLines: changedLines,
    generatedChangedLines: generatedFiles.reduce(
      (sum, file) => sum + file.additions + file.deletions,
      0,
    ),
  };

  return AnalysisSnapshotSchema.parse(snapshot);
}
