import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, statSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CandidateWorkspaceInfo,
  IsolationCapability,
} from "../types.js";
import {
  DEFAULT_PANEL_COUNT,
  isPathContainedWithin,
  type SpeculativeWorkspacePaths,
} from "./speculativeWorkspacePaths.js";
import { PANEL_OUTPUT_DIR_NAME } from "./speculativeBuild.js";

const execFileAsync = promisify(execFile);

/**
 * Directory names that are clearly generated, unsafe to copy, or run-artifact
 * roots. These are excluded from candidate workspace copies. Source files that
 * happen to be untracked are NOT excluded — only generated/unsafe directories.
 */
export const EXCLUDED_DIR_NAMES = new Set<string>([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".fusion",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "obj",
]);

/**
 * Directory name patterns that mark run-scoped Fusion artifact roots. We never
 * copy these into a candidate workspace because doing so could recurse into the
 * active run's own artifact directory.
 */
export const EXCLUDED_DIR_PATTERNS: RegExp[] = [/^\.opencode$/];

export { DEFAULT_PANEL_COUNT };

export type CreateCandidateWorkspacesInput = {
  paths: SpeculativeWorkspacePaths;
  panelCount?: number;
  /**
   * Optional override for the now-clock (used by tests with fake timers).
   */
  now?: () => Date;
  /**
   * Optional override for git exec (used by tests to simulate git-unavailable).
   */
  gitExec?: (args: string[], cwd: string) => Promise<string | undefined>;
};

export type CandidateWorkspacePreflightResult = {
  ok: boolean;
  workspaces: CandidateWorkspaceInfo[];
  baselineManifestPath: string;
  baselineSummaryPath: string;
  isolationCapability: IsolationCapability;
  limitation?: string;
  diagnostic?: string;
};

export type ImmutableSourceSnapshotResult = {
  sourceSnapshotWorkspacePath: string;
  sourceSnapshotManifestPath: string;
  sourceBaselineSummaryPath: string;
  sourceFingerprint: string;
  fileCount: number;
};

type ResolvedSpeculativePaths = {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalStagingDir: string;
  panelWorkspacePaths: [string, string, string];
};

/**
 * Cross-platform candidate workspace preparation.
 *
 * Writable panel candidate workspaces are created in an external staging
 * directory outside the source workspace. Run artifacts (reports, patches,
 * baseline manifests) remain in the source-side artifact directory.
 */
export async function createCandidateWorkspaces(
  input: CreateCandidateWorkspacesInput,
): Promise<CandidateWorkspacePreflightResult> {
  const panelCount = Math.max(1, Math.min(DEFAULT_PANEL_COUNT, input.panelCount ?? DEFAULT_PANEL_COUNT));
  const paths = normalizeWorkspacePaths(input.paths, panelCount);
  const now = input.now ?? (() => new Date());

  const stagingValidation = await validateExternalStagingPaths(paths);
  if (!stagingValidation.ok) {
    return preflightFailure({
      paths,
      diagnostic: stagingValidation.diagnostic,
      isolationCapability: honestIsolationCapability({ hardLinkSafe: true, symlinkSafe: true }),
    });
  }

  const resolved = stagingValidation.resolved;
  const copyExclusions = [resolved.sourceArtifactDir, resolved.externalStagingDir];

  const sourceWalk = await walkSourceTree(resolved.sourceWorkspace, copyExclusions);
  if (sourceWalk.blockedSymlinks.length > 0) {
    return preflightFailure({
      paths,
      diagnostic: `Unsafe symlink(s) in source workspace resolve outside the source root: ${sourceWalk.blockedSymlinks.join(", ")}. Refusing to create candidate workspaces because retaining such symlinks could mutate the original workspace when written through.`,
      isolationCapability: honestIsolationCapability({ hardLinkSafe: true, symlinkSafe: false }),
    });
  }

  const baselineManifestPath = path.join(resolved.sourceArtifactDir, "baseline-manifest.json");
  const baselineSummaryPath = path.join(resolved.sourceArtifactDir, "baseline-summary.md");
  const baselineManifest = buildBaselineManifest(sourceWalk.files, resolved.sourceWorkspace, now());
  await fs.mkdir(resolved.sourceArtifactDir, { recursive: true });
  await fs.writeFile(baselineManifestPath, `${JSON.stringify(baselineManifest, null, 2)}\n`, "utf8");
  await fs.writeFile(baselineSummaryPath, renderBaselineSummary(baselineManifest, resolved.sourceWorkspace), "utf8");

  const workspaces: CandidateWorkspaceInfo[] = [];
  for (let index = 1; index <= panelCount; index += 1) {
    const workspacePath = resolved.panelWorkspacePaths[index - 1];
    const manifestPath = path.join(resolved.externalStagingDir, `panel-${index}-manifest.json`);
    const reportPath = path.join(resolved.sourceArtifactDir, `panel-${index}-report.md`);
    const patchPath = path.join(resolved.sourceArtifactDir, `panel-${index}.patch`);
    const candidateOutput = candidatePanelOutputPaths(workspacePath);

    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.mkdir(workspacePath, { recursive: true });

    const copyResult = await copySourceTree(resolved.sourceWorkspace, workspacePath, sourceWalk.files);
    if (copyResult.unsafeSymlinks.length > 0) {
      return preflightFailure({
        paths,
        diagnostic: `Unsafe symlink(s) encountered while copying into panel-${index} workspace: ${copyResult.unsafeSymlinks.join(", ")}. Candidate isolation could not be established.`,
        isolationCapability: honestIsolationCapability({ hardLinkSafe: true, symlinkSafe: false }),
      });
    }

    const inodeCheck = verifyNoSharedWritableInodes(resolved.sourceWorkspace, workspacePath, copyResult.copiedRelPaths);
    if (inodeCheck.sharedInodes.length > 0) {
      return preflightFailure({
        paths,
        diagnostic: `Candidate workspace panel-${index} shares writable inode identity with source for: ${inodeCheck.sharedInodes.slice(0, 5).join(", ")}${inodeCheck.sharedInodes.length > 5 ? ` (+${inodeCheck.sharedInodes.length - 5} more)` : ""}. Refusing to proceed because writes through the candidate could mutate the source workspace.`,
        isolationCapability: honestIsolationCapability({ hardLinkSafe: false, symlinkSafe: true }),
      });
    }

    const gitInitialized = await initCandidateGitBaseline(workspacePath, input.gitExec);

    const candidateManifest = buildBaselineManifest(
      copyResult.copiedRelPaths.map((rel) => ({ relPath: rel, absolutePath: path.join(workspacePath, rel) })),
      workspacePath,
      now(),
    );
    await fs.writeFile(manifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`, "utf8");

    workspaces.push({
      logicalPanelIndex: index,
      workspacePath,
      manifestPath,
      reportPath,
      patchPath,
      gitInitialized,
      candidateOutputDir: candidateOutput.outputDir,
      candidateReportPath: candidateOutput.reportPath,
      candidateNotesPath: candidateOutput.notesPath,
    });
  }

  return {
    ok: true,
    workspaces,
    baselineManifestPath,
    baselineSummaryPath,
    isolationCapability: honestIsolationCapability({ hardLinkSafe: true, symlinkSafe: true }),
  };
}

export async function createImmutableSourceSnapshot(input: {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  sourceSnapshotWorkspacePath: string;
  externalStagingDir: string;
  now?: () => Date;
}): Promise<ImmutableSourceSnapshotResult> {
  const now = input.now ?? (() => new Date());
  const copyExclusions = [path.resolve(input.sourceArtifactDir), path.resolve(input.externalStagingDir)];
  const sourceWalk = await walkSourceTree(path.resolve(input.sourceWorkspace), copyExclusions);
  if (sourceWalk.blockedSymlinks.length > 0) {
    throw new Error(
      `Unsafe symlink(s) in source workspace resolve outside the source root: ${sourceWalk.blockedSymlinks.join(", ")}`,
    );
  }

  const baselineManifestPath = path.join(path.resolve(input.sourceArtifactDir), "baseline-manifest.json");
  const baselineSummaryPath = path.join(path.resolve(input.sourceArtifactDir), "baseline-summary.md");
  const baselineManifest = buildBaselineManifest(sourceWalk.files, path.resolve(input.sourceWorkspace), now());
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(baselineManifest.files), "utf8")
    .digest("hex");

  await fs.mkdir(path.resolve(input.sourceArtifactDir), { recursive: true });
  await fs.writeFile(baselineManifestPath, `${JSON.stringify(baselineManifest, null, 2)}\n`, "utf8");
  await fs.writeFile(baselineSummaryPath, renderBaselineSummary(baselineManifest, path.resolve(input.sourceWorkspace)), "utf8");

  const snapshotWorkspacePath = path.resolve(input.sourceSnapshotWorkspacePath);
  await fs.rm(snapshotWorkspacePath, { recursive: true, force: true });
  await fs.mkdir(snapshotWorkspacePath, { recursive: true });

  const copyResult = await copySourceTree(path.resolve(input.sourceWorkspace), snapshotWorkspacePath, sourceWalk.files);
  if (copyResult.unsafeSymlinks.length > 0) {
    throw new Error(
      `Unsafe symlink(s) encountered while creating immutable source snapshot: ${copyResult.unsafeSymlinks.join(", ")}`,
    );
  }

  const inodeCheck = verifyNoSharedWritableInodes(
    path.resolve(input.sourceWorkspace),
    snapshotWorkspacePath,
    copyResult.copiedRelPaths,
  );
  if (inodeCheck.sharedInodes.length > 0) {
    throw new Error(
      `Immutable source snapshot shares writable inode identity with source for: ${inodeCheck.sharedInodes.slice(0, 5).join(", ")}`,
    );
  }

  return {
    sourceSnapshotWorkspacePath: snapshotWorkspacePath,
    sourceSnapshotManifestPath: baselineManifestPath,
    sourceBaselineSummaryPath: baselineSummaryPath,
    sourceFingerprint,
    fileCount: baselineManifest.fileCount,
  };
}

export async function materializeCandidateWorkspaceFromSnapshot(input: {
  logicalPanelIndex: number;
  sourceSnapshotWorkspacePath: string;
  sourceSnapshotManifestPath: string;
  candidateWorkspacePath: string;
  candidateManifestPath: string;
  sourceArtifactDir: string;
  gitExec?: (args: string[], cwd: string) => Promise<string | undefined>;
  now?: () => Date;
}): Promise<CandidateWorkspaceInfo> {
  const now = input.now ?? (() => new Date());
  const baseline = await loadBaselineManifest(input.sourceSnapshotManifestPath);
  if (!baseline) {
    throw new Error(`Unreadable immutable source snapshot manifest: ${input.sourceSnapshotManifestPath}`);
  }

  const workspacePath = path.resolve(input.candidateWorkspacePath);
  await fs.rm(workspacePath, { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });

  const sourceFiles = baseline.files.map((file) => ({
    relPath: file.relPath,
    absolutePath: path.join(path.resolve(input.sourceSnapshotWorkspacePath), file.relPath),
  }));
  const copyResult = await copySourceTree(path.resolve(input.sourceSnapshotWorkspacePath), workspacePath, sourceFiles);
  if (copyResult.unsafeSymlinks.length > 0) {
    throw new Error(
      `Unsafe symlink(s) encountered while materializing panel-${input.logicalPanelIndex}: ${copyResult.unsafeSymlinks.join(", ")}`,
    );
  }

  const inodeCheck = verifyNoSharedWritableInodes(
    path.resolve(input.sourceSnapshotWorkspacePath),
    workspacePath,
    copyResult.copiedRelPaths,
  );
  if (inodeCheck.sharedInodes.length > 0) {
    throw new Error(
      `Candidate workspace panel-${input.logicalPanelIndex} shares writable inode identity with immutable snapshot for: ${inodeCheck.sharedInodes.slice(0, 5).join(", ")}`,
    );
  }

  const gitInitialized = await initCandidateGitBaseline(workspacePath, input.gitExec);
  const candidateManifest = buildBaselineManifest(
    copyResult.copiedRelPaths.map((rel) => ({ relPath: rel, absolutePath: path.join(workspacePath, rel) })),
    workspacePath,
    now(),
  );
  await fs.writeFile(path.resolve(input.candidateManifestPath), `${JSON.stringify(candidateManifest, null, 2)}\n`, "utf8");

  const candidateOutput = candidatePanelOutputPaths(workspacePath);
  return {
    logicalPanelIndex: input.logicalPanelIndex,
    workspacePath,
    manifestPath: path.resolve(input.candidateManifestPath),
    reportPath: path.join(path.resolve(input.sourceArtifactDir), `panel-${input.logicalPanelIndex}-report.md`),
    patchPath: path.join(path.resolve(input.sourceArtifactDir), `panel-${input.logicalPanelIndex}.patch`),
    gitInitialized,
    candidateOutputDir: candidateOutput.outputDir,
    candidateReportPath: candidateOutput.reportPath,
    candidateNotesPath: candidateOutput.notesPath,
  };
}

function normalizeWorkspacePaths(
  paths: SpeculativeWorkspacePaths,
  panelCount: number,
): SpeculativeWorkspacePaths {
  return {
    sourceWorkspace: path.resolve(paths.sourceWorkspace),
    sourceArtifactDir: path.resolve(paths.sourceArtifactDir),
    externalStagingDir: path.resolve(paths.externalStagingDir),
    panelWorkspacePaths: paths.panelWorkspacePaths.slice(0, panelCount) as [string, string, string],
  };
}

async function validateExternalStagingPaths(
  paths: SpeculativeWorkspacePaths,
): Promise<{ ok: true; resolved: ResolvedSpeculativePaths } | { ok: false; diagnostic: string }> {
  const formatFailure = (reason: string) =>
    [
      reason,
      `Source workspace: ${paths.sourceWorkspace}`,
      `Source artifact directory: ${paths.sourceArtifactDir}`,
      `Requested external staging directory: ${paths.externalStagingDir}`,
    ].join(" ");

  try {
    await fs.mkdir(paths.sourceArtifactDir, { recursive: true });
    await fs.mkdir(paths.externalStagingDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostic: formatFailure(`Failed to create external candidate staging directory: ${message}`),
    };
  }

  let resolvedSourceWorkspace: string;
  let resolvedSourceArtifactDir: string;
  let resolvedExternalStagingDir: string;
  try {
    resolvedSourceWorkspace = await fs.realpath(paths.sourceWorkspace);
    resolvedSourceArtifactDir = await fs.realpath(paths.sourceArtifactDir);
    resolvedExternalStagingDir = await fs.realpath(paths.externalStagingDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostic: formatFailure(`Failed to resolve speculative workspace paths: ${message}`),
    };
  }

  if (isPathContainedWithin(resolvedExternalStagingDir, resolvedSourceWorkspace)) {
    return {
      ok: false,
      diagnostic: formatFailure(
        "External candidate staging directory resolves inside the source workspace. Refusing to create candidate workspaces in the source tree.",
      ),
    };
  }

  const resolvedPanelPaths: string[] = [];
  for (const panelWorkspacePath of paths.panelWorkspacePaths) {
    if (isPathContainedWithin(panelWorkspacePath, resolvedSourceWorkspace)) {
      return {
        ok: false,
        diagnostic: formatFailure(
          `Panel workspace ${panelWorkspacePath} resolves inside the source workspace. Candidate workspaces must be external.`,
        ),
      };
    }

    let resolvedPanelPath: string;
    try {
      await fs.mkdir(panelWorkspacePath, { recursive: true });
      resolvedPanelPath = await fs.realpath(panelWorkspacePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        diagnostic: formatFailure(`Failed to create panel workspace ${panelWorkspacePath}: ${message}`),
      };
    }

    if (isPathContainedWithin(resolvedPanelPath, resolvedSourceWorkspace)) {
      return {
        ok: false,
        diagnostic: formatFailure(
          `Panel workspace ${panelWorkspacePath} resolves inside the source workspace through a symlink. Candidate workspaces must be external.`,
        ),
      };
    }

    for (const otherPanelPath of resolvedPanelPaths) {
      if (
        isPathContainedWithin(resolvedPanelPath, otherPanelPath)
        || isPathContainedWithin(otherPanelPath, resolvedPanelPath)
      ) {
        return {
          ok: false,
          diagnostic: formatFailure(
            `Panel workspace ${panelWorkspacePath} overlaps another panel workspace. Each candidate workspace must be isolated.`,
          ),
        };
      }
    }

    resolvedPanelPaths.push(resolvedPanelPath);
  }

  return {
    ok: true,
    resolved: {
      sourceWorkspace: resolvedSourceWorkspace,
      sourceArtifactDir: resolvedSourceArtifactDir,
      externalStagingDir: resolvedExternalStagingDir,
      panelWorkspacePaths: paths.panelWorkspacePaths,
    },
  };
}

/**
 * Build an honest isolation capability record.
 */
export function honestIsolationCapability(input: {
  hardLinkSafe: boolean;
  symlinkSafe: boolean;
  limitation?: string;
}): IsolationCapability {
  return {
    nativeCwdScoped: false,
    writeBoundaryScoped: false,
    hardLinkSafe: input.hardLinkSafe,
    symlinkSafe: input.symlinkSafe,
    verified: input.hardLinkSafe && input.symlinkSafe,
    limitation: input.limitation ?? "OpenCode task tool does not expose per-task CWD or path-scoped write permissions. Isolation is enforced at the directory level (separate workspace copies, no hard links, symlink safety) plus prompt-level write instructions, not by runtime CWD/write scoping.",
  };
}

function preflightFailure(input: {
  paths: SpeculativeWorkspacePaths;
  diagnostic: string;
  isolationCapability: IsolationCapability;
}): CandidateWorkspacePreflightResult {
  return {
    ok: false,
    workspaces: [],
    baselineManifestPath: path.join(input.paths.sourceArtifactDir, "baseline-manifest.json"),
    baselineSummaryPath: path.join(input.paths.sourceArtifactDir, "baseline-summary.md"),
    isolationCapability: input.isolationCapability,
    diagnostic: input.diagnostic,
  };
}

type SourceFileEntry = { relPath: string; absolutePath: string };

type SourceWalkResult = {
  files: SourceFileEntry[];
  blockedSymlinks: string[];
};

async function walkSourceTree(sourceRoot: string, copyExclusions: string[]): Promise<SourceWalkResult> {
  const files: SourceFileEntry[] = [];
  const blockedSymlinks: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (shouldExcludePath(currentDir, sourceRoot, copyExclusions)) {
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue;
        if (EXCLUDED_DIR_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
        const childDir = path.join(currentDir, entry.name);
        if (shouldExcludePath(childDir, sourceRoot, copyExclusions)) continue;
        if (entry.isSymbolicLink()) {
          const resolved = resolveSymlink(childDir, sourceRoot);
          if (resolved === "outside") {
            blockedSymlinks.push(childDir);
            continue;
          }
          if (resolved === "inside") {
            await walk(childDir);
            continue;
          }
          continue;
        }
        await walk(childDir);
        continue;
      }
      if (entry.isFile()) {
        const childPath = path.join(currentDir, entry.name);
        if (shouldExcludePath(childPath, sourceRoot, copyExclusions)) continue;
        files.push({ relPath: path.relative(sourceRoot, childPath), absolutePath: childPath });
        continue;
      }
      if (entry.isSymbolicLink()) {
        const childPath = path.join(currentDir, entry.name);
        const resolved = resolveSymlink(childPath, sourceRoot);
        if (resolved === "outside") {
          blockedSymlinks.push(childPath);
          continue;
        }
        if (resolved === "inside") {
          try {
            const stat = statSync(childPath);
            if (stat.isFile()) {
              files.push({ relPath: path.relative(sourceRoot, childPath), absolutePath: childPath });
            }
          } catch {
            // broken symlink target — skip
          }
          continue;
        }
        continue;
      }
    }
  }

  await walk(sourceRoot);
  return { files, blockedSymlinks };
}

function shouldExcludePath(absolutePath: string, sourceRoot: string, copyExclusions: string[]): boolean {
  for (const exclusion of copyExclusions) {
    if (isPathContainedWithin(absolutePath, exclusion)) {
      return true;
    }
  }
  return false;
}

function resolveSymlink(symlinkPath: string, sourceRoot: string): "inside" | "outside" | "unresolved" {
  try {
    const target = readlinkSync(symlinkPath);
    const resolved = path.resolve(path.dirname(symlinkPath), target);
    if (isPathContainedWithin(resolved, sourceRoot)) return "inside";
    return "outside";
  } catch {
    return "unresolved";
  }
}

function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name);
}

type CopyResult = {
  copiedRelPaths: string[];
  unsafeSymlinks: string[];
};

async function copySourceTree(sourceRoot: string, destRoot: string, files: SourceFileEntry[]): Promise<CopyResult> {
  const copiedRelPaths: string[] = [];
  const unsafeSymlinks: string[] = [];

  for (const file of files) {
    const destPath = path.join(destRoot, file.relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    let statSrc;
    try {
      statSrc = lstatSync(file.absolutePath);
    } catch {
      continue;
    }
    if (statSrc.isSymbolicLink()) {
      const resolved = resolveSymlink(file.absolutePath, sourceRoot);
      if (resolved === "outside") {
        unsafeSymlinks.push(file.absolutePath);
        continue;
      }
      if (resolved === "unresolved") {
        continue;
      }
      try {
        const target = readlinkSync(file.absolutePath);
        const resolvedTarget = path.resolve(path.dirname(file.absolutePath), target);
        await fs.copyFile(resolvedTarget, destPath, fs.constants.COPYFILE_EXCL);
        copiedRelPaths.push(file.relPath);
      } catch {
        // target missing — skip
      }
      continue;
    }

    if (statSrc.isFile()) {
      try {
        await fs.copyFile(file.absolutePath, destPath, fs.constants.COPYFILE_EXCL);
        copiedRelPaths.push(file.relPath);
      } catch {
        // duplicate entry — skip
      }
    }
  }

  return { copiedRelPaths, unsafeSymlinks };
}

function verifyNoSharedWritableInodes(
  sourceRoot: string,
  destRoot: string,
  relPaths: string[],
): { sharedInodes: string[] } {
  const shared: string[] = [];
  for (const rel of relPaths.slice(0, 500)) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(destRoot, rel);
    try {
      const srcStat = statSync(src);
      const destStat = statSync(dest);
      if (srcStat.dev === destStat.dev && srcStat.ino === destStat.ino) {
        shared.push(rel);
      }
    } catch {
      // ignore
    }
  }
  return { sharedInodes: shared };
}

type BaselineManifest = {
  sourcePath: string;
  generatedAt: string;
  fileCount: number;
  files: Array<{ relPath: string; sha256: string; size: number }>;
};

function buildBaselineManifest(
  files: Array<{ relPath: string; absolutePath: string }>,
  sourceRoot: string,
  now: Date,
): BaselineManifest {
  const entries: BaselineManifest["files"] = [];
  for (const file of files) {
    try {
      const content = readFileSyncSafe(file.absolutePath);
      const hash = createHash("sha256").update(content).digest("hex");
      const size = content.length;
      entries.push({ relPath: file.relPath, sha256: hash, size });
    } catch {
      // skip unreadable
    }
  }
  return {
    sourcePath: sourceRoot,
    generatedAt: now.toISOString(),
    fileCount: entries.length,
    files: entries.sort((a, b) => a.relPath.localeCompare(b.relPath)),
  };
}

function readFileSyncSafe(absPath: string): Buffer {
  return readFileSync(absPath);
}

function renderBaselineSummary(manifest: BaselineManifest, sourceRoot: string): string {
  return [
    "# Source Baseline",
    "",
    `**Source path:** ${sourceRoot}`,
    `**Generated at:** ${manifest.generatedAt}`,
    `**File count:** ${manifest.fileCount}`,
    "",
    "## Files",
    ...manifest.files.slice(0, 200).map((f) => `- ${f.relPath} (sha256=${f.sha256.slice(0, 12)}…, size=${f.size})`),
    manifest.files.length > 200 ? `... and ${manifest.files.length - 200} more` : "",
  ].filter(Boolean).join("\n") + "\n";
}

async function initCandidateGitBaseline(
  workspacePath: string,
  gitExec?: (args: string[], cwd: string) => Promise<string | undefined>,
): Promise<boolean> {
  const exec = gitExec ?? defaultGitExec;
  try {
    await exec(["init"], workspacePath);
    await exec(["config", "user.name", "fusion-candidate"], workspacePath);
    await exec(["config", "user.email", "fusion-candidate@local"], workspacePath);
    await exec(["add", "."], workspacePath);
    await exec(["commit", "-m", "fusion candidate baseline", "--allow-empty"], workspacePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultGitExec(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 * 5 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the candidate-local panel-owned output paths for a workspace. Panels
 * write their report/notes here (inside their own candidate workspace), never
 * into the real source-side artifact directory.
 */
export function candidatePanelOutputPaths(workspacePath: string): {
  outputDir: string;
  reportPath: string;
  notesPath: string;
} {
  const outputDir = path.join(workspacePath, PANEL_OUTPUT_DIR_NAME);
  return {
    outputDir,
    reportPath: path.join(outputDir, "report.md"),
    notesPath: path.join(outputDir, "notes.md"),
  };
}

export type CollectedCandidateReport = {
  logicalPanelIndex: number;
  candidateReportPath: string;
  collectedReportPath: string;
  collected: boolean;
};

export type CandidateWorkspaceActivityObservation = {
  logicalPanelIndex: number;
  source: "candidate_file_mutation" | "candidate_output_write";
  observedAt: string;
  detail: string;
};

/**
 * Collect each panel's candidate-local report into the normal source-side
 * Fusion artifact directory. Panels write only inside their own candidate
 * workspace; this copies `<workspace>/.fusion-panel-output/report.md` to the
 * source-side `panel-N-report.md` the judge reads. Missing reports are recorded
 * honestly (collected: false) rather than fabricated.
 */
export async function collectCandidateReports(
  candidateWorkspaces: CandidateWorkspaceInfo[],
): Promise<CollectedCandidateReport[]> {
  const results: CollectedCandidateReport[] = [];
  for (const ws of candidateWorkspaces) {
    const candidateReportPath = ws.candidateReportPath
      ?? candidatePanelOutputPaths(ws.workspacePath).reportPath;
    let collected = false;
    try {
      const content = await fs.readFile(candidateReportPath, "utf8");
      await fs.mkdir(path.dirname(ws.reportPath), { recursive: true });
      await fs.writeFile(ws.reportPath, content, "utf8");
      collected = true;
    } catch {
      collected = false;
    }
    results.push({
      logicalPanelIndex: ws.logicalPanelIndex,
      candidateReportPath,
      collectedReportPath: ws.reportPath,
      collected,
    });
  }
  return results;
}

export async function loadBaselineManifest(manifestPath: string): Promise<BaselineManifest | undefined> {
  try {
    const text = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(text) as BaselineManifest;
  } catch {
    return undefined;
  }
}

export async function captureBaselineManifest(workspacePath: string, now = new Date()): Promise<BaselineManifest> {
  const walk = await walkSourceTree(workspacePath, []);
  return buildBaselineManifest(walk.files, workspacePath, now);
}

export async function diffAgainstBaseline(
  workspacePath: string,
  baseline: BaselineManifest,
): Promise<{ changedFiles: string[]; addedFiles: string[]; removedFiles: string[] }> {
  const baselineByRel = new Map(baseline.files.map((f) => [f.relPath, f]));
  const seen = new Set<string>();
  const changed: string[] = [];
  const added: string[] = [];

  const walk = await walkSourceTree(workspacePath, []);
  for (const file of walk.files) {
    seen.add(file.relPath);
    const prev = baselineByRel.get(file.relPath);
    try {
      const content = readFileSyncSafe(file.absolutePath);
      const hash = createHash("sha256").update(content).digest("hex");
      if (!prev) {
        added.push(file.relPath);
      } else if (prev.sha256 !== hash) {
        changed.push(file.relPath);
      }
    } catch {
      changed.push(file.relPath);
    }
  }
  const removed = baseline.files.filter((f) => !seen.has(f.relPath)).map((f) => f.relPath);
  return { changedFiles: changed, addedFiles: added, removedFiles: removed };
}

export async function detectCandidateWorkspaceActivity(
  candidateWorkspaces: CandidateWorkspaceInfo[],
): Promise<CandidateWorkspaceActivityObservation[]> {
  const observations: CandidateWorkspaceActivityObservation[] = [];
  for (const workspace of candidateWorkspaces) {
    const mutationObservation = await detectCandidateWorkspaceMutation(workspace);
    if (mutationObservation) {
      observations.push(mutationObservation);
      continue;
    }

    const outputObservation = await detectCandidateOutputWrite(workspace);
    if (outputObservation) {
      observations.push(outputObservation);
    }
  }
  return observations;
}

async function detectCandidateOutputWrite(
  workspace: CandidateWorkspaceInfo,
): Promise<CandidateWorkspaceActivityObservation | undefined> {
  const candidates = [workspace.candidateReportPath, workspace.candidateNotesPath];
  let latest:
    | {
      observedAt: string;
      detail: string;
    }
    | undefined;
  for (const candidatePath of candidates) {
    try {
      const stats = await fs.stat(candidatePath);
      if (stats.size <= 0) continue;
      const observedAt = stats.mtime.toISOString();
      if (!latest || observedAt > latest.observedAt) {
        latest = {
          observedAt,
          detail: candidatePath,
        };
      }
    } catch {
      // Missing candidate-local output is normal until the panel writes one.
    }
  }

  if (!latest) return undefined;
  return {
    logicalPanelIndex: workspace.logicalPanelIndex,
    source: "candidate_output_write",
    observedAt: latest.observedAt,
    detail: latest.detail,
  };
}

async function detectCandidateWorkspaceMutation(
  workspace: CandidateWorkspaceInfo,
): Promise<CandidateWorkspaceActivityObservation | undefined> {
  const baseline = await loadBaselineManifest(workspace.manifestPath);
  if (!baseline) return undefined;
  const diff = await diffAgainstBaseline(workspace.workspacePath, baseline);
  const changedPaths = [...diff.changedFiles, ...diff.addedFiles, ...diff.removedFiles];
  if (changedPaths.length === 0) return undefined;
  return {
    logicalPanelIndex: workspace.logicalPanelIndex,
    source: "candidate_file_mutation",
    observedAt: new Date().toISOString(),
    detail: changedPaths.slice(0, 5).join(", "),
  };
}

export type { BaselineManifest, SpeculativeWorkspacePaths };
