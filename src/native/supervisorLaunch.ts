import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import { resolveModels } from "../modelConfig.js";
import { createRunId, resolveTraceRoot } from "../trace/runTrace.js";
import { bootstrapRealParallelBuild, liveWorkerSummary, type SupervisorDeps } from "./fusionSupervisor.js";
import { loadSupervisorState, supervisorRunDir } from "./supervisorState.js";
import { renderSupervisorTrace } from "./supervisorTrace.js";
import { assertFreshBuildRuntimeCompatible } from "./runtimeInstall.js";
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
 * Resolve the main builder / patch worker model. Fusion's saved config only
 * carries panel + judge models, so the main model is sourced (in order) from an
 * explicit override, the `FUSION_MAIN_MODEL` env, then the first panel model.
 * No provider is ever hardcoded.
 */
export function resolveMainModelSpec(panelModels: FusionModelSpec[], explicit?: string): FusionModelSpec {
  if (explicit) return { modelId: explicit };
  if (process.env.FUSION_MAIN_MODEL) return { modelId: process.env.FUSION_MAIN_MODEL };
  return panelModels[0];
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
      await assertFreshBuildRuntimeCompatible();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("FUSION_RUNTIME_INSTALL_MISMATCH")) {
        throw error;
      }
      throw new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: ${message}`);
    }
  }

  if (input.command === "fusion-no-build") {
    throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: /fusion-no-build must not launch a supervisor or worker process");
  }

  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const mainModel = resolveMainModelSpec(resolved.panelModels, input.mainModel);
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
        panelModels: resolved.panelModels,
        judgeModel: resolved.judgeModel,
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

  const state = await loadSupervisorState(cwd, runId, traceDir);
  if (!state) {
    return { kind: "initialization_failure", runId, error: `supervisor-state.json missing for run ${runId}` };
  }
  return { kind: "supervisor", state };
}
