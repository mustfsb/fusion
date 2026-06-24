import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertPanelWorkspacesExternal,
  buildSpeculativePathResolutionTrace,
  buildSpeculativeWorkspacePaths,
  isPathContainedWithin,
  resolveExternalStagingDir,
  resolveExternalStagingRoot,
} from "../src/native/speculativeWorkspacePaths.js";

describe("external candidate staging root resolver", () => {
  test("selects macOS cache location", () => {
    expect(resolveExternalStagingRoot({
      platform: "darwin",
      homedir: "/Users/tester",
    })).toBe("/Users/tester/Library/Caches/opencode-fusion-council/speculative-runs");
  });

  test("selects Windows LOCALAPPDATA location", () => {
    expect(resolveExternalStagingRoot({
      platform: "win32",
      homedir: "C:\\Users\\tester",
      localAppData: "C:\\Users\\tester\\AppData\\Local",
    })).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "opencode-fusion-council", "speculative-runs"));
  });

  test("selects Linux XDG_CACHE_HOME location", () => {
    expect(resolveExternalStagingRoot({
      platform: "linux",
      homedir: "/home/tester",
      xdgCacheHome: "/custom/cache",
    })).toBe("/custom/cache/opencode-fusion-council/speculative-runs");
  });

  test("falls back to ~/.cache on Linux without XDG_CACHE_HOME", () => {
    expect(resolveExternalStagingRoot({
      platform: "linux",
      homedir: "/home/tester",
      xdgCacheHome: "",
    })).toBe("/home/tester/.cache/opencode-fusion-council/speculative-runs");
  });

  test("appends run id for external staging directory", () => {
    expect(resolveExternalStagingDir("fusion-test-run", {
      platform: "darwin",
      homedir: "/Users/tester",
    })).toBe("/Users/tester/Library/Caches/opencode-fusion-council/speculative-runs/fusion-test-run");
  });
});

describe("speculative workspace path builder", () => {
  test("never places panel workspaces under the source workspace", () => {
    const paths = buildSpeculativeWorkspacePaths({
      sourceWorkspace: "/tmp/example-project",
      sourceArtifactDir: "/tmp/example-project/fusion-test-run",
      runId: "fusion-test-run",
      externalStagingDir: "/tmp/fusion-cache/speculative-runs/fusion-test-run",
    });

    expect(paths.panelWorkspacePaths).toEqual([
      "/tmp/fusion-cache/speculative-runs/fusion-test-run/panel-1-workspace",
      "/tmp/fusion-cache/speculative-runs/fusion-test-run/panel-2-workspace",
      "/tmp/fusion-cache/speculative-runs/fusion-test-run/panel-3-workspace",
    ]);

    for (const panelWorkspacePath of paths.panelWorkspacePaths) {
      expect(isPathContainedWithin(panelWorkspacePath, paths.sourceWorkspace)).toBe(false);
    }
  });

  test("uses separator-aware containment checks", () => {
    expect(isPathContainedWithin("/tmp/project/src", "/tmp/project")).toBe(true);
    expect(isPathContainedWithin("/tmp/project-backup", "/tmp/project")).toBe(false);
  });

  test("cacheRoot override stages under <root>/speculative-runs", () => {
    expect(resolveExternalStagingRoot({ cacheRoot: "/tmp/fusion-cache" }))
      .toBe(path.join("/tmp/fusion-cache", "speculative-runs"));
    expect(resolveExternalStagingDir("fusion-test-run", { cacheRoot: "/tmp/fusion-cache" }))
      .toBe(path.join("/tmp/fusion-cache", "speculative-runs", "fusion-test-run"));
  });
});

describe("speculative path resolution trace + assertion", () => {
  const paths = buildSpeculativeWorkspacePaths({
    sourceWorkspace: "/tmp/example-project",
    sourceArtifactDir: "/tmp/example-project/fusion-test-run",
    runId: "fusion-test-run",
    externalStagingDir: "/tmp/fusion-cache/speculative-runs/fusion-test-run",
  });

  test("builds an external_staging_v1 resolution trace", () => {
    const trace = buildSpeculativePathResolutionTrace({ paths, runtimeModulePath: "/loaded/nativeCouncil.js" });
    expect(trace.resolverVersion).toBe("external_staging_v1");
    expect(trace.sourceArtifactDir).toBe("/tmp/example-project/fusion-test-run");
    expect(trace.externalCandidateStagingDir).toBe("/tmp/fusion-cache/speculative-runs/fusion-test-run");
    expect(trace.panelWorkspacePaths).toEqual(paths.panelWorkspacePaths);
    expect(trace.runtimeModulePath).toBe("/loaded/nativeCouncil.js");
  });

  test("assertion passes for fully external workspaces", () => {
    expect(() => assertPanelWorkspacesExternal({
      sourceWorkspace: paths.sourceWorkspace,
      sourceArtifactDir: paths.sourceArtifactDir,
      externalStagingDir: paths.externalStagingDir,
      panelWorkspacePaths: paths.panelWorkspacePaths,
    })).not.toThrow();
  });

  test("assertion aborts when a panel resolves inside the source workspace", () => {
    const injected = [...paths.panelWorkspacePaths];
    injected[0] = "/tmp/example-project/fusion-test-run/speculative/panel-1-workspace";
    expect(() => assertPanelWorkspacesExternal({
      sourceWorkspace: paths.sourceWorkspace,
      sourceArtifactDir: paths.sourceArtifactDir,
      externalStagingDir: paths.externalStagingDir,
      panelWorkspacePaths: injected,
    })).toThrow(/external_staging_v1/);
  });
});
