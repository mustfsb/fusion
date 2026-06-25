import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FusionModelSpec } from "../modelSpec.js";
import { resolveModels } from "../modelConfig.js";
import { createRunId } from "../trace/runTrace.js";
import { bootstrapRealParallelBuild, liveWorkerSummary, type SupervisorDeps } from "./fusionSupervisor.js";
import { loadSupervisorState, supervisorRunDir } from "./supervisorState.js";
import { renderSupervisorTrace } from "./supervisorTrace.js";

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
  deps?: Partial<SupervisorDeps>;
};

export type LaunchResult = {
  runId: string;
  strategy: "real_parallel_process_build";
  runDir: string;
  supervisorStatePath: string;
  supervisorPid?: number;
  mainModelId: string;
  panelModelIds: string[];
  judgeModelId: string;
  detached: boolean;
};

function supervisorMainEntry(): string {
  // Sibling of this module in dist/native. In source/test runs this resolves to
  // the .ts via tsx; in production it resolves to the compiled .js.
  return fileURLToPath(new URL("./supervisorMain.js", import.meta.url));
}

/**
 * Minimal safe bootstrap + detached supervisor launch for the default
 * `real_parallel_process_build` strategy. Returns immediately after the
 * immutable snapshot and worker bootstrap; the detached supervisor owns the
 * remainder of the run and survives parent session closure.
 */
export async function launchRealParallelBuild(input: LaunchInput): Promise<LaunchResult> {
  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const mainModel = resolveMainModelSpec(resolved.panelModels, input.mainModel);
  const runId = createRunId();
  const sourceWorkspace = path.resolve(input.sourceWorkspace ?? input.cwd);
  const deps: SupervisorDeps = { cwd: input.cwd, traceDir: input.traceDir, ...input.deps };

  await bootstrapRealParallelBuild(
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

  const runDir = supervisorRunDir(input.cwd, runId, input.traceDir);
  const supervisorStatePath = path.join(runDir, "supervisor-state.json");

  let supervisorPid: number | undefined;
  let detached = false;
  if (input.inline) {
    // Tests / restricted environments drive the supervisor in-process.
    const { superviseRun } = await import("./fusionSupervisor.js");
    await superviseRun(runId, deps);
  } else {
    await mkdir(path.join(runDir, "logs"), { recursive: true });
    const logFd = openSync(path.join(runDir, "logs", "supervisor.log"), "a");
    const child = spawn(process.execPath, [supervisorMainEntry()], {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        FUSION_SUPERVISOR_RUN_ID: runId,
        FUSION_SUPERVISOR_CWD: input.cwd,
        ...(input.traceDir ? { FUSION_SUPERVISOR_TRACE_DIR: input.traceDir } : {}),
      },
    });
    supervisorPid = child.pid;
    child.unref();
    detached = true;
  }

  return {
    runId,
    strategy: "real_parallel_process_build",
    runDir,
    supervisorStatePath,
    supervisorPid,
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
