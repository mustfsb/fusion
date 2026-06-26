import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { resolveTraceRoot } from "../trace/runTrace.js";
import { assertValidFusionRunId } from "./runLocator.js";
import type { SupervisorState, WorkerRecord, WorkerStatus } from "./supervisorTypes.js";

/**
 * Durable persistence for the detached supervisor. State is the single source
 * of truth that survives parent/orchestrator session closure, OpenCode restart,
 * and plugin reload. Writes are atomic (temp + rename) so a crash mid-write
 * never corrupts the run.
 */

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
  return filePath;
}

export async function loadSupervisorState(
  cwd: string,
  runId: string,
  traceDir?: string,
): Promise<SupervisorState | undefined> {
  try {
    const text = await readFile(supervisorStatePath(cwd, runId, traceDir), "utf8");
    return JSON.parse(text) as SupervisorState;
  } catch {
    return undefined;
  }
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
