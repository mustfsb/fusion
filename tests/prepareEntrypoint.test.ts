import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fusionCouncilPlugin from "../src/plugin.js";
import {
  assertPanelWorkspacesExternal,
  buildSpeculativeWorkspacePaths,
} from "../src/native/speculativeWorkspacePaths.js";
import { TEST_RUN_ID_ASSERT, TEST_RUN_ID_NEG, TEST_RUN_ID_PREPARE } from "./fixtures/runIds.js";

/**
 * Integration test for the REAL exported `fusion_native.prepare` route used by
 * `/fusion-build`. It drives the actual plugin tool (plugin -> tool.execute ->
 * nativePrepare -> candidate workspace path generation), not a pure helper.
 */

type AnyContext = {
  directory: string;
  sessionID: string;
  messageID: string;
  agent: string;
  worktree: string;
  abort: AbortSignal;
  metadata: (input: unknown) => void;
  ask: (input: unknown) => Promise<void>;
};

function makeContext(directory: string): AnyContext {
  return {
    directory,
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

async function getFusionNativeTool() {
  // Minimal client stub: prepare never calls panel/judge models, so no real
  // model client is required.
  const plugin = await fusionCouncilPlugin({ client: {} as never } as never, undefined as never);
  const fusionNative = plugin.tool?.fusion_native;
  if (!fusionNative) throw new Error("fusion_native tool not exported by plugin");
  return fusionNative;
}

let sourceWorkspace: string;
let cacheRoot: string;
const previousCacheRoot = process.env.FUSION_SPECULATIVE_CACHE_ROOT;

beforeEach(async () => {
  sourceWorkspace = await mkdtemp(path.join(tmpdir(), "example-project-"));
  cacheRoot = await mkdtemp(path.join(tmpdir(), "fusion-cache-"));
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
  await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "example-project" }), "utf8");
});

afterEach(async () => {
  if (previousCacheRoot === undefined) delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  else process.env.FUSION_SPECULATIVE_CACHE_ROOT = previousCacheRoot;
  await Promise.all([
    rm(sourceWorkspace, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
});

describe("fusion_native.prepare real entrypoint", () => {
  test("stages candidate workspaces externally with external_staging_v1 resolver", async () => {
    const fusionNative = await getFusionNativeTool();
    const runId = TEST_RUN_ID_PREPARE;

    const raw = await fusionNative.execute(
      {
        stage: "prepare",
        task: "Add a feature to the example project.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        runId,
        // Canonical supervisor runs live under .opencode/fusion-runs/<runId>.
        traceDir: ".",
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
        saveRunArtifacts: true,
      } as never,
      makeContext(sourceWorkspace) as never,
    );

    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    const advancedRaw = await fusionNative.execute(
      {
        stage: "advance",
        runId,
        traceDir: ".",
      } as never,
      makeContext(sourceWorkspace) as never,
    );
    const advanced = JSON.parse(typeof advancedRaw === "string" ? advancedRaw : (advancedRaw as { output: string }).output);

    const sourceArtifactDir = path.join(sourceWorkspace, ".opencode", "fusion-runs", runId);
    const expectedStaging = path.join(cacheRoot, "speculative-runs", runId);
    const forbiddenSpeculativeDir = path.join(sourceArtifactDir, "speculative");

    // prepare is now minimal and returns before candidate staging starts.
    expect(result.speculative).toBeTruthy();
    expect(result.speculative.aborted).toBe(false);
    expect(result.speculative.candidateWorkspaces).toHaveLength(0);
    expect(result.sharedPanelPrompt).toBeUndefined();
    expect(result.canonicalTaskPath).toContain("canonical-task.md");
    expect(advanced.nextAction.type).toBe("start_panel");
    expect(advanced.speculative.candidateWorkspaces).toHaveLength(3);
    expect(advanced.speculative.preflightDiagnostic ?? "").not.toMatch(/recursiv|artifact/i);

    // canonical resolver identity
    expect(result.speculative.pathResolution.resolverVersion).toBe("external_staging_v1");
    expect(result.runtimeIdentity.resolverVersion).toBe("external_staging_v1");
    expect(result.runtimeIdentity.modulePath).toMatch(/nativeCouncil/);
    expect(result.speculative.pathResolution.runtimeModulePath).toMatch(/nativeCouncil/);

    // source artifact dir stays source-side; staging is external
    expect(result.speculative.sourceArtifactDir).toBe(sourceArtifactDir);
    expect(result.speculative.externalCandidateStagingDir).toBe(expectedStaging);

    // every panel workspace is external and none uses the obsolete /speculative path
    const panelPaths: string[] = advanced.speculative.candidateWorkspaces.map(
      (w: { workspacePath: string }) => w.workspacePath,
    );
    expect(panelPaths.length).toBe(3);
    for (const panelPath of panelPaths) {
      expect(panelPath.startsWith(expectedStaging + path.sep)).toBe(true);
      expect(panelPath.startsWith(sourceWorkspace + path.sep)).toBe(false);
      expect(panelPath).not.toContain(forbiddenSpeculativeDir);
      // never the obsolete <runDir>/speculative segment
      expect(panelPath).not.toMatch(new RegExp(`${runId}\\${path.sep}speculative(\\${path.sep}|$)`));
    }
    for (const resolvedPanel of result.speculative.pathResolution.panelWorkspacePaths as string[]) {
      expect(resolvedPanel).not.toContain(forbiddenSpeculativeDir);
    }

    // source artifact directory must be excluded from copied candidate content
    const firstPanel = panelPaths[0];
    const copied = await readdir(firstPanel);
    expect(copied).not.toContain(runId);
    expect(copied).toContain("package.json");
    expect(copied).toContain("src");

    // --- Dynamic per-panel execution binding (the real /fusion-build fix) ---
    const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/;

    // panel-1 execution context references an actual external candidate workspace
    const assignments = advanced.speculative.panelExecutionAssignments as Array<{
      logicalPanelIndex: number;
      executionContextPath: string;
      assignedCandidateWorkspace: string;
      prohibitedSourceWorkspace: string;
      panelOutputPath: string;
      unresolvedPlaceholderCheck: string;
      nativeCwdScoped: boolean;
      absolutePathModeRequired: boolean;
    }>;
    expect(assignments).toHaveLength(3);
    const panel1Assignment = assignments[0];
    expect(panel1Assignment.assignedCandidateWorkspace.startsWith(expectedStaging + path.sep)).toBe(true);
    expect(panel1Assignment.prohibitedSourceWorkspace).toBe(sourceWorkspace);
    expect(panel1Assignment.unresolvedPlaceholderCheck).toBe("passed");
    expect(panel1Assignment.nativeCwdScoped).toBe(false);
    expect(panel1Assignment.absolutePathModeRequired).toBe(true);

    const panel1Context = await readFile(panel1Assignment.executionContextPath, "utf8");
    expect(panel1Context).not.toMatch(PLACEHOLDER);
    expect(panel1Context).toContain(panel1Assignment.assignedCandidateWorkspace);
    expect(panel1Context).toContain(sourceWorkspace);

    // candidate-local report path is correct and lives inside the candidate workspace
    const expectedReport = path.join(panel1Assignment.assignedCandidateWorkspace, ".fusion-panel-output", "report.md");
    expect(panel1Assignment.panelOutputPath).toBe(expectedReport);

    // inline dispatch message references BOTH full files; shared task has no placeholder
    const panel1Agent = advanced.nextAction.type === "start_panel"
      ? { inlineDispatchPrompt: advanced.nextAction.prompt, sharedTaskPath: assignments[0].sharedTaskPath, executionContextPath: assignments[0].executionContextPath }
      : result.panelAgents[0];
    expect(panel1Agent.inlineDispatchPrompt).toContain(panel1Agent.executionContextPath);
    expect(panel1Agent.inlineDispatchPrompt).toContain(panel1Agent.sharedTaskPath);
    expect(panel1Agent.inlineDispatchPrompt).not.toMatch(PLACEHOLDER);
    expect(assignments[0].sharedTaskPath).toContain("shared-panel-prompt");

    // source CWD did not cause prepare to abort; no model calls were required
    expect(advanced.speculative.aborted).toBe(false);
  });

  test("aborts when external staging would resolve inside the source workspace (no source-side fallback)", async () => {
    const fusionNative = await getFusionNativeTool();
    // Point the cache root inside the source workspace to force candidate
    // workspaces inside source. The defensive assertion must abort.
    process.env.FUSION_SPECULATIVE_CACHE_ROOT = path.join(sourceWorkspace, "inside-cache");

    await expect(
      fusionNative.execute(
        {
          stage: "prepare",
          task: "Should abort.",
          mode: "build_prompt",
          panelMode: "candidate_build",
          buildStrategy: "speculative_parallel_build",
          command: "fusion-build",
          runId: TEST_RUN_ID_NEG,
          traceDir: ".",
          panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
          judgeModel: "test/judge",
          saveRunArtifacts: false,
        } as never,
        makeContext(sourceWorkspace) as never,
      ),
    ).rejects.toThrow(/inside the source workspace/i);
  });

  test("assertPanelWorkspacesExternal rejects an injected in-source panel workspace", () => {
    const paths = buildSpeculativeWorkspacePaths({
      sourceWorkspace,
      sourceArtifactDir: path.join(sourceWorkspace, "fusion-run"),
      runId: TEST_RUN_ID_ASSERT,
      externalStagingDir: path.join(cacheRoot, "speculative-runs", "fusion-run"),
    });
    // Deliberately inject one panel workspace inside the source workspace.
    const injected = [...paths.panelWorkspacePaths];
    injected[1] = path.join(sourceWorkspace, "fusion-run", "speculative", "panel-2-workspace");

    let thrown: Error | undefined;
    try {
      assertPanelWorkspacesExternal({
        sourceWorkspace: paths.sourceWorkspace,
        sourceArtifactDir: paths.sourceArtifactDir,
        externalStagingDir: paths.externalStagingDir,
        panelWorkspacePaths: injected,
        resolverVersion: "external_staging_v1",
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    const message = thrown?.message ?? "";
    expect(message).toMatch(/Resolver version: external_staging_v1/);
    expect(message).toContain(paths.sourceWorkspace);
    expect(message).toContain(paths.sourceArtifactDir);
    expect(message).toContain(paths.externalStagingDir);
    expect(message).toContain(injected[1]);
  });
});
