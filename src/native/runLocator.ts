import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveTraceRoot } from "../trace/runTrace.js";
import { FusionCouncilError } from "../utils/errors.js";
import type { RunState } from "./runState.js";
import { FUSION_RUN_STATE_LIFECYCLE_VERSION } from "./runState.js";

const NORMAL_RUN_ID_PATTERN = /^fusion-\d{8}-\d{6}-[0-9a-f]{6}$/;
const RECOVERED_RUN_ID_PATTERN = /^fusion-\d{8}-\d{6}-recovered-[0-9a-f]{6}$/;

export type FusionRunLocatorInput = {
  runId: string;
  traceArtifactDir: string;
  runStatePath: string;
  expectedSourceWorkspace: string;
};

export function isValidFusionRunId(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (/[/\\]/.test(trimmed)) return false;
  return NORMAL_RUN_ID_PATTERN.test(trimmed) || RECOVERED_RUN_ID_PATTERN.test(trimmed);
}

export function assertValidFusionRunId(runId: string): void {
  if (!isValidFusionRunId(runId)) {
    throw new FusionCouncilError(
      `FUSION_RUN_ID_INVALID: run ID must be a non-empty fusion run identifier; received ${JSON.stringify(runId)}`,
    );
  }
}

export function resolveRunLocatorPaths(
  cwd: string,
  runId: string,
  traceDir?: string,
): { traceArtifactDir: string; runStatePath: string } {
  assertValidFusionRunId(runId);
  const traceArtifactDir = path.join(resolveTraceRoot(cwd, traceDir), runId);
  const runStatePath = path.join(traceArtifactDir, "run-state.json");
  return { traceArtifactDir, runStatePath };
}

export async function assertValidFusionRunLocator(input: FusionRunLocatorInput): Promise<RunState> {
  assertValidFusionRunId(input.runId);
  const runId = input.runId.trim();
  const traceArtifactDir = path.resolve(input.traceArtifactDir);
  const runStatePath = path.resolve(input.runStatePath);
  const expectedSource = path.resolve(input.expectedSourceWorkspace);

  if (path.basename(traceArtifactDir) !== runId) {
    throw new FusionCouncilError(
      `FUSION_RUN_LOCATOR_MISMATCH: trace artifact directory basename "${path.basename(traceArtifactDir)}" must equal run ID "${runId}"`,
    );
  }

  if (path.basename(runStatePath) !== "run-state.json") {
    throw new FusionCouncilError(
      `FUSION_RUN_LOCATOR_MISMATCH: run state path must end with run-state.json; received ${runStatePath}`,
    );
  }

  if (path.dirname(runStatePath) !== traceArtifactDir) {
    throw new FusionCouncilError(
      `FUSION_RUN_LOCATOR_MISMATCH: run-state must live inside the trace artifact directory (${traceArtifactDir}); received ${runStatePath}`,
    );
  }

  let stateText: string;
  try {
    stateText = await readFile(runStatePath, "utf8");
  } catch {
    throw new FusionCouncilError(`FUSION_RUN_STATE_NOT_FOUND: no run-state at ${runStatePath}`);
  }

  let state: RunState;
  try {
    state = JSON.parse(stateText) as RunState;
  } catch {
    throw new FusionCouncilError(`FUSION_RUN_STATE_INVALID: run-state at ${runStatePath} is not valid JSON`);
  }

  if (!state.lifecycleVersion || state.lifecycleVersion < FUSION_RUN_STATE_LIFECYCLE_VERSION) {
    throw new FusionCouncilError(
      `FUSION_RUN_STATE_UNSUPPORTED: unsupported or missing lifecycle schema version (expected >= ${FUSION_RUN_STATE_LIFECYCLE_VERSION})`,
    );
  }

  if (state.runId !== runId) {
    throw new FusionCouncilError(
      `FUSION_RUN_ID_MISMATCH: run-state run ID "${state.runId}" does not match supplied run ID "${runId}"`,
    );
  }

  const stateWorkspace = state.sourceWorkspace ?? state.speculative?.sourceWorkspace;
  if (!stateWorkspace || path.resolve(stateWorkspace) !== expectedSource) {
    throw new FusionCouncilError(
      `FUSION_RUN_WORKSPACE_MISMATCH: run-state source workspace "${stateWorkspace ?? "missing"}" does not match expected workspace "${expectedSource}"`,
    );
  }

  return state;
}
