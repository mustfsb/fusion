import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These tests spawn real OS processes (the fake OpenCode executable). Under a
// saturated machine running the full suite in parallel, process spawn/exit
// detection can lag, so use a generous timeout to avoid load-induced flakiness.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {
  bootstrapRealParallelBuild,
  superviseRun,
  type BootstrapInput,
  type SupervisorDeps,
} from "../src/native/fusionSupervisor.js";
import { loadSupervisorState } from "../src/native/supervisorState.js";
import { renderSupervisorTrace } from "../src/native/supervisorTrace.js";
import { WORKER_ID } from "../src/native/supervisorTypes.js";
import {
  createOpenCodeProcessWorkerRunner,
  type WorkerRunner,
  type SpawnedWorkerHandle,
  type WorkerSpawnSpec,
} from "../src/native/workerRunner.js";
import { createFakeNativeSubagentDispatcher } from "../src/native/nativeSubagentDispatch.js";
import type { WorkerRecord } from "../src/native/supervisorTypes.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));

let sourceRoot: string;
let traceRoot: string;
let stagingRoot: string;
let behaviorPath: string;
let runCounter = 0;
let workersRef: Record<string, WorkerRecord> = {};

function freshRunId(): string {
  runCounter += 1;
  const hex = runCounter.toString(16).padStart(6, "0");
  return `fusion-20260625-120000-${hex}`;
}

function fakeRunner(): WorkerRunner {
  return createOpenCodeProcessWorkerRunner({
    opencodeBin: process.execPath,
    buildArgs: () => [FAKE],
  });
}

async function writeBehavior(behavior: Record<string, unknown>): Promise<void> {
  await writeFile(behaviorPath, JSON.stringify(behavior), "utf8");
  process.env.FUSION_FAKE_BEHAVIOR = behaviorPath;
}

function baseInput(runId: string): BootstrapInput {
  return {
    runId,
    task: "Add a feature flag to the config loader.",
    command: "fusion-build",
    mainModel: { modelId: "prov/main-model" },
    panelModels: [{ modelId: "prov/panel-1" }, { modelId: "prov/panel-2" }, { modelId: "prov/panel-3" }],
    judgeModel: { modelId: "prov/judge-model" },
    sourceWorkspace: sourceRoot,
  };
}

function deps(runner: WorkerRunner, extra?: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    cwd: sourceRoot,
    traceDir: traceRoot,
    runner,
    skipNativeAgentValidation: true,
    syncWorkers: (workers) => {
      workersRef = workers;
    },
    nativeDispatcher: createFakeNativeSubagentDispatcher({
      behavior: () => JSON.parse(readFileSync(behaviorPath, "utf8")),
      getWorkers: () => workersRef,
      skipAgentValidation: true,
    }),
    pollIntervalMs: 15,
    autoConfirmReady: true,
    timeouts: {
      mainSoftSuspectMs: 9_000,
      mainHardTimeoutMs: 9_000,
      panelSoftSuspectMs: 9_000,
      panelHardTimeoutMs: 9_000,
      judgeSoftSuspectMs: 9_000,
      judgeHardTimeoutMs: 9_000,
    },
    ...extra,
  };
}

async function bootstrapAndRun(runId: string, runner: WorkerRunner, extra?: Partial<SupervisorDeps>) {
  await bootstrapRealParallelBuild(baseInput(runId), deps(runner, extra));
  const bootState = await loadSupervisorState(sourceRoot, runId, traceRoot);
  if (bootState) workersRef = bootState.workers;
  const state = await superviseRun(runId, deps(runner, extra));
  workersRef = state.workers;
  return state;
}

const allCompleteBehavior = (extra?: Record<string, unknown>) => ({
  [WORKER_ID.main]: { sleepMs: 200, changedFile: "src/main-impl.ts" },
  [WORKER_ID.panel(1)]: { sleepMs: 200, changedFile: "src/panel1-impl.ts" },
  [WORKER_ID.panel(2)]: { sleepMs: 200, changedFile: "src/panel2-impl.ts" },
  [WORKER_ID.panel(3)]: { sleepMs: 200, changedFile: "src/panel3-impl.ts" },
  [WORKER_ID.judge]: { sleepMs: 60, decision: "NO_PATCH_REQUIRED", writeContract: true },
  ...extra,
});

beforeEach(async () => {
  workersRef = {};
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-src-"));
  traceRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-trace-"));
  stagingRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-stage-"));
  behaviorPath = path.join(traceRoot, "behavior.json");
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = stagingRoot;
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const base = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(traceRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("hybrid_external_main_native_panels supervisor", () => {
  test("spawns main + 3 panels concurrently before any finishes; judge after all terminal; paths not inlined (props 1,5,7,8,16)", async () => {
    await writeBehavior({
      [WORKER_ID.main]: { sleepMs: 600, changedFile: "src/main-impl.ts" },
      [WORKER_ID.panel(1)]: { sleepMs: 600, changedFile: "src/panel1-impl.ts" },
      [WORKER_ID.panel(2)]: { sleepMs: 600, changedFile: "src/panel2-impl.ts" },
      [WORKER_ID.panel(3)]: { sleepMs: 600, changedFile: "src/panel3-impl.ts" },
      [WORKER_ID.judge]: { sleepMs: 60, decision: "PATCH_REQUIRED", writeContract: true, changedFile: "src/judge-fix.ts" },
    });
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, fakeRunner());

    const primary = [WORKER_ID.main, WORKER_ID.panel(1), WORKER_ID.panel(2), WORKER_ID.panel(3)].map((id) => state.workers[id]);
    const mainLaunch = new Date(state.workers[WORKER_ID.main].spawnedAt!).getTime();
    const panelLaunches = [1, 2, 3].map((i) => new Date(state.workers[WORKER_ID.panel(i)].dispatchedAt!).getTime());
    const minEnd = Math.min(...primary.map((w) => new Date(w.endedAt!).getTime()));
    expect(Math.max(mainLaunch, ...panelLaunches)).toBeLessThanOrEqual(minEnd);
    for (const w of primary) expect(w.status).toBe("completed");

    const hashes = new Set([WORKER_ID.panel(1), WORKER_ID.panel(2), WORKER_ID.panel(3)].map((id) => state.workers[id].taskArtifactHash));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(state.taskArtifactHash);
    // Main shares the same canonical task hash too.
    expect(state.workers[WORKER_ID.main].taskArtifactHash).toBe(state.taskArtifactHash);

    expect(state.concurrency.verdict).toBe("HYBRID_PARALLEL_LAUNCH_CONFIRMED");
    expect(state.concurrency.panelsLaunched).toBe(3);
    expect(state.concurrency.noPanelViaExternalCli).toBe(true);
    expect(state.concurrency.mainModelMatched).toBe(true);

    const judge = state.workers[WORKER_ID.judge];
    expect(judge.dispatchedAt).toBeDefined();
    const judgeStart = new Date(judge.dispatchedAt!).getTime();
    for (const w of primary) expect(new Date(w.endedAt!).getTime()).toBeLessThanOrEqual(judgeStart);

    const manifest = JSON.parse(await readFile(state.judge.manifestPath!, "utf8"));
    expect(manifest.panels[0].resultArtifactPath).toContain("fusion-panel-1-result.json");
    const manifestText = JSON.stringify(manifest);
    expect(manifestText).not.toContain("export const base");
    expect(manifestText.length).toBeLessThan(6000);

    expect(renderSupervisorTrace(state)).toContain("HYBRID_PARALLEL_LAUNCH_CONFIRMED");
    expect(renderSupervisorTrace(state)).toContain("Build strategy: hybrid_external_main_native_panels");
    expect(renderSupervisorTrace(state)).toContain("execution: external_opencode_cli");
    expect(renderSupervisorTrace(state)).toContain("execution: native_visible_subagent");
  });

  test("main works in isolated main workspace, never source before promotion; panels isolated (props 3,4,5,11,12)", async () => {
    await writeBehavior(allCompleteBehavior());
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, fakeRunner());

    const mainWs = state.workers[WORKER_ID.main].workspacePath;
    // Main workspace is external, not the source workspace.
    expect(mainWs.startsWith(path.resolve(sourceRoot))).toBe(false);
    expect(state.mainCandidateWorkspace).toBe(mainWs);
    // Main wrote into its isolated candidate workspace.
    expect(await exists(path.join(mainWs, "src", "main-impl.ts"))).toBe(true);
    // Promotion copied main's change into the real source workspace.
    expect(await exists(path.join(sourceRoot, "src", "main-impl.ts"))).toBe(true);
    expect(state.mainPromotion.status).toBe("promoted");
    expect(state.mainPromotion.promotedPaths).toContain("src/main-impl.ts");
    expect(state.mainPromotion.sourceUntouchedBeforePromotion).toBe(true);
    // Panel files are NOT in source workspace.
    expect(await exists(path.join(sourceRoot, "src", "panel1-impl.ts"))).toBe(false);
    expect(await exists(path.join(sourceRoot, "src", "panel2-impl.ts"))).toBe(false);
    expect(await exists(path.join(sourceRoot, "src", "panel3-impl.ts"))).toBe(false);
    // Each panel file lives in its own distinct candidate workspace.
    const panelWs = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)].workspacePath);
    for (let i = 0; i < 3; i += 1) {
      expect(panelWs[i].startsWith(path.resolve(sourceRoot))).toBe(false);
      expect(await exists(path.join(panelWs[i], "src", `panel${i + 1}-impl.ts`))).toBe(true);
    }
    const distinctWs = new Set(panelWs);
    expect(distinctWs.size).toBe(3);
  });

  test("launch phase spawns only one external main worker before any exit (prop 2)", async () => {
    await writeBehavior(allCompleteBehavior({
      [WORKER_ID.main]: { sleepMs: 600, changedFile: "src/main-impl.ts" },
      [WORKER_ID.panel(1)]: { sleepMs: 600, changedFile: "src/panel1-impl.ts" },
      [WORKER_ID.panel(2)]: { sleepMs: 600, changedFile: "src/panel2-impl.ts" },
      [WORKER_ID.panel(3)]: { sleepMs: 600, changedFile: "src/panel3-impl.ts" },
    }));
    const base = fakeRunner();
    const spawnedWorkerIds: string[] = [];
    let firstExitAt: number | undefined;
    const spy: WorkerRunner = {
      transport: base.transport,
      async spawn(spec: WorkerSpawnSpec): Promise<SpawnedWorkerHandle> {
        spawnedWorkerIds.push(spec.workerId);
        const handle = await base.spawn(spec);
        void handle.exited.then(() => {
          if (firstExitAt === undefined) firstExitAt = Date.now();
        });
        return handle;
      },
    };
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, spy);
    expect(spawnedWorkerIds).toEqual([WORKER_ID.main]);
    expect(firstExitAt).toBeDefined();
    expect(state.concurrency.verdict).toBe("HYBRID_PARALLEL_LAUNCH_CONFIRMED");
    for (let i = 1; i <= 3; i += 1) {
      expect(state.workers[WORKER_ID.panel(i)].sessionId).toMatch(/^native-session-/);
      expect(state.workers[WORKER_ID.panel(i)].executionKind).toBe("native_subagent");
    }
  });

  test("concise panel result with no prose stays usable when workspace + verification evidence exist (prop 6)", async () => {
    await writeBehavior(allCompleteBehavior());
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, fakeRunner());
    for (let i = 1; i <= 3; i += 1) {
      expect(state.workers[WORKER_ID.panel(i)].candidate?.classification).toBe("usable");
    }
  });

  test("judge applies targeted patches itself; no external patch worker exists (props 14,15,17)", async () => {
    // NO_PATCH_REQUIRED: no patch items, no patch worker.
    await writeBehavior(allCompleteBehavior());
    const runId1 = freshRunId();
    const noPatch = await bootstrapAndRun(runId1, fakeRunner());
    expect(noPatch.judge.decision).toBe("NO_PATCH_REQUIRED");
    expect(noPatch.workers[WORKER_ID.judge]).toBeDefined();
    expect(noPatch.workers["fusion-main-patch-worker"]).toBeUndefined();
    expect(noPatch.mainPromotion.status).toBe("promoted");

    // PATCH_REQUIRED: judge self-patches the real source workspace directly.
    await writeBehavior(allCompleteBehavior({
      [WORKER_ID.judge]: { sleepMs: 60, decision: "PATCH_REQUIRED", writeContract: true, changedFile: "src/judge-fix.ts" },
    }));
    const runId2 = freshRunId();
    const patched = await bootstrapAndRun(runId2, fakeRunner());
    expect(patched.judge.decision).toBe("PATCH_REQUIRED");
    expect(patched.workers["fusion-main-patch-worker"]).toBeUndefined();
    // The judge (running against the real source workspace) applied the fix itself.
    expect(await exists(path.join(sourceRoot, "src", "judge-fix.ts"))).toBe(true);
    expect(patched.judge.appliedPatchItems).toBeDefined();
    expect(patched.judge.appliedPatchItems!.length).toBeGreaterThan(0);
    expect(patched.nativeJudge?.appliedPatchSummary).toBeDefined();
  });

  test("NO_PATCH_REQUIRED cannot exist without judge success (prop 10)", async () => {
    await writeBehavior(allCompleteBehavior({ [WORKER_ID.judge]: { sleepMs: 40, outcome: "fail" } }));
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, fakeRunner());
    expect(state.workers[WORKER_ID.judge].status).toBe("failed");
    expect(state.judge.decision).toBeUndefined();
    expect(state.phase).toBe("aborted");
    expect(state.workers["fusion-main-patch-worker"]).toBeUndefined();
  });

  test("a hung panel times out without blocking the judge stage forever (prop 11)", async () => {
    await writeBehavior(allCompleteBehavior({ [WORKER_ID.panel(2)]: { outcome: "hang", changedFile: "src/panel2-impl.ts" } }));
    const runId = freshRunId();
    const shortTimeouts = { panelHardTimeoutMs: 400, panelSoftSuspectMs: 300, mainHardTimeoutMs: 9000, judgeHardTimeoutMs: 9000, mainSoftSuspectMs: 9000, judgeSoftSuspectMs: 9000 };
    const state = await bootstrapAndRun(runId, fakeRunner(), { timeouts: shortTimeouts });
    expect(state.workers[WORKER_ID.panel(2)].status).toBe("timed_out");
    expect(state.judge.dispatchedAt).toBeDefined();
    expect(state.judge.excludedPanelIndexes).toContain(2);
  });

  test("resume reuses completed workers and does not rerun valid panels (prop 12)", async () => {
    await writeBehavior(allCompleteBehavior());
    const runId = freshRunId();
    await bootstrapAndRun(runId, fakeRunner());

    const base = fakeRunner();
    const respawned: string[] = [];
    const spy: WorkerRunner = {
      transport: base.transport,
      async spawn(spec: WorkerSpawnSpec): Promise<SpawnedWorkerHandle> {
        respawned.push(spec.workerId);
        return base.spawn(spec);
      },
    };
    workersRef = (await loadSupervisorState(sourceRoot, runId, traceRoot))!.workers;
    const resumed = await superviseRun(runId, deps(spy));
    expect(respawned).toEqual([]);
    expect(resumed.phase).toBe("done");
    expect(resumed.workers[WORKER_ID.panel(1)].status).toBe("completed");
  });

  test("supervisor progresses standalone after bootstrap with no parent driver (prop 13)", async () => {
    await writeBehavior(allCompleteBehavior());
    const runId = freshRunId();
    const booted = await bootstrapRealParallelBuild(baseInput(runId), deps(fakeRunner()));
    expect(booted.phase).toBe("bootstrapping");
    for (const id of [WORKER_ID.main, WORKER_ID.panel(1)]) {
      expect(booted.workers[id].status).toBe("queued");
    }
    workersRef = booted.workers;
    const state = await superviseRun(runId, deps(fakeRunner()));
    expect(state.phase).toBe("done");
    expect(state.runLock?.pid).toBe(process.pid);
  });

  test("/fusion-no-build produces no supervisor state, so no worker can spawn (prop 20)", async () => {
    const runId = freshRunId();
    // No bootstrap was performed (planning-only path never creates state).
    const state = await loadSupervisorState(sourceRoot, runId, traceRoot);
    expect(state).toBeUndefined();
    await expect(superviseRun(runId, deps(fakeRunner()))).rejects.toThrow(/No supervisor state/);
  });

  test("no direct provider API or hidden SDK runner is introduced (prop 15)", async () => {
    const files = [
      "src/native/workerRunner.ts",
      "src/native/fusionSupervisor.ts",
      "src/native/supervisorMain.ts",
      "src/native/supervisorState.ts",
      "src/native/supervisorTypes.ts",
      "src/native/supervisorTrace.ts",
    ];
    const root = fileURLToPath(new URL("..", import.meta.url));
    let combined = "";
    for (const f of files) combined += await readFile(path.join(root, f), "utf8");
    expect(combined).not.toMatch(/from\s+["'][^"']*providers/);
    expect(combined).not.toMatch(/opencodeModelRunner/);
    expect(combined).not.toMatch(/session\.prompt/);
    expect(combined).not.toMatch(/\bfetch\s*\(/);
    expect(combined).not.toMatch(/require\(["']https?["']\)|from\s+["']node:https?["']/);
    // Confirms the transport is real process spawning.
    const runnerSrc = await readFile(path.join(root, "src/native/workerRunner.ts"), "utf8");
    expect(runnerSrc).toMatch(/child_process/);
    expect(runnerSrc).toMatch(/\bspawn\b/);
  });

  test("trace launch verdict reflects recorded hybrid launch evidence (prop 18,19)", async () => {
    await writeBehavior(allCompleteBehavior());
    const runId = freshRunId();
    const state = await bootstrapAndRun(runId, fakeRunner());
    expect(state.concurrency.allLaunchTimestampsRecorded).toBe(true);
    expect(state.concurrency.parallelPanelDispatchIssued).toBe(true);
    expect(state.concurrency.verdict).toBe("HYBRID_PARALLEL_LAUNCH_CONFIRMED");
    const trace = renderSupervisorTrace(state);
    expect(trace).toContain("Main builder:");
    expect(trace).toContain("Panel 1:");
    expect(trace).toContain("Panel 2:");
    expect(trace).toContain("Panel 3:");
    expect(trace).toContain("Judge:");
    expect(trace).toContain("Promotion:");
    expect(trace).toContain("execution: external_opencode_cli");
    expect(trace).toContain("execution: native_visible_subagent");
  });

  test("main model mismatch fails with FUSION_MAIN_MODEL_MISMATCH (prop 4)", async () => {
    await writeBehavior({
      ...allCompleteBehavior(),
      [WORKER_ID.main]: { sleepMs: 200, changedFile: "src/main-impl.ts", observedModel: "lmstudio/vibethinker-3b" },
    });
    const runId = freshRunId();
    const input = baseInput(runId);
    input.mainModel = { modelId: "opencode-go/deepseek-v4-pro" };
    await bootstrapRealParallelBuild(input, deps(fakeRunner()));
    workersRef = (await loadSupervisorState(sourceRoot, runId, traceRoot))!.workers;
    const state = await superviseRun(runId, deps(fakeRunner()));
    expect(state.workers[WORKER_ID.main].status).toBe("failed");
    expect(state.workers[WORKER_ID.main].observedModelId).toBe("lmstudio/vibethinker-3b");
    expect(state.mainPromotion.status).toBe("failed");
    expect(state.concurrency.mainModelMatched).toBe(false);
    expect(state.concurrency.verdict).toBe("HYBRID_PARALLEL_LAUNCH_NOT_CONFIRMED");
  });
});
