import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fusionCouncilPlugin from "../src/plugin.js";
import { assertValidFusionRunId, isValidFusionRunId } from "../src/native/runLocator.js";
import { nativeAdvance, nativePrepare, nativeCollect, nativeFinalize, nativeRecordMainBaseline } from "../src/native/nativeCouncil.js";
import { loadRunState, writeRunState } from "../src/native/runState.js";
import { completeCandidate } from "./fixtures/candidates.js";
import { DEFAULT_TRACE_DIR } from "../src/trace/runTrace.js";

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
  const plugin = await fusionCouncilPlugin({ client: {} as never } as never, undefined as never);
  const fusionNative = plugin.tool?.fusion_native;
  if (!fusionNative) throw new Error("fusion_native tool not exported by plugin");
  return fusionNative;
}

const PASS_SCRIPTS = {
  typecheck: "node -e \"process.exit(0)\"",
  test: "node -e \"process.exit(0)\"",
  build: "node -e \"process.exit(0)\"",
};

let sourceWorkspace: string;
let cacheRoot: string;
const previousCacheRoot = process.env.FUSION_SPECULATIVE_CACHE_ROOT;

beforeEach(async () => {
  sourceWorkspace = await mkdtemp(path.join(tmpdir(), "candidate-b-"));
  cacheRoot = await mkdtemp(path.join(tmpdir(), "fusion-cache-"));
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
});

afterEach(async () => {
  if (previousCacheRoot === undefined) delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  else process.env.FUSION_SPECULATIVE_CACHE_ROOT = previousCacheRoot;
  await Promise.all([
    rm(sourceWorkspace, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
});

describe("fusion run lifecycle guards", () => {
  test("prepare never returns an empty runId", async () => {
    const fusionNative = await getFusionNativeTool();
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "lifecycle-test", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const raw = await fusionNative.execute(
      {
        stage: "prepare",
        task: "Add a small feature.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        parallelExecutionSupported: true,
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
      } as never,
      makeContext(sourceWorkspace) as never,
    );

    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    expect(result.runId).toBeTruthy();
    expect(isValidFusionRunId(result.runId)).toBe(true);
    expect(result.traceArtifactDir).toBeTruthy();
    expect(result.runStatePath).toContain("run-state.json");
    expect(path.basename(result.traceArtifactDir)).toBe(result.runId);
    expect(path.resolve(result.traceArtifactDir)).not.toBe(path.resolve(sourceWorkspace));
  });

  test("collect rejects empty runId before reading reports", async () => {
    const fusionNative = await getFusionNativeTool();
    await expect(
      fusionNative.execute(
        {
          stage: "collect",
          runId: "",
          panelResults: [],
        } as never,
        makeContext(sourceWorkspace) as never,
      ),
    ).rejects.toThrow(/FUSION_RUN_ID_INVALID/);
  });

  test("finalize rejects empty runId", async () => {
    const fusionNative = await getFusionNativeTool();
    await expect(
      fusionNative.execute(
        { stage: "finalize", runId: "" } as never,
        makeContext(sourceWorkspace) as never,
      ),
    ).rejects.toThrow(/FUSION_RUN_ID_INVALID/);
  });

  test("mismatched run-state/run-ID pair rejects safely", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "mismatch", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export {};\n", "utf8");

    const prepare = await nativePrepare(
      {
        task: "Mismatch test.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        parallelExecutionSupported: true,
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
      },
      { cwd: sourceWorkspace },
    );

    await expect(
      nativeCollect(
        {
          runId: "fusion-20250624-999999-deadbe",
          panelResults: [],
        },
        { cwd: sourceWorkspace },
      ),
    ).rejects.toThrow(/FUSION_RUN_STATE_NOT_FOUND|FUSION_RUN_ID_INVALID/);

    void prepare;
  });

  test("old orphan root artifacts cannot be mistaken for a valid normal run via collect", async () => {
    await writeFile(path.join(sourceWorkspace, "baseline-manifest.json"), "{}\n", "utf8");
    await writeFile(path.join(sourceWorkspace, "shared-panel-prompt.full.md"), "# orphan\n", "utf8");
    await writeFile(path.join(sourceWorkspace, "panel-1-execution-context.full.md"), "# ctx\n", "utf8");

    await expect(
      nativeCollect(
        {
          runId: "",
          panelResults: [],
        },
        { cwd: sourceWorkspace, traceDir: "." },
      ),
    ).rejects.toThrow(/FUSION_RUN_ID_INVALID/);
  });

  test("prepare → collect → finalize integration uses valid locator paths", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "p-c-f", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const x = 1;\n", "utf8");

    const prepare = await nativePrepare(
      {
        task: "Integration lifecycle test.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        parallelExecutionSupported: true,
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
      },
      { cwd: sourceWorkspace },
    );

    assertValidFusionRunId(prepare.runId);
    expect(prepare.traceArtifactDir).toBe(path.join(sourceWorkspace, DEFAULT_TRACE_DIR, prepare.runId));

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: prepare.panelAgents.map((agent) => ({
          agentName: agent.agentName,
          modelId: agent.modelId,
          content: completeCandidate,
        })),
        mainBaseline: {
          status: "passed",
          workspacePath: sourceWorkspace,
          changedFiles: ["src/index.ts"],
          verification: { typecheck: "pass", test: "pass", build: "pass" },
        },
      },
      { cwd: sourceWorkspace },
    );

    expect(collect.runId).toBe(prepare.runId);

    const finalize = await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: "# Merge Patch Contract\n\n## Decision\n- adopt_main\n",
      },
      { cwd: sourceWorkspace },
    );

    expect(finalize.runId).toBe(prepare.runId);
    expect(finalize.artifactDir).toBe(prepare.traceArtifactDir);
  });
});

describe("fusion advance lifecycle", () => {
  test("main baseline start is recorded before candidate staging and panel dispatch", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "advance-fast", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const fusionNative = await getFusionNativeTool();
    const rawPrepare = await fusionNative.execute(
      {
        stage: "prepare",
        task: "Implement baseline immediately.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
      } as never,
      makeContext(sourceWorkspace) as never,
    );
    const prepare = JSON.parse(typeof rawPrepare === "string" ? rawPrepare : (rawPrepare as { output: string }).output);
    expect(prepare.speculative.candidateWorkspaces).toHaveLength(0);
    expect(prepare.sharedPanelPrompt).toBeUndefined();

    const mainBaselineStartedAt = new Date().toISOString();
    const baselineAdvance = await nativeAdvance(
      { runId: prepare.runId, mainBaselineStartedAt },
      { cwd: sourceWorkspace },
    );

    expect(baselineAdvance.nextAction.type).toBe("wait");
    expect(baselineAdvance.nextAction.delayMs).toBe(0);
    expect(baselineAdvance.speculative?.candidateWorkspaces).toHaveLength(0);

    const stateAfterBaselineStart = await loadRunState(sourceWorkspace, prepare.runId);
    expect(stateAfterBaselineStart.speculative?.mainBaseline?.startedAt).toBe(mainBaselineStartedAt);
    expect(stateAfterBaselineStart.speculative?.candidateWorkspaces).toHaveLength(0);
    expect(stateAfterBaselineStart.speculative?.candidatePreparationCompletedAt).toBeUndefined();

    const panelAdvance = await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    expect(panelAdvance.nextAction.type).toBe("start_panel");
    expect(panelAdvance.nextAction.logicalPanelIndex).toBe(1);

    const stateAfterStaging = await loadRunState(sourceWorkspace, prepare.runId);
    expect(stateAfterStaging.speculative?.candidateWorkspaces).toHaveLength(3);
    expect(stateAfterStaging.speculative?.candidatePreparationCompletedAt).toBeTruthy();

    const workspaceReadyAt = Date.parse(stateAfterStaging.speculative!.candidatePreparationCompletedAt!);
    const mainStartedAt = Date.parse(mainBaselineStartedAt);
    expect(workspaceReadyAt).toBeGreaterThanOrEqual(mainStartedAt);

    const dispatchAt = new Date().toISOString();
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelDispatches: [{ logicalPanelIndex: 1, startReason: "cascade_activity", startedAt: dispatchAt }],
      },
      { cwd: sourceWorkspace },
    );

    const stateAfterDispatch = await loadRunState(sourceWorkspace, prepare.runId);
    const firstPanelDispatchAt = stateAfterDispatch.panelAttempts?.find((attempt) => attempt.logicalPanelIndex === 1)?.dispatchAt;
    expect(firstPanelDispatchAt).toBeTruthy();
    expect(Date.parse(firstPanelDispatchAt!)).toBeGreaterThanOrEqual(mainStartedAt);
  });

  test("panel 2 starts immediately after panel 1 credible activity", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "advance-cascade", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const prepare = await nativePrepare(
      {
        task: "Cascade test.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
      },
      { cwd: sourceWorkspace },
    );

    const first = await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    expect(first.nextAction.type).toBe("start_panel");
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelDispatches: [{ logicalPanelIndex: 1, startReason: "cascade_activity", startedAt: new Date().toISOString() }],
        panelObservations: [{ logicalPanelIndex: 1, source: "candidate_output_write", observedAt: new Date().toISOString() }],
      },
      { cwd: sourceWorkspace },
    );
    const second = await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    expect(second.nextAction.type).toBe("start_panel");
    expect(second.nextAction.logicalPanelIndex).toBe(2);
    expect(second.nextAction.startReason).toBe("cascade_activity");
  });

  test("panel 3 bypasses a silent panel 2 through the fallback gate without creating panel 4", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "advance-bypass", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const prepare = await nativePrepare(
      {
        task: "Bypass silent panel 2.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
      },
      { cwd: sourceWorkspace },
    );

    await nativeAdvance(
      {
        runId: prepare.runId,
        panelDispatches: [
          { logicalPanelIndex: 1, startReason: "cascade_activity", startedAt: new Date(Date.now() - 120_000).toISOString() },
          { logicalPanelIndex: 2, startReason: "start_gate_timeout", startedAt: new Date(Date.now() - 120_000).toISOString() },
        ],
      },
      { cwd: sourceWorkspace },
    );

    const state = await loadRunState(sourceWorkspace, prepare.runId);
    state.panelAttempts = (state.panelAttempts ?? []).map((attempt) =>
      attempt.logicalPanelIndex === 2
        ? { ...attempt, startedAt: new Date(Date.now() - 120_000).toISOString(), dispatchAt: new Date(Date.now() - 120_000).toISOString() }
        : attempt);
    await writeRunState(state, sourceWorkspace);

    const next = await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    expect(next.nextAction.type).toBe("start_panel");
    expect(next.nextAction.logicalPanelIndex).toBe(3);
    expect(next.nextAction.startReason).toBe("start_gate_timeout");
    expect(next.panelAttempts.every((attempt) => attempt.logicalPanelIndex <= 3)).toBe(true);
  });

  test("judge becomes eligible with main baseline terminal plus quorum without waiting for a third panel", async () => {
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "advance-judge", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const prepare = await nativePrepare(
      {
        task: "Judge quorum test.",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        minSuccessfulPanels: 2,
      },
      { cwd: sourceWorkspace },
    );

    await nativeAdvance({ runId: prepare.runId, mainBaselineStartedAt: new Date().toISOString() }, { cwd: sourceWorkspace });
    await nativeRecordMainBaseline(
      {
        runId: prepare.runId,
        mainBaseline: {
          status: "passed",
          workspacePath: sourceWorkspace,
          changedFiles: ["src/index.ts"],
          completedAt: new Date().toISOString(),
          verification: { typecheck: "pass", test: "pass", build: "pass" },
        },
      },
      { cwd: sourceWorkspace },
    );

    const advance = await nativeAdvance(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: completeCandidate },
        ],
      },
      { cwd: sourceWorkspace },
    );

    expect(advance.nextAction.type).toBe("call_collect");
    expect(advance.judgeEligible).toBe(true);
    expect(advance.judgeEligibleAt).toBeTruthy();
  });
});
