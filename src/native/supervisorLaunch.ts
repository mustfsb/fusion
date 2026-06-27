import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import { resolveModels } from "../modelConfig.js";
import { createRunId, resolveTraceRoot } from "../trace/runTrace.js";
import {
  bootstrapRealParallelBuild,
  hybridLaunch,
  liveWorkerSummary,
  type HybridLaunchPlan,
  type SupervisorDeps,
} from "./fusionSupervisor.js";
import { loadSupervisorState, supervisorRunDir } from "./supervisorState.js";
import { latestRunFromRegistry, resolveRunFromRegistry } from "./runRegistry.js";
import { isPidAlive } from "./workerRunner.js";
import { renderSupervisorTrace } from "./supervisorTrace.js";
import { assertForegroundProtocolCompatible } from "./runtimeInstall.js";
import {
  confirmSupervisorReady,
  formatSupervisorStartupFailure,
  readSupervisorLogTail,
  resolveSupervisorNodeExecutable,
  resolveSupervisorWorkingDirectory,
  supervisorMainEntry,
  SUPERVISOR_READY_FILENAME,
  validateSupervisorLaunchPaths,
  waitForSupervisorReady,
  type SupervisorReadyReceipt,
} from "./supervisorStartup.js";
import { WORKER_ID, type SupervisorState } from "./supervisorTypes.js";

export const SUPERVISOR_LATEST_POINTER = "latest-supervisor-run.json";

export {
  resolveSupervisorNodeExecutable,
  supervisorMainEntry,
  SUPERVISOR_READY_FILENAME,
  waitForSupervisorReady,
  type SupervisorReadyReceipt,
};

/**
 * Resolve the main builder model. Fresh /fusion-build must use the active
 * invoking OpenCode session model unless the caller deliberately supplies an
 * explicit manual override. Panel config and FUSION_MAIN_MODEL are never silent
 * defaults for main.
 */
export function resolveMainModelSpec(input: { explicit?: string; invokingSessionModelId?: string }): FusionModelSpec {
  if (input.explicit) return { modelId: input.explicit };
  if (input.invokingSessionModelId) return { modelId: input.invokingSessionModelId };
  throw new Error("FUSION_MAIN_MODEL_UNRESOLVED: active invoking session model was not available and no explicit main model override was supplied");
}

export type LaunchInput = {
  task: string;
  cwd: string;
  traceDir?: string;
  command?: string;
  sourceWorkspace?: string;
  panelModels?: string[];
  judgeModel?: string;
  mainModel?: string;
  invokingSessionModelId?: string;
  /** When true, run the supervisor inline instead of spawning a detached process (tests). */
  inline?: boolean;
  /** Skip the installed-command/runtime-manifest compatibility check (tests). */
  skipRuntimeCheck?: boolean;
  /** Override startup handshake timeout (tests). */
  startupTimeoutMs?: number;
  /** Override detached supervisor working directory while keeping bootstrap cwd (tests). */
  launchWorkingDirectory?: string;
  /** Test-only override for Node runtime candidate resolution order. */
  supervisorNodeCandidates?: string[];
  deps?: Partial<SupervisorDeps>;
};

export type LaunchResult = {
  runId: string;
  strategy: "hybrid_external_main_native_panels";
  runDir: string;
  supervisorStatePath: string;
  supervisorPid?: number;
  readyAt?: string;
  mainModelId: string;
  panelModelIds: string[];
  judgeModelId: string;
  detached: boolean;
};

export type SupervisorTraceStub = {
  runId: string;
  buildStrategy: "hybrid_external_main_native_panels";
  launchRequestedAt: string;
  sourceWorkspace: string;
  supervisorPid?: number;
  readyAt?: string;
  workers: Array<{ workerId: string; role: string; status: "queued" }>;
};

export type LaunchReceipt = {
  runId: string;
  strategy: "hybrid_external_main_native_panels";
  launchRequestedAt: string;
  sourceWorkspace: string;
  supervisorPid?: number;
  readyAt?: string;
  runDir: string;
  supervisorStatePath: string;
};

function buildTraceStub(state: SupervisorState, readyAt?: string): SupervisorTraceStub {
  return {
    runId: state.runId,
    buildStrategy: "hybrid_external_main_native_panels",
    launchRequestedAt: state.launchRequestedAt,
    sourceWorkspace: state.sourceWorkspace,
    supervisorPid: state.supervisorPid,
    readyAt,
    workers: [
      { workerId: WORKER_ID.main, role: "main", status: "queued" },
      { workerId: WORKER_ID.panel(1), role: "panel", status: "queued" },
      { workerId: WORKER_ID.panel(2), role: "panel", status: "queued" },
      { workerId: WORKER_ID.panel(3), role: "panel", status: "queued" },
    ],
  };
}

function buildLaunchReceipt(
  state: SupervisorState,
  runDir: string,
  supervisorStatePath: string,
  readyAt?: string,
): LaunchReceipt {
  return {
    runId: state.runId,
    strategy: "hybrid_external_main_native_panels",
    launchRequestedAt: state.launchRequestedAt,
    sourceWorkspace: state.sourceWorkspace,
    supervisorPid: state.supervisorPid,
    readyAt,
    runDir,
    supervisorStatePath,
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(filePath, await readFile(tmp, "utf8"), "utf8");
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tmp, filePath);
  } catch {
    // ignore
  }
}

async function writeSupervisorPointer(
  state: SupervisorState,
  cwd: string,
  traceDir: string | undefined,
  runDir: string,
): Promise<string> {
  const pointerPath = path.join(resolveTraceRoot(cwd, traceDir), SUPERVISOR_LATEST_POINTER);
  await atomicWriteJson(pointerPath, {
    runId: state.runId,
    runDir,
    timestamp: state.launchRequestedAt,
    strategy: "hybrid_external_main_native_panels",
  });
  return pointerPath;
}

async function writeSupervisorRunArtifacts(
  state: SupervisorState,
  cwd: string,
  traceDir: string | undefined,
  readyAt?: string,
): Promise<{ tracePath: string; receiptPath: string; pointerPath: string }> {
  const runDir = supervisorRunDir(cwd, state.runId, traceDir);
  const tracePath = path.join(runDir, "trace.json");
  const receiptPath = path.join(runDir, "launch-receipt.json");
  const pointerPath = await writeSupervisorPointer(state, cwd, traceDir, runDir);

  await atomicWriteJson(tracePath, buildTraceStub(state, readyAt));
  await atomicWriteJson(receiptPath, buildLaunchReceipt(state, runDir, path.join(runDir, "supervisor-state.json"), readyAt));

  return { tracePath, receiptPath, pointerPath };
}

export function buildDetachedSupervisorArgv(input: {
  runId: string;
  runDir: string;
  sourceWorkspace: string;
  workingDirectory: string;
  traceDir?: string;
}): { entrypointPath: string; argv: string[] } {
  const entrypointPath = supervisorMainEntry();
  const cliArgs = [
    "--run-id",
    input.runId,
    "--run-dir",
    input.runDir,
    "--source-workspace",
    input.sourceWorkspace,
    "--working-directory",
    input.workingDirectory,
  ];
  if (input.traceDir) {
    cliArgs.push("--trace-dir", input.traceDir);
  }
  const argv =
    entrypointPath.endsWith(".ts")
      ? ["--import", "tsx", entrypointPath, ...cliArgs]
      : [entrypointPath, ...cliArgs];
  return { entrypointPath, argv };
}

async function spawnDetachedSupervisor(input: {
  runId: string;
  runDir: string;
  sourceWorkspace: string;
  workingDirectory: string;
  traceDir?: string;
  logPath: string;
  nodeExecutable: string;
}): Promise<ChildProcess> {
  const logFd = openSync(input.logPath, "a");
  const { entrypointPath, argv } = buildDetachedSupervisorArgv(input);
  const child = spawn(input.nodeExecutable, argv, {
    cwd: input.workingDirectory,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      FUSION_SUPERVISOR_NODE_EXECUTABLE: input.nodeExecutable,
      FUSION_SUPERVISOR_RUN_ID: input.runId,
      FUSION_SUPERVISOR_RUN_DIR: input.runDir,
      FUSION_SUPERVISOR_SOURCE_WORKSPACE: input.sourceWorkspace,
      FUSION_SUPERVISOR_WORKING_DIRECTORY: input.workingDirectory,
      ...(input.traceDir ? { FUSION_SUPERVISOR_TRACE_DIR: input.traceDir } : {}),
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });

  if (!argv.includes(entrypointPath) && !argv.includes(path.resolve(entrypointPath))) {
    throw new Error("Detached supervisor argv must include the supervisor entrypoint file.");
  }

  child.unref();
  return child;
}

/**
 * Minimal safe bootstrap + detached supervisor launch for the default
 * `hybrid_external_main_native_panels` strategy. Returns only after the supervisor
 * confirms readiness; the detached supervisor owns worker spawn and survives
 * parent session closure.
 */
export async function launchRealParallelBuild(input: LaunchInput): Promise<LaunchResult> {
  if (!input.skipRuntimeCheck) {
    try {
      await assertForegroundProtocolCompatible();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("FUSION_RUNTIME_PROTOCOL_MISMATCH")) {
        throw error;
      }
      throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: ${message}`);
    }
  }

  if (input.command === "fusion-no-build") {
    throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: /fusion-no-build must not launch a supervisor or worker process");
  }

  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const mainModel = resolveMainModelSpec({ explicit: input.mainModel, invokingSessionModelId: input.invokingSessionModelId });
  const runId = createRunId();
  const projectCwd = path.resolve(input.cwd);
  const sourceWorkspace = path.resolve(input.sourceWorkspace ?? input.cwd);
  const workingDirectory = resolveSupervisorWorkingDirectory(
    sourceWorkspace,
    input.launchWorkingDirectory ?? projectCwd,
  );
  const entrypointPath = supervisorMainEntry();
  const deps: SupervisorDeps = { cwd: projectCwd, traceDir: input.traceDir, ...input.deps };

  let bootstrapped: SupervisorState;
  try {
    bootstrapped = await bootstrapRealParallelBuild(
      {
        runId,
        task: input.task,
        command: input.command ?? "fusion-build",
        mainModel,
        invokingSessionModelId: input.invokingSessionModelId,
        panelModels: resolved.panelModels,
        judgeModel: resolved.judgeModel,
        modelConfigFingerprint: resolved.fingerprint,
        sourceWorkspace,
      },
      deps,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: bootstrap failed: ${message}`);
  }

  const runDir = supervisorRunDir(projectCwd, runId, input.traceDir);
  const supervisorStatePath = path.join(runDir, "supervisor-state.json");
  const supervisorLogPath = path.join(runDir, "logs", "supervisor.log");

  let supervisorPid: number | undefined;
  let readyAt: string | undefined;
  let detached = false;

  if (input.inline) {
    if (!deps.nativeDispatcher) {
      throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: inline hybrid launch requires deps.nativeDispatcher");
    }
    supervisorPid = process.pid;
    bootstrapped.supervisorPid = supervisorPid;
    try {
      await writeSupervisorPointer(bootstrapped, projectCwd, input.traceDir, runDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: failed to write initial artifacts: ${message}`);
    }
    try {
      const ready = await confirmSupervisorReady({
        runId,
        runDir,
        sourceWorkspace,
        workingDirectory: projectCwd,
        entrypointPath,
        traceDir: input.traceDir,
      }, { validateEntrypoint: false });
      readyAt = ready.receipt.readyAt;
      await writeSupervisorRunArtifacts(ready.state, projectCwd, input.traceDir, readyAt);
    } catch (error) {
      throw new Error(
        formatSupervisorStartupFailure(error, {
          runId,
          supervisorPid,
          supervisorLogPath,
          entrypointPath,
          workingDirectory,
        }),
      );
    }
    const { superviseRun } = await import("./fusionSupervisor.js");
    await superviseRun(runId, deps);
  } else {
    supervisorPid = process.pid;
    bootstrapped.supervisorPid = supervisorPid;
    try {
      await writeSupervisorPointer(bootstrapped, projectCwd, input.traceDir, runDir);
      const ready = await confirmSupervisorReady({
        runId,
        runDir,
        sourceWorkspace,
        workingDirectory: projectCwd,
        entrypointPath,
        traceDir: input.traceDir,
      }, { validateEntrypoint: false });
      readyAt = ready.receipt.readyAt;
      await writeSupervisorRunArtifacts(ready.state, projectCwd, input.traceDir, readyAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: failed to write hybrid launch artifacts: ${message}`);
    }
    detached = false;
  }

  return {
    runId,
    strategy: "hybrid_external_main_native_panels",
    runDir,
    supervisorStatePath,
    supervisorPid,
    readyAt,
    mainModelId: mainModel.modelId,
    panelModelIds: resolved.panelModels.map((spec) => spec.modelId),
    judgeModelId: resolved.judgeModel.modelId,
    detached,
  };
}

export type ForegroundLaunchInput = {
  task: string;
  cwd: string;
  traceDir?: string;
  command?: string;
  sourceWorkspace?: string;
  panelModels?: string[];
  judgeModel?: string;
  mainModel?: string;
  invokingSessionModelId?: string;
  /** Skip the installed-command/runtime-manifest compatibility check (tests). */
  skipRuntimeCheck?: boolean;
  /** Legacy single launch override (ms); seeds external-main + registration deadlines. */
  startupDeadlineMs?: number;
  /** Short external-main PID startup guard (ms). */
  externalMainStartupDeadlineMs?: number;
  /** begin_native_wave registration deadline (ms). */
  nativeDispatchRegistrationDeadlineMs?: number;
  /** Real long-running native panel execution timeout (ms). */
  nativePanelExecutionTimeoutMs?: number;
  /** Skip the duplicate-active-run guard (tests). */
  skipDuplicateRunGuard?: boolean;
  deps?: Partial<SupervisorDeps>;
};

/**
 * Foreground, model-driven hybrid launch. Performs the safe bootstrap, spawns
 * the external main builder to a real PID, and prepares the three native panel
 * dispatch specs for the parent model to launch as visible Task subagents in a
 * single wave. Unlike the legacy detached path, this NEVER returns an early
 * "ready/running" receipt with workers still queued: it returns the real main
 * PID plus ready panel dispatch specs, or fails loudly within the startup
 * deadline.
 */
export async function launchForegroundHybrid(input: ForegroundLaunchInput): Promise<HybridLaunchPlan> {
  if (!input.skipRuntimeCheck) {
    try {
      await assertForegroundProtocolCompatible();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("FUSION_RUNTIME_PROTOCOL_MISMATCH")) throw error;
      throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: ${message}`);
    }
  }
  if (input.command === "fusion-no-build") {
    throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: /fusion-no-build must not launch a supervisor or worker process");
  }

  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const mainModel = resolveMainModelSpec({ explicit: input.mainModel, invokingSessionModelId: input.invokingSessionModelId });
  const runId = createRunId();
  const projectCwd = path.resolve(input.cwd);
  const sourceWorkspace = path.resolve(input.sourceWorkspace ?? input.cwd);

  // Duplicate-run safety: do not start a new run while an earlier run still owns
  // an active external main builder in the same source workspace.
  if (!input.skipDuplicateRunGuard) {
    await assertNoActiveRunForWorkspace(projectCwd, input.traceDir, sourceWorkspace);
  }

  const deps: SupervisorDeps = {
    cwd: projectCwd,
    traceDir: input.traceDir,
    startupDeadlineMs: input.startupDeadlineMs,
    externalMainStartupDeadlineMs: input.externalMainStartupDeadlineMs,
    nativeDispatchRegistrationDeadlineMs: input.nativeDispatchRegistrationDeadlineMs,
    nativePanelExecutionTimeoutMs: input.nativePanelExecutionTimeoutMs,
    ...input.deps,
  };

  return hybridLaunch(
    {
      runId,
      task: input.task,
      command: input.command ?? "fusion-build",
      mainModel,
      invokingSessionModelId: input.invokingSessionModelId,
      panelModels: resolved.panelModels,
      judgeModel: resolved.judgeModel,
      modelConfigFingerprint: resolved.fingerprint,
      sourceWorkspace,
    },
    deps,
  );
}

const ACTIVE_RUN_TERMINAL_PHASES: ReadonlySet<SupervisorState["phase"]> = new Set([
  "done",
  "aborted",
  "cancelled",
  "timed_out",
]);

/**
 * Duplicate-run safety: refuse to start a new run while the most recent run in
 * the same source workspace is still non-terminal AND still owns a live external
 * main builder PID. The user must explicitly cancel/resolve it first. This never
 * auto-cancels and never auto-launches a replacement.
 */
export async function assertNoActiveRunForWorkspace(
  cwd: string,
  traceDir: string | undefined,
  sourceWorkspace: string,
): Promise<void> {
  const latest = await loadLatestSupervisorTrace(cwd, traceDir);
  if (!latest || latest.kind !== "supervisor") return;
  const state = latest.state;
  if (path.resolve(state.sourceWorkspace) !== path.resolve(sourceWorkspace)) return;
  if (ACTIVE_RUN_TERMINAL_PHASES.has(state.phase)) return;
  const mainPid = state.workers[WORKER_ID.main]?.pid ?? state.externalMain?.pid;
  if (mainPid === undefined || !isPidAlive(mainPid)) return;
  throw new Error(
    `FUSION_DUPLICATE_ACTIVE_RUN: run ${state.runId} still owns an active main builder ` +
      `(pid ${mainPid}, phase ${state.phase}) in this source workspace. ` +
      `Cancel it first with fusion_supervisor stage "cancel" (runId ${state.runId}) or resume it, ` +
      "then retry. A new Fusion run is NOT started automatically.",
  );
}

export type SupervisorStatusReport = {
  found: boolean;
  runId?: string;
  phase?: string;
  workers?: Array<{ workerId: string; pid?: number; alive: boolean; status: string }>;
  concurrencyVerdict?: string;
  trace?: string;
};

export async function reportSupervisorStatus(
  runId: string,
  cwd: string,
  traceDir?: string,
): Promise<SupervisorStatusReport> {
  const state = await loadSupervisorState(cwd, runId, traceDir);
  if (!state) return { found: false };
  return {
    found: true,
    runId: state.runId,
    phase: state.phase,
    workers: liveWorkerSummary(state),
    concurrencyVerdict: state.concurrency.verdict,
    trace: renderSupervisorTrace(state),
  };
}

export type LatestSupervisorTraceResult =
  | { kind: "supervisor"; state: SupervisorState }
  | { kind: "initialization_failure"; runId: string; error: string }
  | undefined;

/**
 * Load the most recent hybrid_external_main_native_panels supervisor run. Prefers the
 * explicit latest-supervisor-run pointer; falls back to scanning run
 * directories only when no pointer exists.
 */
export async function loadLatestSupervisorTrace(
  cwd: string,
  traceDir?: string,
): Promise<LatestSupervisorTraceResult> {
  const root = resolveTraceRoot(cwd, traceDir);
  let runId: string | undefined;
  try {
    const pointerPath = path.join(root, SUPERVISOR_LATEST_POINTER);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      runId?: string;
      timestamp?: string;
    };
    runId = pointer.runId;
  } catch {
    // ignore missing pointer
  }

  if (!runId) {
    return undefined;
  }

  let state = await loadSupervisorState(cwd, runId, traceDir);
  if (!state) {
    // The cwd-relative pointer named a run we cannot read from this directory.
    // Fall back to the durable registry before giving up.
    const resolved = await loadSupervisorStateByRunId(runId, cwd, traceDir);
    if (resolved) state = resolved.state;
  }
  if (!state) {
    return { kind: "initialization_failure", runId, error: `supervisor-state.json missing for run ${runId}` };
  }
  return { kind: "supervisor", state };
}

/**
 * Resolve a supervisor run by ID regardless of the current working directory or
 * active agent directory. Tries the cwd-relative trace root first, then the
 * durable workspace-independent run registry (registry entry → its own
 * cwd/traceDir → state). Returns the located state plus where it was found.
 */
export async function loadSupervisorStateByRunId(
  runId: string,
  cwd: string,
  traceDir?: string,
): Promise<{ state: SupervisorState; cwd: string; traceDir?: string; runDir: string } | undefined> {
  const direct = await loadSupervisorState(cwd, runId, traceDir);
  if (direct) {
    return { state: direct, cwd, traceDir, runDir: supervisorRunDir(cwd, runId, traceDir) };
  }
  const entry = await resolveRunFromRegistry(runId);
  if (!entry) return undefined;
  const fromRegistry = await loadSupervisorState(entry.cwd, runId, entry.traceDir);
  if (!fromRegistry) return undefined;
  return {
    state: fromRegistry,
    cwd: entry.cwd,
    traceDir: entry.traceDir,
    runDir: entry.runDir,
  };
}

/**
 * Latest supervisor run resolved through the durable registry (not cwd). Used by
 * /fusion-trace as a final fallback so a known active run is never reported as
 * "no trace found" just because the active directory changed.
 */
export async function loadLatestSupervisorTraceFromRegistry(): Promise<LatestSupervisorTraceResult> {
  const entry = await latestRunFromRegistry();
  if (!entry) return undefined;
  const state = await loadSupervisorState(entry.cwd, entry.runId, entry.traceDir);
  if (!state) {
    return { kind: "initialization_failure", runId: entry.runId, error: `supervisor-state.json missing for run ${entry.runId}` };
  }
  return { kind: "supervisor", state };
}
