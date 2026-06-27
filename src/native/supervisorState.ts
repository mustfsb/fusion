import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { resolveTraceRoot } from "../trace/runTrace.js";
import { assertValidFusionRunId } from "./runLocator.js";
import { upsertRunRegistry } from "./runRegistry.js";
import type { SupervisorState, WorkerRecord, WorkerStatus } from "./supervisorTypes.js";

export const SUPERVISOR_STATE_FILENAME = "supervisor-state.json";

export function supervisorStatePath(cwd: string, runId: string, traceDir?: string): string {
  assertValidFusionRunId(runId);
  return path.join(resolveTraceRoot(cwd, traceDir), runId, SUPERVISOR_STATE_FILENAME);
}

export function supervisorRunDir(cwd: string, runId: string, traceDir?: string): string {
  assertValidFusionRunId(runId);
  return path.join(resolveTraceRoot(cwd, traceDir), runId);
}

let stateWriteCounter = 0;

export async function writeSupervisorState(
  state: SupervisorState,
  cwd: string,
  traceDir?: string,
): Promise<string> {
  const filePath = supervisorStatePath(cwd, state.runId, traceDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  // Unique temp suffix so concurrent writes from the same supervisor process
  // (main pipeline + panel pipeline run in parallel) never collide on the same
  // temp filename.
  stateWriteCounter += 1;
  const tmp = `${filePath}.${process.pid}.${stateWriteCounter}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
  // Keep the durable, workspace-independent run registry pointed at this run so
  // /fusion-trace can locate it by ID regardless of the active directory.
  await upsertRunRegistry({
    runId: state.runId,
    runDir: path.dirname(filePath),
    cwd: path.resolve(cwd),
    traceDir,
    sourceWorkspace: state.sourceWorkspace,
    phase: state.phase,
    strategy: state.strategy,
    updatedAt: state.updatedAt,
  });
  return filePath;
}

export async function loadSupervisorState(
  cwd: string,
  runId: string,
  traceDir?: string,
): Promise<SupervisorState | undefined> {
  const candidates = [
    supervisorStatePath(cwd, runId, traceDir),
    // Legacy layout before canonical `.opencode/fusion-runs/<runId>`.
    path.join(path.resolve(cwd), runId, SUPERVISOR_STATE_FILENAME),
  ];
  for (const filePath of candidates) {
    try {
      const text = await readFile(filePath, "utf8");
      return JSON.parse(text) as SupervisorState;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/** Record a status transition, keeping the worker's audit trail honest. */
export function transitionWorker(
  worker: WorkerRecord,
  status: WorkerStatus,
  at: string,
  reason?: string,
): void {
  if (worker.status === status) return;
  worker.status = status;
  worker.statusTransitions.push({ status, at, reason });
}
