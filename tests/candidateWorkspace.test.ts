import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createCandidateWorkspaces,
  diffAgainstBaseline,
  loadBaselineManifest,
} from "../src/native/candidateWorkspace.js";
import {
  buildSpeculativeWorkspacePaths,
  isPathContainedWithin,
} from "../src/native/speculativeWorkspacePaths.js";
import { buildMergePatchContractPrompt } from "../src/native/speculativeBuild.js";

let sourceRoot: string;
let externalRoot: string;
let sourceArtifactDir: string;
let externalStagingDir: string;
let workspacePaths: ReturnType<typeof buildSpeculativeWorkspacePaths>;

async function buildTestWorkspacePaths(runId = "fusion-test-run") {
  externalRoot = await mkdtemp(path.join(tmpdir(), "fusion-staging-"));
  sourceArtifactDir = path.join(sourceRoot, runId);
  externalStagingDir = path.join(externalRoot, "speculative-runs", runId);
  workspacePaths = buildSpeculativeWorkspacePaths({
    sourceWorkspace: sourceRoot,
    sourceArtifactDir,
    runId,
    externalStagingDir,
  });
  return workspacePaths;
}

beforeEach(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-source-"));

  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await mkdir(path.join(sourceRoot, "tests"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(sourceRoot, "tests", "index.test.ts"), "export {};\n", "utf8");
  await writeFile(path.join(sourceRoot, "UNTRACKED_NOT_GIT.txt"), "include me\n", "utf8");
  await writeFile(path.join(sourceRoot, ".gitignore"), "dist/\n", "utf8");
  await writeFile(path.join(sourceRoot, "package-lock.json"), "{}\n", "utf8");

  await mkdir(path.join(sourceRoot, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(sourceRoot, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");
  await mkdir(path.join(sourceRoot, "dist"), { recursive: true });
  await writeFile(path.join(sourceRoot, "dist", "bundle.js"), "ignored\n", "utf8");
  await mkdir(path.join(sourceRoot, "coverage"), { recursive: true });
  await writeFile(path.join(sourceRoot, "coverage", "lcov.info"), "ignored\n", "utf8");
  await mkdir(path.join(sourceRoot, ".opencode", "old-run"), { recursive: true });
  await writeFile(path.join(sourceRoot, ".opencode", "old-run", "artifact.txt"), "ignored\n", "utf8");

  await buildTestWorkspacePaths();
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  if (externalRoot) {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

describe("candidate workspace isolation", () => {
  test("source artifact directory inside source workspace no longer aborts when external staging is valid", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);
    expect(result.workspaces).toHaveLength(3);
    expect(isPathContainedWithin(sourceArtifactDir, sourceRoot)).toBe(true);
  });

  test("panel workspace paths are never descendants of the source workspace", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const resolvedSourceRoot = await realpath(sourceRoot);
    const resolvedExternalStagingDir = await realpath(externalStagingDir);
    const resolvedSourceArtifactDir = await realpath(sourceArtifactDir);

    for (const workspace of result.workspaces) {
      expect(isPathContainedWithin(workspace.workspacePath, resolvedSourceRoot)).toBe(false);
      expect(isPathContainedWithin(workspace.manifestPath, resolvedExternalStagingDir)).toBe(true);
      expect(isPathContainedWithin(workspace.reportPath, resolvedSourceArtifactDir)).toBe(true);
      expect(isPathContainedWithin(workspace.patchPath, resolvedSourceArtifactDir)).toBe(true);
    }
  });

  test("candidate workspaces are distinct from source and each other", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });

    expect(result.ok).toBe(true);
    expect(result.workspaces).toHaveLength(3);

    const [w1, w2, w3] = result.workspaces;
    expect(w1.workspacePath).not.toBe(sourceRoot);
    expect(w2.workspacePath).not.toBe(sourceRoot);
    expect(w3.workspacePath).not.toBe(sourceRoot);
    expect(new Set(result.workspaces.map((w) => w.workspacePath)).size).toBe(3);
  });

  test("untracked relevant source files are copied into candidate workspaces", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const copied = await readFile(path.join(result.workspaces[0].workspacePath, "UNTRACKED_NOT_GIT.txt"), "utf8");
    expect(copied).toBe("include me\n");
  });

  test("candidate copies include hidden project configuration files and lockfiles", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const candidateRoot = result.workspaces[0].workspacePath;
    await expect(readFile(path.join(candidateRoot, ".gitignore"), "utf8")).resolves.toBe("dist/\n");
    await expect(readFile(path.join(candidateRoot, "package-lock.json"), "utf8")).resolves.toBe("{}\n");
  });

  test("generated directories and the active source artifact directory are omitted from candidate workspaces", async () => {
    await mkdir(sourceArtifactDir, { recursive: true });
    await writeFile(path.join(sourceArtifactDir, "active-run-marker.txt"), "do not copy\n", "utf8");

    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const candidateRoot = result.workspaces[0].workspacePath;
    const entries = await readdir(candidateRoot);
    expect(entries).not.toContain("node_modules");
    expect(entries).not.toContain("dist");
    expect(entries).not.toContain("coverage");
    expect(entries).not.toContain(".opencode");
    expect(entries).not.toContain("fusion-test-run");
    await expect(access(path.join(candidateRoot, "fusion-test-run", "active-run-marker.txt"))).rejects.toThrow();
  });

  test("source-side baseline artifacts remain in the active artifact directory and are excluded from candidate copies", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const resolvedSourceArtifactDir = await realpath(sourceArtifactDir);
    await expect(readFile(result.baselineManifestPath, "utf8")).resolves.toContain(sourceRoot);
    expect(isPathContainedWithin(result.baselineManifestPath, resolvedSourceArtifactDir)).toBe(true);

    const candidateRoot = result.workspaces[0].workspacePath;
    await expect(access(path.join(candidateRoot, "baseline-manifest.json"))).rejects.toThrow();
  });

  test("mutating a candidate workspace cannot mutate the real source", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const candidateFile = path.join(result.workspaces[0].workspacePath, "src", "index.ts");
    await writeFile(candidateFile, "export const value = 2;\n", "utf8");

    const sourceText = await readFile(path.join(sourceRoot, "src", "index.ts"), "utf8");
    const candidateText = await readFile(candidateFile, "utf8");
    expect(sourceText).toBe("export const value = 1;\n");
    expect(candidateText).toBe("export const value = 2;\n");
  });

  test("candidate files do not share writable hard-link inode identity with source", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const sourceStat = await stat(path.join(sourceRoot, "src", "index.ts"));
    const candidateStat = await stat(path.join(result.workspaces[0].workspacePath, "src", "index.ts"));
    expect(sourceStat.ino).not.toBe(candidateStat.ino);
  });

  test("unsafe external symlink blocks the run", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "fusion-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "outside\n", "utf8");
      await symlink(outsideFile, path.join(sourceRoot, "src", "outside-link.txt"));

      const result = await createCandidateWorkspaces({ paths: workspacePaths });
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("Unsafe symlink");
      expect(result.isolationCapability.symlinkSafe).toBe(false);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("external staging directory resolving inside source through a symlink aborts preparation", async () => {
    const badStagingLink = path.join(externalRoot, "bad-staging-link");
    await symlink(sourceRoot, badStagingLink);
    const badPaths = buildSpeculativeWorkspacePaths({
      sourceWorkspace: sourceRoot,
      sourceArtifactDir,
      runId: "fusion-test-run",
      externalStagingDir: badStagingLink,
    });

    const result = await createCandidateWorkspaces({ paths: badPaths });
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toContain("External candidate staging directory resolves inside the source workspace");
    expect(result.diagnostic).toContain(sourceRoot);
    expect(result.diagnostic).toContain(sourceArtifactDir);
    expect(result.diagnostic).toContain(badStagingLink);
  });

  test("failed external staging creation aborts before candidate workspaces are created", async () => {
    const blockedRoot = path.join(externalRoot, "blocked-root");
    await writeFile(blockedRoot, "not-a-directory\n", "utf8");
    const blockedStaging = path.join(blockedRoot, "speculative-runs", "fusion-test-run");
    const blockedPaths = buildSpeculativeWorkspacePaths({
      sourceWorkspace: sourceRoot,
      sourceArtifactDir,
      runId: "fusion-test-run",
      externalStagingDir: blockedStaging,
    });

    const result = await createCandidateWorkspaces({ paths: blockedPaths });
    expect(result.ok).toBe(false);
    expect(result.workspaces).toHaveLength(0);
    expect(result.diagnostic).toContain("Failed to create external candidate staging directory");
    expect(result.diagnostic).toContain(blockedStaging);
  });

  test("git baseline is initialized when git is available", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);
    expect(result.workspaces.every((w) => w.gitInitialized)).toBe(true);
  });

  test("deterministic manifest fallback works when git is unavailable", async () => {
    const result = await createCandidateWorkspaces({
      paths: workspacePaths,
      gitExec: async () => {
        throw new Error("git unavailable");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.workspaces.every((w) => w.gitInitialized === false)).toBe(true);

    const manifest = await loadBaselineManifest(result.workspaces[0].manifestPath);
    expect(manifest).toBeDefined();
    expect(manifest?.files.some((f) => f.relPath === "src/index.ts")).toBe(true);
  });

  test("baseline manifest supports dirty-workspace diffing for the real main baseline", async () => {
    const result = await createCandidateWorkspaces({ paths: workspacePaths });
    expect(result.ok).toBe(true);

    const baseline = await loadBaselineManifest(result.baselineManifestPath);
    expect(baseline).toBeDefined();

    await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const value = 99;\n", "utf8");
    await writeFile(path.join(sourceRoot, "src", "extra.ts"), "export const extra = true;\n", "utf8");

    const diff = await diffAgainstBaseline(sourceRoot, baseline!);
    expect(diff.changedFiles).toContain("src/index.ts");
    expect(diff.addedFiles).toContain("src/extra.ts");
  });
});

describe("mocked speculative smoke shape", () => {
  test("preparation succeeds with external candidates, excludes source artifact dir, and exposes judge paths", async () => {
    const smokeSource = await mkdtemp(path.join(tmpdir(), "example-project-"));
    const smokeExternalRoot = await mkdtemp(path.join(tmpdir(), "fusion-cache-"));
    try {
      await mkdir(path.join(smokeSource, "src"), { recursive: true });
      await writeFile(path.join(smokeSource, "src", "index.ts"), "export const value = 1;\n", "utf8");

      const smokeArtifactDir = path.join(smokeSource, "fusion-test-run");
      const smokeExternalStaging = path.join(smokeExternalRoot, "speculative-runs", "fusion-test-run");
      const smokePaths = buildSpeculativeWorkspacePaths({
        sourceWorkspace: smokeSource,
        sourceArtifactDir: smokeArtifactDir,
        runId: "fusion-test-run",
        externalStagingDir: smokeExternalStaging,
      });

      await mkdir(smokeArtifactDir, { recursive: true });
      await writeFile(path.join(smokeArtifactDir, "active-run-marker.txt"), "keep out of candidates\n", "utf8");

      const result = await createCandidateWorkspaces({ paths: smokePaths });
      expect(result.ok).toBe(true);
      expect(result.workspaces).toHaveLength(3);

      for (const workspace of result.workspaces) {
        expect(isPathContainedWithin(workspace.workspacePath, smokeSource)).toBe(false);
        expect(workspace.workspacePath.startsWith(smokeExternalStaging)).toBe(true);
      }

      const candidateRoot = result.workspaces[0].workspacePath;
      await expect(access(path.join(candidateRoot, "fusion-test-run"))).rejects.toThrow();

      await writeFile(path.join(candidateRoot, "src", "index.ts"), "export const value = 2;\n", "utf8");
      const sourceText = await readFile(path.join(smokeSource, "src", "index.ts"), "utf8");
      expect(sourceText).toBe("export const value = 1;\n");

      const judgePrompt = buildMergePatchContractPrompt({
        task: "Build value export",
        context: { summary: "test", files: [], omitted: [] },
        contractGate: {
          literalPublicSurface: [],
          behavioralBoundaries: [],
          consumerCompatibility: [],
          externalConsumerProbes: [],
          packageRootExports: [],
          requiredInstanceMethods: [],
          requiredTypesAndErrors: [],
          requiredOptionAndFieldNames: [],
          returnAndThrowContracts: [],
        },
        realWorkspacePath: smokeSource,
        mainBaseline: {
          status: "passed",
          workspacePath: smokeSource,
          changedFiles: ["src/index.ts"],
        },
        candidateWorkspaces: result.workspaces,
        panelCandidates: [],
        panel: [],
        quorum: { required: 2, usable: 3, total: 3, degraded: false, failedPanels: [] },
        sourceArtifactDir: smokeArtifactDir,
        externalCandidateStagingDir: smokeExternalStaging,
        mergePatchContractPath: path.join(smokeArtifactDir, "merge-patch-contract.full.md"),
      });

      expect(judgePrompt).toContain(smokeExternalStaging);
      expect(judgePrompt).toContain(result.workspaces[0].workspacePath);
      expect(judgePrompt).toContain(smokeArtifactDir);
    } finally {
      await rm(smokeSource, { recursive: true, force: true });
      await rm(smokeExternalRoot, { recursive: true, force: true });
    }
  });
});
