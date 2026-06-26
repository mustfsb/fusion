import os from "node:os";
import path from "node:path";
import type { SpeculativePathResolutionTrace } from "../types.js";

const CACHE_NAMESPACE = "opencode-fusion-council";
const SPECULATIVE_RUNS_DIR = "speculative-runs";
export const DEFAULT_PANEL_COUNT = 3;

/**
 * Canonical resolver version. Any change to how candidate workspaces are
 * located must bump this so the runtime trace makes the active strategy
 * unambiguous.
 */
export const SPECULATIVE_RESOLVER_VERSION = "external_staging_v1" as const;

/**
 * Environment override for the external staging cache root. When set, candidate
 * workspaces are staged under `<root>/speculative-runs/<runId>` (the namespace
 * directory is skipped). Used by integration tests and constrained sandboxes.
 */
export const STAGING_CACHE_ROOT_ENV = "FUSION_SPECULATIVE_CACHE_ROOT";

export type SpeculativeWorkspacePaths = {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalStagingDir: string;
  /** Isolated main candidate workspace (external, never the source workspace). Optional for legacy speculative flow. */
  mainWorkspacePath?: string;
  panelWorkspacePaths: [string, string, string];
};

export type ExternalStagingRootOptions = {
  homedir?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  xdgCacheHome?: string;
  /**
   * Explicit cache root override. Takes precedence over platform defaults.
   * Falls back to the `FUSION_SPECULATIVE_CACHE_ROOT` env var. Resolves to
   * `<cacheRoot>/speculative-runs`.
   */
  cacheRoot?: string;
};

/**
 * Resolve the persistent cross-platform external cache root for speculative
 * candidate workspaces (without the per-run suffix).
 */
export function resolveExternalStagingRoot(options: ExternalStagingRootOptions = {}): string {
  const platform = options.platform ?? os.platform();
  const homedir = options.homedir ?? os.homedir();

  const cacheRoot = options.cacheRoot ?? process.env[STAGING_CACHE_ROOT_ENV];
  if (cacheRoot) {
    return path.join(cacheRoot, SPECULATIVE_RUNS_DIR);
  }

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Caches", CACHE_NAMESPACE, SPECULATIVE_RUNS_DIR);
  }

  if (platform === "win32") {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    const base = localAppData ?? path.join(homedir, "AppData", "Local");
    return path.join(base, CACHE_NAMESPACE, SPECULATIVE_RUNS_DIR);
  }

  const xdgCacheHome = options.xdgCacheHome ?? process.env.XDG_CACHE_HOME;
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, CACHE_NAMESPACE, SPECULATIVE_RUNS_DIR);
  }

  return path.join(homedir, ".cache", CACHE_NAMESPACE, SPECULATIVE_RUNS_DIR);
}

export function resolveExternalStagingDir(
  runId: string,
  options: ExternalStagingRootOptions = {},
): string {
  return path.join(resolveExternalStagingRoot(options), runId);
}

export function buildPanelWorkspacePaths(
  externalStagingDir: string,
  panelCount: number = DEFAULT_PANEL_COUNT,
): [string, string, string] {
  const count = Math.max(1, Math.min(DEFAULT_PANEL_COUNT, panelCount));
  const paths = Array.from({ length: count }, (_, index) =>
    path.join(externalStagingDir, `panel-${index + 1}-workspace`),
  );
  while (paths.length < DEFAULT_PANEL_COUNT) {
    paths.push(paths[paths.length - 1] ?? path.join(externalStagingDir, "panel-1-workspace"));
  }
  return paths as [string, string, string];
}

export function buildMainWorkspacePath(externalStagingDir: string): string {
  return path.join(externalStagingDir, "main-workspace");
}

export function buildSpeculativeWorkspacePaths(input: {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  runId: string;
  panelCount?: number;
  externalStagingDir?: string;
  stagingRootOptions?: ExternalStagingRootOptions;
}): SpeculativeWorkspacePaths {
  const sourceWorkspace = path.resolve(input.sourceWorkspace);
  const sourceArtifactDir = path.resolve(input.sourceArtifactDir);
  const externalStagingDir = path.resolve(
    input.externalStagingDir ?? resolveExternalStagingDir(input.runId, input.stagingRootOptions),
  );
  return {
    sourceWorkspace,
    sourceArtifactDir,
    externalStagingDir,
    mainWorkspacePath: buildMainWorkspacePath(externalStagingDir),
    panelWorkspacePaths: buildPanelWorkspacePaths(externalStagingDir, input.panelCount),
  };
}

/**
 * Build the canonical speculative path-resolution trace from resolved paths.
 * This is the ONLY supported way to describe where candidate workspaces live;
 * it always reports `external_staging_v1`.
 */
export function buildSpeculativePathResolutionTrace(input: {
  paths: SpeculativeWorkspacePaths;
  runtimeModulePath?: string;
}): SpeculativePathResolutionTrace {
  return {
    sourceWorkspace: input.paths.sourceWorkspace,
    sourceArtifactDir: input.paths.sourceArtifactDir,
    externalCandidateStagingDir: input.paths.externalStagingDir,
    mainWorkspacePath: input.paths.mainWorkspacePath,
    panelWorkspacePaths: [...input.paths.panelWorkspacePaths],
    resolverVersion: SPECULATIVE_RESOLVER_VERSION,
    runtimeModulePath: input.runtimeModulePath,
  };
}

/**
 * Defensive pre-copy assertion. Aborts speculative preparation if the external
 * staging directory or any panel workspace resolves inside the source
 * workspace. There is no fallback to source-side candidate workspaces: this
 * throws so the caller surfaces the diagnostic instead of silently degrading.
 */
export function assertPanelWorkspacesExternal(input: {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalStagingDir: string;
  mainWorkspacePath?: string;
  panelWorkspacePaths: string[];
  resolverVersion?: string;
}): void {
  const source = path.resolve(input.sourceWorkspace);
  const resolverVersion = input.resolverVersion ?? SPECULATIVE_RESOLVER_VERSION;

  const fail = (offending: string, what: string): never => {
    throw new Error(
      [
        `Speculative preparation aborted: ${what} resolves inside the source workspace.`,
        "Candidate project copies must always be external; refusing to fall back to source-side candidate workspaces.",
        `Resolver version: ${resolverVersion}`,
        `Source workspace: ${source}`,
        `Source artifact directory: ${path.resolve(input.sourceArtifactDir)}`,
        `External candidate staging directory: ${path.resolve(input.externalStagingDir)}`,
        `Offending path: ${path.resolve(offending)}`,
      ].join("\n"),
    );
  };

  if (isPathContainedWithin(input.externalStagingDir, source)) {
    fail(input.externalStagingDir, "external candidate staging directory");
  }
  if (input.mainWorkspacePath && isPathContainedWithin(input.mainWorkspacePath, source)) {
    fail(input.mainWorkspacePath, "main candidate workspace");
  }
  for (const panel of input.panelWorkspacePaths) {
    if (isPathContainedWithin(panel, source)) {
      fail(panel, "panel workspace");
    }
  }
}

/**
 * Separator-aware containment check using normalized absolute paths.
 * Returns true when `candidatePath` is `rootPath` or a descendant of it.
 */
export function isPathContainedWithin(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
