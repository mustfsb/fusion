import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These tests spawn the real fake-opencode child process for the external main
// builder, so allow generous time under load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import {
  hybridLaunch,
  hybridBeginNativeWave,
  hybridConfirmLaunch,
  hybridCollect,
  hybridFinalize,
  hybridCancel,
  type BootstrapInput,
  type SupervisorDeps,
  type HybridLaunchPlan,
} from "../src/native/fusionSupervisor.js";
import { loadSupervisorState } from "../src/native/supervisorState.js";
import { WORKER_ID } from "../src/native/supervisorTypes.js";
import { panelReceiptPaths } from "../src/native/panelReceipt.js";
import { renderSupervisorTrace } from "../src/native/supervisorTrace.js";
import { isPidAlive } from "../src/native/workerRunner.js";
import { NATIVE_TASK_DISPATCH_MECHANISM } from "../src/native/nativeSubagentDispatch.js";
import { assertNoActiveRunForWorkspace, launchForegroundHybrid, SUPERVISOR_LATEST_POINTER } from "../src/native/supervisorLaunch.js";
import { resolveTraceRoot } from "../src/trace/runTrace.js";
import {
  createOpenCodeProcessWorkerRunner,
  type WorkerRunner,
} from "../src/native/workerRunner.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));

let sourceRoot: string;
let traceRoot: string;
let stagingRoot: string;
let behaviorPath: string;
let runCounter = 0;

function freshRunId(): string {
  runCounter += 1;
  const hex = runCounter.toString(16).padStart(6, "0");
  return `fusion-20260627-120000-${hex}`;
}

function fakeRunner(): WorkerRunner {
  return createOpenCodeProcessWorkerRunner({
    opencodeBin: process.execPath,
    buildArgs: () => [FAKE],
  });
}

/** Controllable clock so registration/elapsed timing is deterministic. */
function makeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
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
    modelConfigFingerprint: "test-config-fingerprint",
    sourceWorkspace: sourceRoot,
  };
}

function deps(runner: WorkerRunner, extra?: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    cwd: sourceRoot,
    traceDir: traceRoot,
    runner,
    skipNativeAgentValidation: true,
    pollIntervalMs: 15,
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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Simulate the parent model's native panel Task subagents finishing: each panel
 * writes a meaningful candidate change + receipt + machine-readable result artifacts,
 * exactly like a real native subagent would once its blocking Task call returns.
 */
async function writePanelResults(
  runId: string,
  plan: HybridLaunchPlan,
  options?: { failPanels?: number[]; skipPanels?: number[]; omitReceipts?: boolean; spoofReceipt?: { panelIndex: number; runId?: string; panelId?: string } },
): Promise<void> {
  const fail = new Set(options?.failPanels ?? []);
  const skip = new Set(options?.skipPanels ?? []);
  const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
  for (const spec of plan.panelDispatchSpecs) {
    if (skip.has(spec.logicalPanelIndex)) continue;
    const completedAt = new Date().toISOString();
    const panelId = spec.agentId;
    if (!fail.has(spec.logicalPanelIndex)) {
      const changed = path.join(spec.candidateWorkspace, `src/panel-${spec.logicalPanelIndex}-impl.ts`);
      await mkdir(path.dirname(changed), { recursive: true });
      await writeFile(changed, `export const panel${spec.logicalPanelIndex} = true;\n`, "utf8");
      if (!options?.omitReceipts) {
        const receipts = panelReceiptPaths(spec.candidateWorkspace);
        await mkdir(receipts.outputDir, { recursive: true });
        const spoof = options?.spoofReceipt?.panelIndex === spec.logicalPanelIndex ? options.spoofReceipt : undefined;
        await writeFile(
          receipts.receiptPath,
          JSON.stringify(
            {
              runId: spoof?.runId ?? runId,
              panelId: spoof?.panelId ?? panelId,
              agentId: panelId,
              canonicalTaskHash: state.taskArtifactHash,
              candidateWorkspace: spec.candidateWorkspace,
              status: "completed",
              completedAt,
              summary: `panel ${spec.logicalPanelIndex} completed`,
            },
            null,
            2,
          ),
          "utf8",
        );
        await writeFile(
          receipts.resultPath,
          JSON.stringify({ status: "completed", changedFiles: [`src/panel-${spec.logicalPanelIndex}-impl.ts`] }, null, 2),
          "utf8",
        );
      }
      await writeFile(
        spec.resultArtifactPath,
        JSON.stringify(
          {
            workerId: WORKER_ID.panel(spec.logicalPanelIndex),
            role: "panel",
            status: "completed",
            changedFiles: [`src/panel-${spec.logicalPanelIndex}-impl.ts`],
            verification: { typecheck: "pass", test: "pass", build: "pass" },
            completedAt,
          },
          null,
          2,
        ),
        "utf8",
      );
    } else {
      await writeFile(
        spec.resultArtifactPath,
        JSON.stringify(
          { workerId: WORKER_ID.panel(spec.logicalPanelIndex), role: "panel", status: "failed", errorSummary: "panel failed" },
          null,
          2,
        ),
        "utf8",
      );
    }
  }
}

/** Native dispatch receipts WITH host-exposed session IDs. */
function receipts(plan: HybridLaunchPlan, options?: { skipPanels?: number[]; taskHash?: string }) {
  const skip = new Set(options?.skipPanels ?? []);
  return plan.panelDispatchSpecs
    .filter((spec) => !skip.has(spec.logicalPanelIndex))
    .map((spec) => ({
      logicalPanelIndex: spec.logicalPanelIndex,
      agentId: spec.agentId,
      sessionId: `native-session-panel-${spec.logicalPanelIndex}`,
      status: "completed" as const,
      candidateWorkspace: spec.candidateWorkspace,
      receiptArtifactPath: spec.receiptArtifactPath,
      canonicalTaskHash: options?.taskHash,
      taskResultSummary: `panel ${spec.logicalPanelIndex} finished`,
    }));
}

/** Native dispatch receipts WITHOUT session IDs (host does not expose them). */
function receiptsNoSession(plan: HybridLaunchPlan, taskHash?: string) {
  return plan.panelDispatchSpecs.map((spec) => ({
    logicalPanelIndex: spec.logicalPanelIndex,
    agentId: spec.agentId,
    status: "completed" as const,
    candidateWorkspace: spec.candidateWorkspace,
    receiptArtifactPath: spec.receiptArtifactPath,
    canonicalTaskHash: taskHash,
  }));
}

/** Minimal evidence batch: logical index + task completion hash only. */
function receiptsTaskOnly(plan: HybridLaunchPlan, taskHash: string) {
  return plan.panelDispatchSpecs.map((spec) => ({
    logicalPanelIndex: spec.logicalPanelIndex,
    agentId: spec.agentId,
    status: "completed" as const,
    canonicalTaskHash: taskHash,
    candidateWorkspace: spec.candidateWorkspace,
  }));
}

beforeEach(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-hf-src-"));
  traceRoot = await mkdtemp(path.join(tmpdir(), "fusion-hf-trace-"));
  stagingRoot = await mkdtemp(path.join(tmpdir(), "fusion-hf-stage-"));
  behaviorPath = path.join(traceRoot, "behavior.json");
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = stagingRoot;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const base = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  delete process.env.FUSION_HYBRID_STARTUP_DEADLINE_MS;
  delete process.env.FUSION_MAIN_MODEL;
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(traceRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
});

describe("foreground hybrid launch gate", () => {
  test("launch returns a real main PID + 3 ready panel dispatch specs, never all-queued", async () => {
    await writeBehavior({
      [WORKER_ID.main]: { sleepMs: 150, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" },
    });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));

    expect(plan.strategy).toBe("hybrid_external_main_native_panels");
    expect(plan.main.pid).toBeGreaterThan(0);
    expect(plan.main.executionKind).toBe("external_process");
    expect(plan.panelDispatchSpecs).toHaveLength(3);
    expect(plan.nextStage).toBe("begin_native_wave");

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).toBe("launching");
    expect(state.workers[WORKER_ID.main].status).toBe("running");
    // Panels are prepared and awaiting model dispatch — NOT queued, NOT running yet.
    for (const i of [1, 2, 3]) {
      expect(state.workers[WORKER_ID.panel(i)].status).toBe("launching");
      expect(state.workers[WORKER_ID.panel(i)].sessionId).toBeUndefined();
    }
  });

  test("active invoking session model is used as requested main model", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/active-main" } });
    const plan = await launchForegroundHybrid({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      invokingSessionModelId: "prov/active-main",
      skipRuntimeCheck: true,
      skipDuplicateRunGuard: true,
      deps: deps(fakeRunner()),
    });
    expect(plan.main.requestedModelId).toBe("prov/active-main");
    const state = (await loadSupervisorState(sourceRoot, plan.runId, traceRoot))!;
    expect(state.invokingSessionModelId).toBe("prov/active-main");
    expect(state.mainModelId).toBe("prov/active-main");
    await hybridCancel({ runId: plan.runId }, deps(fakeRunner()));
  });

  test("panel configuration cannot override active invoking model for main", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/active-main" } });
    const plan = await launchForegroundHybrid({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      invokingSessionModelId: "prov/active-main",
      panelModels: ["prov/panel-slot-1", "prov/panel-slot-2", "prov/panel-slot-3"],
      skipRuntimeCheck: true,
      skipDuplicateRunGuard: true,
      deps: deps(fakeRunner()),
    });
    expect(plan.main.requestedModelId).toBe("prov/active-main");
    await hybridCancel({ runId: plan.runId }, deps(fakeRunner()));
  });

  test("stale agent files and FUSION_MAIN_MODEL cannot override active invoking model", async () => {
    process.env.FUSION_MAIN_MODEL = "prov/env-main";
    await mkdir(path.join(sourceRoot, ".opencode", "agent"), { recursive: true });
    await writeFile(path.join(sourceRoot, ".opencode", "agent", "fusion-panel-1.md"), "model: prov/stale-agent\n", "utf8");
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/active-main" } });
    const plan = await launchForegroundHybrid({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      invokingSessionModelId: "prov/active-main",
      skipRuntimeCheck: true,
      skipDuplicateRunGuard: true,
      deps: deps(fakeRunner()),
    });
    expect(plan.main.requestedModelId).toBe("prov/active-main");
    await hybridCancel({ runId: plan.runId }, deps(fakeRunner()));
  });

  test("explicit manual main-model override works only when deliberately passed", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/manual-main" } });
    const plan = await launchForegroundHybrid({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      invokingSessionModelId: "prov/active-main",
      mainModel: "prov/manual-main",
      skipRuntimeCheck: true,
      skipDuplicateRunGuard: true,
      deps: deps(fakeRunner()),
    });
    expect(plan.main.requestedModelId).toBe("prov/manual-main");
    const state = (await loadSupervisorState(sourceRoot, plan.runId, traceRoot))!;
    expect(state.invokingSessionModelId).toBe("prov/active-main");
    expect(state.mainModelId).toBe("prov/manual-main");
    await hybridCancel({ runId: plan.runId }, deps(fakeRunner()));
  });

  test("missing active-session model fails without fallback", async () => {
    process.env.FUSION_MAIN_MODEL = "prov/env-main";
    await expect(
      launchForegroundHybrid({
        task: "Add a feature flag.",
        cwd: sourceRoot,
        traceDir: traceRoot,
        panelModels: ["prov/panel-slot-1", "prov/panel-slot-2", "prov/panel-slot-3"],
        skipRuntimeCheck: true,
        skipDuplicateRunGuard: true,
        deps: deps(fakeRunner()),
      }),
    ).rejects.toThrow(/FUSION_MAIN_MODEL_UNRESOLVED/);
  });

  test("Test 3: launch timing overrides persist into run state and are reused by later stages", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const clock = makeClock();
    const plan = await hybridLaunch(
      baseInput(runId),
      deps(fakeRunner(), {
        now: clock.now,
        externalMainStartupDeadlineMs: 12_345,
        nativeDispatchRegistrationDeadlineMs: 54_321,
        nativePanelExecutionTimeoutMs: 987_654,
      }),
    );

    expect(plan.timing.externalMainStartupDeadlineMs).toBe(12_345);
    expect(plan.timing.nativeDispatchRegistrationDeadlineMs).toBe(54_321);
    expect(plan.timing.nativePanelExecutionTimeoutMs).toBe(987_654);

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.runTiming).toEqual({
      externalMainStartupDeadlineMs: 12_345,
      nativeDispatchRegistrationDeadlineMs: 54_321,
      nativePanelExecutionTimeoutMs: 987_654,
    });
    // Panel execution timeout is bound to the panel workers.
    for (const i of [1, 2, 3]) {
      expect(state.workers[WORKER_ID.panel(i)].hardTimeoutMs).toBe(987_654);
    }

    // A later stage reads the PERSISTED registration deadline even when its own
    // deps omit any override (no silent fallback to 15s).
    const beginResult = await hybridBeginNativeWave({ runId }, deps(fakeRunner(), { now: clock.now }));
    expect(beginResult.registrationDeadlineMs).toBe(54_321);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("Test 5: native dispatch registration failure fails quickly (begin_native_wave deadline)", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const clock = makeClock();
    await hybridLaunch(
      baseInput(runId),
      deps(fakeRunner(), { now: clock.now, nativeDispatchRegistrationDeadlineMs: 500 }),
    );
    // Parent stalls before beginning the wave: advance past the registration window.
    clock.advance(1_000);
    await expect(
      hybridBeginNativeWave({ runId }, deps(fakeRunner(), { now: clock.now })),
    ).rejects.toThrow(/FUSION_SUPERVISOR_LAUNCH_FAILED.*registration deadline/s);
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).toBe("cancelled");
  });

  test("Test 4: a main spawn failure fails the launch quickly instead of leaving workers queued", async () => {
    const brokenRunner: WorkerRunner = {
      transport: "opencode-cli-process",
      async spawn() {
        throw new Error("spawn ENOENT opencode");
      },
    };
    const runId = freshRunId();
    await expect(hybridLaunch(baseInput(runId), deps(brokenRunner))).rejects.toThrow(
      /FUSION_SUPERVISOR_LAUNCH_FAILED/,
    );
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).toBe("cancelled");
  });

  test("begin_native_wave registers the wave parallel-ready without faking running/session state", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    const begin = await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    expect(begin.registered).toBe(true);
    expect(begin.expectedPanelAgentIds).toEqual(plan.panelDispatchSpecs.map((s) => s.agentId));

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.nativeWave?.registeredVia).toBe("begin_native_wave");
    for (const i of [1, 2, 3]) {
      const panel = state.workers[WORKER_ID.panel(i)];
      // dispatch_requested: no fake session ID, no fake running status.
      expect(panel.nativeWaveStage).toBe("dispatch_requested");
      expect(panel.sessionId).toBeUndefined();
      expect(panel.status).toBe("launching");
      // All three share one dispatch-requested timestamp (one parallel wave).
      expect(panel.dispatchRequestedAt).toBe(state.nativeWave?.dispatchRequestedAt);
    }
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("Test 2 + Test 8: confirm_launch ignores panel execution duration and keeps panels parallel", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const clock = makeClock();
    const plan = await hybridLaunch(
      baseInput(runId),
      deps(fakeRunner(), { now: clock.now, nativeDispatchRegistrationDeadlineMs: 1_000 }),
    );
    await hybridBeginNativeWave({ runId }, deps(fakeRunner(), { now: clock.now }));

    // The blocking native Task calls run for a long time (well past any 15s
    // startup deadline) before the parent can call confirm_launch.
    clock.advance(120_000);
    await writePanelResults(runId, plan);

    const result = await hybridConfirmLaunch(
      { runId, panelDispatches: receipts(plan) },
      deps(fakeRunner(), { now: clock.now }),
    );
    expect(result.confirmed).toBe(true);
    expect(result.status).toBe("LAUNCH_CONFIRMED");

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    // All three panel dispatch requests share a single timestamp → parallel.
    expect(state.concurrency.parallelPanelDispatchIssued).toBe(true);
    const requestedAts = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)].dispatchRequestedAt);
    expect(new Set(requestedAts).size).toBe(1);
  });

  test("Test 1 + Test 6: panels that finish after the startup window reconcile to completed", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const clock = makeClock();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner(), { now: clock.now }));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner(), { now: clock.now }));
    clock.advance(45_000); // panels run for 45s, far beyond 15s
    await writePanelResults(runId, plan);

    const result = await hybridConfirmLaunch(
      { runId, panelDispatches: receipts(plan) },
      deps(fakeRunner(), { now: clock.now }),
    );
    expect(result.confirmed).toBe(true);
    for (const panel of result.panels) {
      expect(panel.status).toBe("completed");
      expect(panel.nativeWaveStage).toBe("completed");
    }
  });

  test("already-completed panels confirm even when the host exposes no session IDs", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;

    // No session IDs available — valid receipts + Task completion are the evidence.
    const result = await hybridConfirmLaunch(
      { runId, panelDispatches: receiptsNoSession(plan, state.taskArtifactHash) },
      deps(fakeRunner()),
    );
    expect(result.confirmed).toBe(true);
    for (const panel of result.panels) {
      expect(panel.status).toBe("completed");
      expect(panel.sessionId).toBeUndefined();
    }
    const refreshed = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(refreshed.nativeWave?.parentWaveReturned).toBe(true);
    for (const i of [1, 2, 3]) {
      expect(refreshed.workers[WORKER_ID.panel(i)].runtimeEvidence?.receiptValidity).toBe("valid");
    }
  });

  test("three completed panels with valid receipts reconcile with no native session IDs", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;

    const result = await hybridConfirmLaunch(
      {
        runId,
        panelDispatches: plan.panelDispatchSpecs.map((spec) => ({
          logicalPanelIndex: spec.logicalPanelIndex,
          agentId: spec.agentId,
          status: "completed" as const,
          candidateWorkspace: spec.candidateWorkspace,
          receiptArtifactPath: spec.receiptArtifactPath,
          canonicalTaskHash: state.taskArtifactHash,
        })),
      },
      deps(fakeRunner()),
    );
    expect(result.confirmed).toBe(true);
    expect(result.status).toBe("LAUNCH_CONFIRMED");
  });

  test("native session IDs are preferred when available", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);

    const result = await hybridConfirmLaunch({ runId, panelDispatches: receipts(plan) }, deps(fakeRunner()));
    expect(result.confirmed).toBe(true);
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    for (const i of [1, 2, 3]) {
      expect(state.workers[WORKER_ID.panel(i)].sessionId).toBe(`native-session-panel-${i}`);
      expect(state.workers[WORKER_ID.panel(i)].runtimeEvidence?.reconciledStatus).toBe("completed_with_session");
    }
  });

  test("a panel cannot spoof another run/panel through a mismatched receipt", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));

    for (const spec of plan.panelDispatchSpecs) {
      const changed = path.join(spec.candidateWorkspace, `src/panel-${spec.logicalPanelIndex}-impl.ts`);
      await mkdir(path.dirname(changed), { recursive: true });
      await writeFile(changed, `export const panel${spec.logicalPanelIndex} = true;\n`, "utf8");
      const receiptsPaths = panelReceiptPaths(spec.candidateWorkspace);
      await mkdir(receiptsPaths.outputDir, { recursive: true });
      const spoofed =
        spec.logicalPanelIndex === 2
          ? {
              runId: "fusion-spoof-run",
              panelId: "fusion-panel-99",
              agentId: "fusion-panel-2",
              canonicalTaskHash: "deadbeef",
            }
          : {
              runId,
              panelId: spec.agentId,
              agentId: spec.agentId,
              canonicalTaskHash: (await loadSupervisorState(sourceRoot, runId, traceRoot))!.taskArtifactHash,
            };
      await writeFile(
        receiptsPaths.receiptPath,
        JSON.stringify(
          {
            ...spoofed,
            candidateWorkspace: spec.candidateWorkspace,
            status: "completed",
            completedAt: new Date().toISOString(),
            summary: "done",
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    const confirm = await hybridConfirmLaunch(
        {
          runId,
          panelDispatches: plan.panelDispatchSpecs.map((spec) => ({
            logicalPanelIndex: spec.logicalPanelIndex,
            agentId: spec.agentId,
            status: "completed" as const,
            candidateWorkspace: spec.candidateWorkspace,
            receiptArtifactPath: spec.receiptArtifactPath,
          })),
        },
        deps(fakeRunner()),
      );
    expect(confirm.status).toBe("LAUNCH_CONFIRMED");

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.workers[WORKER_ID.panel(2)].runtimeEvidence?.receiptValidity).toBe("invalid");
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("Task completion with valid canonical task hash is accepted as evidence", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    // Candidate mutation without receipt artifacts
    for (const spec of plan.panelDispatchSpecs) {
      const changed = path.join(spec.candidateWorkspace, `src/panel-${spec.logicalPanelIndex}-impl.ts`);
      await mkdir(path.dirname(changed), { recursive: true });
      await writeFile(changed, `export const p${spec.logicalPanelIndex} = true;\n`, "utf8");
    }
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    const result = await hybridConfirmLaunch(
      { runId, panelDispatches: receiptsTaskOnly(plan, state.taskArtifactHash) },
      deps(fakeRunner()),
    );
    expect(result.confirmed).toBe(true);
    const confirmed = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(confirmed.workers[WORKER_ID.panel(1)].runtimeEvidence?.taskCompletionEvidence).toBe(true);
  });

  test("Test 5: missing panelOutcomes still confirms launch and preserves main; collect owns awaiting", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    const mainPid = plan.main.pid;

    const empty = await hybridConfirmLaunch({ runId, panelOutcomes: [], waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));
    expect(empty.confirmed).toBe(true);
    expect(empty.status).toBe("LAUNCH_CONFIRMED");
    expect(empty.nextStage).toBe("collect");
    expect(isPidAlive(mainPid)).toBe(true);
    let state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).not.toBe("cancelled");
    expect(state.workers[WORKER_ID.main].pid).toBe(mainPid);

    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(collected.allPanelsClassified).toBe(true);
    expect(collected.panels.every((panel) => panel.evidenceStatus === "completed_no_output")).toBe(true);
    expect(isPidAlive(mainPid)).toBe(true);
    state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.nativeWave?.parentWaveReturned).toBe(true);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("Test 3: completed panels with real Task summaries + mutations reconcile with no session IDs and no receipts", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    // Candidate mutation only — NO receipt files, NO result artifacts on disk.
    for (const spec of plan.panelDispatchSpecs) {
      const changed = path.join(spec.candidateWorkspace, `src/panel-${spec.logicalPanelIndex}-impl.ts`);
      await mkdir(path.dirname(changed), { recursive: true });
      await writeFile(changed, `export const p${spec.logicalPanelIndex} = true;\n`, "utf8");
    }
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    const result = await hybridConfirmLaunch(
      {
        runId,
        panelOutcomes: plan.panelDispatchSpecs.map((spec) => ({
          panelId: spec.agentId,
          agentId: spec.agentId,
          status: "completed" as const,
          taskResultSummary: `panel ${spec.logicalPanelIndex} implemented the feature`,
          candidateWorkspace: spec.candidateWorkspace,
          canonicalTaskHash: state.taskArtifactHash,
        })),
      },
      deps(fakeRunner()),
    );
    expect(result.confirmed).toBe(true);
    expect(result.status).toBe("LAUNCH_CONFIRMED");
    const after = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    for (const i of [1, 2, 3]) {
      const ev = after.workers[WORKER_ID.panel(i)].runtimeEvidence!;
      expect(ev.acceptance).toBe("accepted");
      expect(ev.nativeSessionIdAvailable).toBe(false);
      expect(ev.receiptValidity).toBe("missing");
      expect(ev.candidateMutationEvidence).toBe(true);
    }
  });

  test("Test 6: repeating confirm_launch with valid outcomes is idempotent", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);

    const first = await hybridConfirmLaunch({ runId, panelOutcomes: receipts(plan) }, deps(fakeRunner()));
    expect(first.confirmed).toBe(true);
    const second = await hybridConfirmLaunch({ runId, panelOutcomes: receipts(plan) }, deps(fakeRunner()));
    expect(second.confirmed).toBe(true);
    expect(second.status).toBe("LAUNCH_CONFIRMED");

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    for (const i of [1, 2, 3]) {
      const worker = state.workers[WORKER_ID.panel(i)];
      // Completed panels are never downgraded by a delayed re-reconciliation.
      expect(worker.status).toBe("completed");
      expect(worker.runtimeEvidence?.reconciledStatus).not.toBe("failed");
      expect(worker.runtimeEvidence?.acceptance).toBe("accepted");
    }
  });

  test("Test 7: wrong panel ID, workspace, or task hash fails safely without cancelling the run", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    const mainPid = plan.main.pid;
    const good = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;

    // Panel 2 outcome carries a spoofed panelId, a foreign workspace, and a wrong hash.
    const confirm = await hybridConfirmLaunch(
        {
          runId,
          panelOutcomes: plan.panelDispatchSpecs.map((spec) =>
            spec.logicalPanelIndex === 2
              ? {
                  panelId: "fusion-panel-99",
                  agentId: "fusion-panel-2",
                  status: "completed" as const,
                  candidateWorkspace: "/tmp/not-the-real-candidate",
                  canonicalTaskHash: "deadbeef",
                }
              : {
                  panelId: spec.agentId,
                  agentId: spec.agentId,
                  status: "completed" as const,
                  candidateWorkspace: spec.candidateWorkspace,
                  canonicalTaskHash: good.taskArtifactHash,
                },
          ),
        },
        deps(fakeRunner()),
      );
    expect(confirm.status).toBe("LAUNCH_CONFIRMED");

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).not.toBe("cancelled");
    expect(state.workers[WORKER_ID.main].pid).toBe(mainPid);
    expect(state.workers[WORKER_ID.panel(2)].runtimeEvidence?.contractMismatchErrors?.length).toBeGreaterThan(0);
    expect(state.workers[WORKER_ID.panel(2)].runtimeEvidence?.acceptance).toBe("rejected");
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("confirm_launch does not fail 0/3 when valid panel receipt artifacts exist on disk", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);

    const result = await hybridConfirmLaunch(
      {
        runId,
        panelDispatches: plan.panelDispatchSpecs.map((spec) => ({
          logicalPanelIndex: spec.logicalPanelIndex,
          agentId: spec.agentId,
        })),
      },
      deps(fakeRunner()),
    );
    expect(result.confirmed).toBe(true);
    expect(result.panels).toHaveLength(3);
  });

  test("completed panels remain completed after delayed reconciliation", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const clock = makeClock();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner(), { now: clock.now }));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner(), { now: clock.now }));
    clock.advance(90_000);
    await writePanelResults(runId, plan);
    const stateBefore = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;

    await hybridConfirmLaunch(
      { runId, panelDispatches: receiptsNoSession(plan, stateBefore.taskArtifactHash) },
      deps(fakeRunner(), { now: clock.now }),
    );
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    for (const i of [1, 2, 3]) {
      expect(state.workers[WORKER_ID.panel(i)].status).toBe("completed");
      expect(state.workers[WORKER_ID.panel(i)].runtimeEvidence?.reconciledStatus).not.toBe("failed");
    }
  });

  test("blank optional main/judge model fields do not overwrite persisted run model routing", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    const before = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(before.mainModelId).toBe("prov/main-model");
    expect(before.judgeModelId).toBe("prov/judge-model");

    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    await hybridConfirmLaunch({ runId, panelDispatches: receipts(plan) }, deps(fakeRunner()));

    const after = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(after.mainModelId).toBe("prov/main-model");
    expect(after.judgeModelId).toBe("prov/judge-model");
    expect(after.invokingSessionModelId).toBe(before.invokingSessionModelId);
  });

  test("trace records native panel evidence fields after confirm_launch", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    const loaded = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    await hybridConfirmLaunch(
      { runId, panelDispatches: receiptsNoSession(plan, loaded.taskArtifactHash) },
      deps(fakeRunner()),
    );

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    const trace = renderSupervisorTrace(state);
    expect(trace).toContain("Native panel evidence:");
    expect(trace).toContain("receipt validity: valid");
    expect(trace).toContain("candidate mutation evidence: yes");
    // Per-panel reconciliation visibility required by /fusion-trace.
    expect(trace).toContain("Native task returned: yes");
    expect(trace).toContain("Native session ID:");
    expect(trace).toContain("Task ID:");
    expect(trace).toContain("Task result summary:");
    expect(trace).toContain("Receipt: valid");
    expect(trace).toContain("Candidate mutation: yes");
    expect(trace).toContain("Reconciled runtime evidence: accepted");
    // confirm_launch batch + missing-entry visibility.
    expect(trace).toContain("Native panel outcomes reconciliation:");
    expect(trace).toContain("confirm_launch received panelOutcomes batch: yes");
    expect(trace).toContain("parent wave returned: yes");
  });

  test("Test 7: panels remain native visible Task subagents, never external CLI workers", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    await hybridConfirmLaunch({ runId, panelDispatches: receipts(plan) }, deps(fakeRunner()));

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.concurrency.noPanelViaExternalCli).toBe(true);
    for (const i of [1, 2, 3]) {
      const panel = state.workers[WORKER_ID.panel(i)];
      expect(panel.executionKind).toBe("native_subagent");
      expect(panel.dispatchMechanism).toBe(NATIVE_TASK_DISPATCH_MECHANISM);
    }
  });

  test("confirm_launch confirms launch; collect awaits when one panel has no evidence", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan, { skipPanels: [3] });

    const result = await hybridConfirmLaunch(
      { runId, panelOutcomes: receipts(plan, { skipPanels: [3] }), waveDispatchedAt: new Date().toISOString() },
      deps(fakeRunner()),
    );
    expect(result.status).toBe("LAUNCH_CONFIRMED");
    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(collected.panels.find((panel) => panel.logicalPanelIndex === 3)?.evidenceStatus).toBe("completed_no_output");
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).not.toBe("cancelled");
    expect(state.workers[WORKER_ID.panel(1)].status).toBe("completed");
    expect(state.workers[WORKER_ID.panel(2)].status).toBe("completed");
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("Test 11/5: an awaiting confirm does not auto-start a second run", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan, { skipPanels: [3] });

    const result = await hybridConfirmLaunch(
      { runId, panelOutcomes: receipts(plan, { skipPanels: [3] }) },
      deps(fakeRunner()),
    );
    expect(result.status).toBe("LAUNCH_CONFIRMED");

    // No second run directory was created: only the original run exists.
    const root = resolveTraceRoot(sourceRoot, traceRoot);
    const entries = (await readdir(root)).filter((name) => name.startsWith("fusion-"));
    expect(entries).toEqual([runId]);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });
});

describe("foreground hybrid judge gate + finalize", () => {
  test("collect blocks the judge until promoted main AND all panels are terminal, then finalize completes", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 2_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan);
    await hybridConfirmLaunch({ runId, panelDispatches: receipts(plan) }, deps(fakeRunner()));

    // While the external main is still running, the judge must be ineligible.
    const early = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(early.judge.eligible).toBe(false);

    await waitFor(async () => {
      const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
      return !isPidAlive(state.workers[WORKER_ID.main].pid);
    });
    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(collected.main.status).toBe("completed");
    expect(collected.main.promoted).toBe(true);
    expect(collected.allPanelsTerminal).toBe(true);
    expect(collected.judge.eligible).toBe(true);
    if (!collected.judge.eligible) throw new Error("judge should be eligible");

    expect(await exists(path.join(sourceRoot, "src/main-impl.ts"))).toBe(true);

    const judge = collected.judge.dispatch;
    await writeFile(judge.contractPath, "# Merge Patch Contract\n\n13. Final Decision: ok\n", "utf8");
    await writeFile(
      judge.resultArtifactPath,
      JSON.stringify(
        {
          workerId: WORKER_ID.judge,
          role: "judge",
          status: "completed",
          mergePatchDecision: "NO_PATCH_REQUIRED",
          contractPath: judge.contractPath,
          appliedPatchItems: [],
          verification: { typecheck: "pass", test: "pass", build: "pass" },
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const finalized = await hybridFinalize({ runId, judgeSessionId: "native-session-judge" }, deps(fakeRunner()));
    expect(finalized.phase).toBe("done");
    expect(finalized.decision).toBe("NO_PATCH_REQUIRED");
  });

  test("partial failure: one failed panel still allows the judge when a usable candidate remains", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 150, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await writePanelResults(runId, plan, { failPanels: [2] });
    await hybridConfirmLaunch({ runId, panelDispatches: receipts(plan) }, deps(fakeRunner()));
    await waitFor(async () => {
      const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
      return !isPidAlive(state.workers[WORKER_ID.main].pid);
    });
    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(collected.panels.find((p) => p.logicalPanelIndex === 2)!.status).toBe("failed");
    expect(collected.judge.eligible).toBe(true);
  });
});

describe("foreground hybrid cancellation + duplicate-run safety", () => {
  test("Test 12: cancel terminates the external main and truthfully records cleanup", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    const mainPid = plan.main.pid;
    expect(isPidAlive(mainPid)).toBe(true);

    await hybridCancel({ runId, reason: "user cancelled" }, deps(fakeRunner()));
    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.phase).toBe("cancelled");
    expect(state.cancellation?.reason).toBe("user cancelled");
    expect(state.cancellation?.mainProcessOutcome).toBe("terminated");
    expect(state.cancellation?.cleanedUp).toBe(true);
    expect(state.cancellation?.mainPid).toBe(mainPid);
    for (const worker of Object.values(state.workers)) {
      expect(["cancelled", "completed", "failed", "timed_out"]).toContain(worker.status);
    }
    await waitFor(() => !isPidAlive(mainPid));
    expect(isPidAlive(mainPid)).toBe(false);
  });

  test("duplicate-run guard blocks a new run while an earlier run owns a live main builder", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 5_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    expect(isPidAlive(plan.main.pid)).toBe(true);

    // launchForegroundHybrid writes this pointer; emulate it for the direct guard test.
    const root = resolveTraceRoot(sourceRoot, traceRoot);
    await writeFile(
      path.join(root, SUPERVISOR_LATEST_POINTER),
      JSON.stringify({ runId, runDir: path.join(root, runId), timestamp: new Date().toISOString(), strategy: "hybrid_external_main_native_panels" }),
      "utf8",
    );

    await expect(
      assertNoActiveRunForWorkspace(sourceRoot, traceRoot, sourceRoot),
    ).rejects.toThrow(/FUSION_DUPLICATE_ACTIVE_RUN/);

    // After cancelling, a new run is allowed again.
    await hybridCancel({ runId }, deps(fakeRunner()));
    await expect(assertNoActiveRunForWorkspace(sourceRoot, traceRoot, sourceRoot)).resolves.toBeUndefined();
  });
});
