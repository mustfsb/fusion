import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import { assertValidFusionRunId } from "./runLocator.js";
import { FUSION_AGENT_NAMES } from "./agentTemplates.js";
import {
  captureBaselineManifest,
  createImmutableSourceSnapshot,
  diffAgainstBaseline,
  loadBaselineManifest,
  materializeCandidateWorkspaceFromSnapshot,
} from "./candidateWorkspace.js";
import { classifyCandidateEvidence } from "./candidateClassification.js";
import { buildSpeculativeWorkspacePaths } from "./speculativeWorkspacePaths.js";
import {
  loadSupervisorState,
  supervisorRunDir,
  transitionWorker,
  writeSupervisorState,
} from "./supervisorState.js";
import {
  DEFAULT_SUPERVISOR_TIMEOUTS,
  SUPERVISOR_STATE_VERSION,
  WORKER_ID,
  isTerminalWorkerStatus,
  type SupervisorState,
  type SupervisorTimeouts,
  type WorkerRecord,
  type WorkerResultArtifact,
  type WorkerRole,
} from "./supervisorTypes.js";
import {
  createOpenCodeProcessWorkerRunner,
  isPidAlive,
  type SpawnedWorkerHandle,
  type WorkerRunner,
  type WorkerSpawnSpec,
} from "./workerRunner.js";
import {
  buildHybridJudgeDispatchPrompt,
  buildHybridPanelDispatchPrompt,
  formatNativePanelDispatchFailure,
  FusionNativePanelDispatchError,
  NATIVE_TASK_DISPATCH_MECHANISM,
  type NativeDispatchRequest,
  type NativeSubagentDispatcher,
  validateNativeJudgeAgent,
  validateNativePanelAgents,
} from "./nativeSubagentDispatch.js";
import { candidatePanelOutputPaths } from "./candidateWorkspace.js";
import { buildPanelExecutionContext } from "./speculativeBuild.js";
import { confirmSupervisorReady, supervisorMainEntry } from "./supervisorStartup.js";

const PANEL_COUNT = 3;

export type BootstrapInput = {
  runId: string;
  task: string;
  command?: string;
  /** Resolved main builder + patch worker model. */
  mainModel: FusionModelSpec;
  /** Resolved panel models (1..3). */
  panelModels: FusionModelSpec[];
  /** Resolved judge model. */
  judgeModel: FusionModelSpec;
  /** Real user source workspace owned by the main builder. */
  sourceWorkspace: string;
};

export type SupervisorDeps = {
  cwd: string;
  traceDir?: string;
  runner?: WorkerRunner;
  nativeDispatcher?: NativeSubagentDispatcher;
  agentDir?: string;
  now?: () => number;
  /** Test-only artificial panel workspace delays, never used in production routing. */
  panelWorkspacePreparationDelayMs?: Partial<Record<1 | 2 | 3, number>>;
  /** Liveness poll interval. */
  pollIntervalMs?: number;
  /** Test helper: perform the ready handshake when phase is still bootstrapping. */
  autoConfirmReady?: boolean;
  timeouts?: Partial<SupervisorTimeouts>;
  /** Test helper: skip native agent file validation. */
  skipNativeAgentValidation?: boolean;
  /** Test helper: keep fake native dispatcher worker lookup in sync with supervisor state. */
  syncWorkers?: (workers: Record<string, WorkerRecord>) => void;
};

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function hashTask(task: string): string {
  return createHash("sha256").update(task, "utf8").digest("hex");
}

function modelVariant(spec: FusionModelSpec): string | undefined {
  return spec.reasoningEffort && spec.reasoningEffort !== "none" ? spec.reasoningEffort : undefined;
}

function resolveTimeouts(partial?: Partial<SupervisorTimeouts>): SupervisorTimeouts {
  return { ...DEFAULT_SUPERVISOR_TIMEOUTS, ...(partial ?? {}) };
}

function workerArtifactPaths(runDir: string, workerId: string) {
  return {
    instructionArtifactPath: path.join(runDir, `${workerId}-instructions.md`),
    resultArtifactPath: path.join(runDir, `${workerId}-result.json`),
    statusArtifactPath: path.join(runDir, `${workerId}-status.json`),
    stdoutPath: path.join(runDir, "logs", `${workerId}.stdout.log`),
    stderrPath: path.join(runDir, "logs", `${workerId}.stderr.log`),
  };
}

function buildTaskArtifact(task: string) {
  const taskContent = `# Fusion Canonical Task\n\n${task}\n`;
  return {
    taskContent,
    taskArtifactHash: hashTask(taskContent),
  };
}

function buildWorkerPrompt(input: {
  role: WorkerRole;
  workerId: string;
  workspacePath: string;
  taskArtifactPath: string;
  resultArtifactPath: string;
  sourceWorkspaceProhibited?: string;
  contractPath?: string;
  logicalPanelIndex?: number;
}): string {
  const lines: string[] = [];
  lines.push(`You are Fusion worker ${input.workerId} (role: ${input.role}).`);
  lines.push(`Your absolute workspace: ${input.workspacePath}`);
  lines.push(`Read the canonical task fully until EOF: ${input.taskArtifactPath}`);
  if (input.role === "main") {
    lines.push("You are an independent implementation worker.");
    lines.push(`Your writable candidate workspace: ${input.workspacePath}`);
    if (input.sourceWorkspaceProhibited) {
      lines.push(`The source workspace is prohibited: ${input.sourceWorkspaceProhibited}`);
      lines.push("Other candidate workspaces are prohibited.");
    }
    lines.push("Use only your candidate workspace for source reads, writes, tests, package commands, and Git commands.");
    lines.push("Before modifying files, verify the current directory is your candidate workspace.");
    lines.push("Never modify the source workspace. Never copy code from another candidate workspace.");
    lines.push("Implement the task independently in THIS candidate workspace only.");
    lines.push("Do NOT wait for or read any panel candidate workspace, judge, or merge patch contract.");
    lines.push("Run typecheck/test/build inside your candidate workspace.");
  } else if (input.role === "panel") {
    lines.push(`You are panel slot ${input.logicalPanelIndex}.`);
    lines.push("Implement the task in YOUR candidate workspace only.");
    if (input.sourceWorkspaceProhibited) {
      lines.push(`NEVER write to the prohibited source workspace: ${input.sourceWorkspaceProhibited}`);
    }
    lines.push("Do NOT wait for another panel or the main builder.");
    lines.push("Run typecheck/test/build.");
  } else if (input.role === "judge") {
    lines.push("Compare the main implementation against all usable panel candidates.");
    lines.push("Use only the candidate/result artifact PATHS in the preflight manifest; do not request inlined source trees.");
    lines.push("Write a valid Merge Patch Contract.");
    lines.push("Apply only blocker fixes, mandatory literal requirement fixes, verified correctness fixes, safe compatibility additions, and tests needed to prove them — directly to the real source workspace.");
    lines.push("Do NOT wholesale copy a panel candidate over the main source workspace.");
  }
  lines.push(
    `When finished, write your machine-readable result JSON to: ${input.resultArtifactPath} ` +
      "(fields: workerId, role, status[completed|failed], changedFiles, verification, errorSummary, completedAt; " +
      "judge additionally writes mergePatchDecision + contractPath + appliedPatchItems). A short final chat message is fine.",
  );
  return lines.join("\n");
}

function makeWorkerRecord(input: {
  workerId: string;
  role: WorkerRole;
  executionKind: import("./supervisorTypes.js").WorkerExecutionKind;
  modelSpec: FusionModelSpec;
  workspacePath: string;
  taskArtifactPath: string;
  taskArtifactHash: string;
  runDir: string;
  softMs: number;
  hardMs: number;
  logicalPanelIndex?: number;
  agentId?: string;
}): WorkerRecord {
  const paths = workerArtifactPaths(input.runDir, input.workerId);
  return {
    workerId: input.workerId,
    role: input.role,
    executionKind: input.executionKind,
    logicalPanelIndex: input.logicalPanelIndex,
    modelId: input.modelSpec.modelId,
    configuredModelId: input.modelSpec.modelId,
    requestedModelId: input.modelSpec.modelId,
    agentId: input.agentId,
    variant: modelVariant(input.modelSpec),
    workspacePath: input.workspacePath,
    taskArtifactPath: input.taskArtifactPath,
    taskArtifactHash: input.taskArtifactHash,
    instructionArtifactPath: paths.instructionArtifactPath,
    resultArtifactPath: paths.resultArtifactPath,
    statusArtifactPath: paths.statusArtifactPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    sessionTitle: `Fusion ${input.workerId}`,
    dispatchMechanism:
      input.executionKind === "native_subagent" ? NATIVE_TASK_DISPATCH_MECHANISM : "opencode-cli-process",
    status: "queued",
    softSuspectMs: input.softMs,
    hardTimeoutMs: input.hardMs,
    statusTransitions: [],
  };
}

/**
 * Minimal safe bootstrap: capture an immutable source snapshot, materialize
 * isolated panel candidate workspaces, write canonical task + worker
 * instruction artifacts, fingerprint + lock the source, and persist initial
 * supervisor state. This is intentionally fast and never awaits any worker.
 */
export async function bootstrapRealParallelBuild(
  input: BootstrapInput,
  deps: SupervisorDeps,
): Promise<SupervisorState> {
  assertValidFusionRunId(input.runId);
  if (input.panelModels.length < PANEL_COUNT) {
    throw new Error(`hybrid_external_main_native_panels requires ${PANEL_COUNT} panel models.`);
  }
  const now = deps.now ?? Date.now;
  const timeouts = resolveTimeouts(deps.timeouts);
  const sourceWorkspace = path.resolve(input.sourceWorkspace);
  const runDir = supervisorRunDir(deps.cwd, input.runId, deps.traceDir);
  await mkdir(path.join(runDir, "logs"), { recursive: true });

  const taskArtifactPath = path.join(runDir, "canonical-task.md");
  const { taskContent, taskArtifactHash } = buildTaskArtifact(input.task);
  await writeFile(taskArtifactPath, taskContent, "utf8");

  const paths = buildSpeculativeWorkspacePaths({
    sourceWorkspace,
    sourceArtifactDir: runDir,
    runId: input.runId,
    panelCount: PANEL_COUNT,
  });
  if (!paths.mainWorkspacePath) {
    throw new Error("hybrid_external_main_native_panels requires a main candidate workspace path");
  }
  const mainWorkspacePath = paths.mainWorkspacePath;
  const sourceSnapshotManifestPath = path.join(runDir, "source-snapshot-manifest.json");
  const sourceSnapshotWorkspacePath = path.join(paths.externalStagingDir, "source-snapshot");

  const launchRequestedAt = nowIso(now);

  const workers: Record<string, WorkerRecord> = {};
  const mainWorker = makeWorkerRecord({
    workerId: WORKER_ID.main,
    role: "main",
    executionKind: "external_process",
    modelSpec: input.mainModel,
    workspacePath: mainWorkspacePath,
    taskArtifactPath,
    taskArtifactHash,
    runDir,
    softMs: timeouts.mainSoftSuspectMs,
    hardMs: timeouts.mainHardTimeoutMs,
  });
  workers[mainWorker.workerId] = mainWorker;

  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const agentId = FUSION_AGENT_NAMES[`panel${index}` as "panel1" | "panel2" | "panel3"];
    const panelWorker = makeWorkerRecord({
      workerId: WORKER_ID.panel(index),
      role: "panel",
      executionKind: "native_subagent",
      modelSpec: input.panelModels[index - 1],
      workspacePath: paths.panelWorkspacePaths[index - 1],
      taskArtifactPath,
      taskArtifactHash,
      runDir,
      softMs: timeouts.panelSoftSuspectMs,
      hardMs: timeouts.panelHardTimeoutMs,
      logicalPanelIndex: index,
      agentId,
    });
    workers[panelWorker.workerId] = panelWorker;
  }

  // Persist worker instruction artifacts.
  for (const worker of Object.values(workers)) {
    await writeFile(
      worker.instructionArtifactPath,
      buildWorkerPrompt({
        role: worker.role,
        workerId: worker.workerId,
        workspacePath: worker.workspacePath,
        taskArtifactPath,
        resultArtifactPath: worker.resultArtifactPath,
        sourceWorkspaceProhibited: worker.role === "main" || worker.role === "panel" ? sourceWorkspace : undefined,
        logicalPanelIndex: worker.logicalPanelIndex,
      }),
      "utf8",
    );
  }

  const state: SupervisorState = {
    version: SUPERVISOR_STATE_VERSION,
    runId: input.runId,
    command: input.command ?? "fusion-build",
    strategy: "hybrid_external_main_native_panels",
    createdAt: launchRequestedAt,
    updatedAt: launchRequestedAt,
    launchRequestedAt,
    phase: "bootstrapping",
    sourceWorkspace,
    sourceFingerprint: "pending",
    runLock: undefined,
    stagingDir: paths.externalStagingDir,
    sourceSnapshotWorkspacePath,
    sourceSnapshotManifestPath,
    mainCandidateWorkspace: mainWorkspacePath,
    snapshot: {
      method: "concurrent_copy",
      startedAt: launchRequestedAt,
    },
    taskArtifactPath,
    taskArtifactHash,
    mainModelId: input.mainModel.modelId,
    judgeModelId: input.judgeModel.modelId,
    workers,
    mainPromotion: {
      candidateWorkspace: mainWorkspacePath,
      status: "pending",
    },
    judge: {},
    concurrency: {
      verdict: "HYBRID_PARALLEL_LAUNCH_NOT_CONFIRMED",
      panelsLaunched: 0,
      allLaunchTimestampsRecorded: false,
      parallelPanelDispatchIssued: false,
      noPanelViaExternalCli: true,
      mainModelMatched: false,
      blockingReason: "workers not yet launched",
    },
    conflicts: [],
  };
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const snapshotStartIso = nowIso(now);
  const snapshotStart = now();
  const snapshot = await createImmutableSourceSnapshot({
    sourceWorkspace,
    sourceArtifactDir: runDir,
    sourceSnapshotWorkspacePath,
    externalStagingDir: paths.externalStagingDir,
    now: () => new Date(now()),
  });
  const snapshotEndIso = nowIso(now);
  const snapshotEnd = now();
  state.sourceFingerprint = snapshot.sourceFingerprint;
  state.snapshot.startedAt = snapshotStartIso;
  state.snapshot.completedAt = snapshotEndIso;
  state.snapshot.durationMs = snapshotEnd - snapshotStart;
  state.sourceSnapshotManifestPath = snapshot.sourceSnapshotManifestPath;
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  // Materialize the isolated main candidate workspace from the immutable
  // snapshot. The main builder never touches the real source workspace during
  // initial implementation; promotion happens only after a successful terminal.
  const mainCandidateManifestPath = path.join(paths.externalStagingDir, "main-workspace-manifest.json");
  const mainCandidate = await materializeCandidateWorkspaceFromSnapshot({
    logicalPanelIndex: 0,
    sourceSnapshotWorkspacePath,
    sourceSnapshotManifestPath: snapshot.sourceSnapshotManifestPath,
    candidateWorkspacePath: mainWorkspacePath,
    candidateManifestPath: mainCandidateManifestPath,
    sourceArtifactDir: runDir,
    now: () => new Date(now()),
  });
  mainWorker.workspacePath = mainCandidate.workspacePath;
  mainWorker.workspaceReadyAt = nowIso(now);
  state.mainCandidateWorkspace = mainCandidate.workspacePath;
  state.mainPromotion.candidateWorkspace = mainCandidate.workspacePath;
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  return state;
}

async function readResultArtifact(filePath: string): Promise<WorkerResultArtifact | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as WorkerResultArtifact;
  } catch {
    return undefined;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return -1;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function workerEnv(state: SupervisorState, worker: WorkerRecord): Record<string, string> {
  return {
    FUSION_RUN_ID: state.runId,
    FUSION_WORKER_ID: worker.workerId,
    FUSION_WORKER_ROLE: worker.role,
    FUSION_WORKSPACE: worker.workspacePath,
    FUSION_TASK_ARTIFACT: worker.taskArtifactPath,
    FUSION_TASK_HASH: worker.taskArtifactHash,
    FUSION_INSTRUCTION_ARTIFACT: worker.instructionArtifactPath,
    FUSION_RESULT_ARTIFACT: worker.resultArtifactPath,
    FUSION_STATUS_ARTIFACT: worker.statusArtifactPath,
    FUSION_REQUESTED_MODEL: worker.requestedModelId ?? worker.configuredModelId ?? worker.modelId,
  };
}

function workerAgent(worker: WorkerRecord): string | undefined {
  // External workers never use fusion panel/judge agent identities.
  return undefined;
}

function splitModelId(modelId: string): { providerId: string; modelName: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { providerId: "unknown", modelName: modelId };
  return { providerId: modelId.slice(0, slash), modelName: modelId.slice(slash + 1) };
}

async function parseObservedMainModel(stdoutPath: string): Promise<{ providerId?: string; modelId?: string }> {
  try {
    const text = await readFile(stdoutPath, "utf8");
    const match = text.match(/\[fake-opencode\][^\n]*observedModel=([^\s]+)/)
      ?? text.match(/observedModel=([^\s]+)/)
      ?? text.match(/FUSION_OBSERVED_MODEL=([^\s]+)/);
    if (!match?.[1]) return {};
    const observed = match[1];
    const { providerId, modelName } = splitModelId(observed);
    return { providerId, modelId: observed || modelName };
  } catch {
    return {};
  }
}

async function enforceMainModelMatch(worker: WorkerRecord): Promise<boolean> {
  const observed = await parseObservedMainModel(worker.stdoutPath);
  if (observed.providerId) worker.observedProviderId = observed.providerId;
  if (observed.modelId) worker.observedModelId = observed.modelId;
  const expected = worker.requestedModelId ?? worker.configuredModelId ?? worker.modelId;
  if (observed.modelId && observed.modelId !== expected) {
    transitionWorker(worker, "failed", new Date().toISOString(), "FUSION_MAIN_MODEL_MISMATCH");
    return false;
  }
  return true;
}

async function spawnWorker(
  state: SupervisorState,
  worker: WorkerRecord,
  runner: WorkerRunner,
  now: () => number,
): Promise<SpawnedWorkerHandle> {
  worker.launchRequestedAt = nowIso(now);
  transitionWorker(worker, "spawning", worker.launchRequestedAt);
  const promptText = await readFile(worker.instructionArtifactPath, "utf8").catch(() => worker.workerId);
  const spec: WorkerSpawnSpec = {
    workerId: worker.workerId,
    role: worker.role,
    modelId: worker.modelId,
    variant: worker.variant,
    agent: workerAgent(worker),
    workspacePath: worker.workspacePath,
    sessionTitle: worker.sessionTitle,
    promptText,
    env: workerEnv(state, worker),
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
  };
  try {
    const handle = await runner.spawn(spec);
    if (handle.pid === undefined) {
      const reason = "spawn returned no PID";
      transitionWorker(worker, "failed", nowIso(now), reason);
      throw new Error(`${worker.workerId}: ${reason}`);
    }
    worker.pid = handle.pid;
    worker.spawnedAt = nowIso(now);
    transitionWorker(worker, "running", worker.spawnedAt);
    return handle;
  } catch (error) {
    if (worker.status === "spawning") {
      const reason = error instanceof Error ? error.message : String(error);
      transitionWorker(worker, "failed", nowIso(now), reason);
    }
    throw error;
  }
}

type WorkerMonitor = {
  worker: WorkerRecord;
  handle?: SpawnedWorkerHandle;
  exited: boolean;
  exitObserved: boolean;
  lastStdout: number;
  lastStderr: number;
  native?: boolean;
};

async function preparePanelWorkspace(
  state: SupervisorState,
  logicalPanelIndex: 1 | 2 | 3,
  deps: SupervisorDeps,
  now: () => number,
): Promise<WorkerRecord> {
  const worker = state.workers[WORKER_ID.panel(logicalPanelIndex)];
  const artificialDelayMs = deps.panelWorkspacePreparationDelayMs?.[logicalPanelIndex] ?? 0;
  if (artificialDelayMs > 0) {
    await delay(artificialDelayMs);
  }
  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const candidate = await materializeCandidateWorkspaceFromSnapshot({
    logicalPanelIndex,
    sourceSnapshotWorkspacePath: state.sourceSnapshotWorkspacePath,
    sourceSnapshotManifestPath: state.sourceSnapshotManifestPath,
    candidateWorkspacePath: worker.workspacePath,
    candidateManifestPath: path.join(state.stagingDir, `panel-${logicalPanelIndex}-manifest.json`),
    sourceArtifactDir: runDir,
    now: () => new Date(now()),
  });
  worker.workspacePath = candidate.workspacePath;
  worker.workspaceReadyAt = nowIso(now);
  const outputs = candidatePanelOutputPaths(worker.workspacePath);
  const executionContextPath = path.join(runDir, `panel-${logicalPanelIndex}-execution-context.full.md`);
  await writeFile(
    executionContextPath,
    buildPanelExecutionContext({
      logicalPanelIndex,
      modelId: worker.configuredModelId ?? worker.modelId,
      candidateWorkspacePath: worker.workspacePath,
      sourceWorkspacePath: state.sourceWorkspace,
      reportPath: outputs.reportPath,
      notesPath: outputs.notesPath,
      sharedTaskPath: state.taskArtifactPath,
      resolverVersion: "hybrid_visible_native_v1",
    }),
    "utf8",
  );
  const prompt = buildHybridPanelDispatchPrompt({
    logicalPanelIndex,
    candidateWorkspace: worker.workspacePath,
    prohibitedSourceWorkspace: state.sourceWorkspace,
    taskArtifactPath: state.taskArtifactPath,
    executionContextPath,
    resultArtifactPath: worker.resultArtifactPath,
  });
  await writeFile(worker.instructionArtifactPath, prompt, "utf8");
  return worker;
}

async function spawnPrimaryWorkerMonitor(
  state: SupervisorState,
  worker: WorkerRecord,
  runner: WorkerRunner,
  now: () => number,
): Promise<WorkerMonitor | undefined> {
  try {
    const handle = await spawnWorker(state, worker, runner, now);
    const monitor: WorkerMonitor = {
      worker,
      handle,
      exited: false,
      exitObserved: false,
      lastStdout: 0,
      lastStderr: 0,
    };
    void handle.exited.then((exit) => {
      monitor.exited = true;
      worker.exitCode = exit.code;
      worker.exitSignal = exit.signal;
    });
    return monitor;
  } catch {
    return undefined;
  }
}

async function launchNativePanelsConcurrently(
  state: SupervisorState,
  panelWorkers: WorkerRecord[],
  dispatcher: NativeSubagentDispatcher,
  deps: SupervisorDeps,
  now: () => number,
): Promise<void> {
  const dispatchRequestedAt = nowIso(now);
  const requests: NativeDispatchRequest[] = await Promise.all(
    panelWorkers.map(async (worker) => ({
      agentId: worker.agentId ?? worker.workerId,
      logicalPanelIndex: worker.logicalPanelIndex as 1 | 2 | 3,
      configuredModelId: worker.configuredModelId ?? worker.modelId,
      prompt: await readFile(worker.instructionArtifactPath, "utf8"),
      description: `Fusion Panel ${worker.logicalPanelIndex}`,
      dispatchRequestedAt,
      resultArtifactPath: worker.resultArtifactPath,
      instructionArtifactPath: worker.instructionArtifactPath,
      candidateWorkspace: worker.workspacePath,
    })),
  );
  for (const worker of panelWorkers) {
    worker.dispatchRequestedAt = dispatchRequestedAt;
    transitionWorker(worker, "spawning", dispatchRequestedAt);
  }
  const receipts = await dispatcher.dispatchPanelsConcurrently(requests);
  deps.syncWorkers?.(state.workers);
  for (const receipt of receipts) {
    const worker = panelWorkers.find((w) => w.logicalPanelIndex === receipt.logicalPanelIndex);
    if (!worker) continue;
    worker.sessionId = receipt.sessionId;
    worker.dispatchedAt = receipt.dispatchedAt;
    worker.dispatchMechanism = receipt.dispatchMechanism;
    transitionWorker(worker, "running", receipt.dispatchedAt);
  }
  state.nativePanels = panelWorkers.map((worker) => ({
    panelNumber: worker.logicalPanelIndex as 1 | 2 | 3,
    sessionId: worker.sessionId,
    agentId: worker.agentId ?? worker.workerId,
    configuredModelId: worker.configuredModelId ?? worker.modelId,
    candidateWorkspace: worker.workspacePath,
    dispatchRequestedAt: worker.dispatchRequestedAt,
    dispatchedAt: worker.dispatchedAt,
    terminalAt: worker.terminalAt,
    status: worker.status,
    resultArtifactPath: worker.resultArtifactPath,
  }));
}

function resolveNativeDispatcher(deps: SupervisorDeps): NativeSubagentDispatcher {
  if (!deps.nativeDispatcher) {
    throw new Error("FUSION_NATIVE_PANEL_DISPATCH_FAILED: nativeDispatcher is required for hybrid /fusion-build runs");
  }
  return deps.nativeDispatcher;
}

async function validateHybridNativeAgents(
  state: SupervisorState,
  deps: SupervisorDeps,
  panelModels: FusionModelSpec[],
  judgeModel: FusionModelSpec,
): Promise<void> {
  if (deps.skipNativeAgentValidation) return;
  const agentDir = deps.agentDir;
  try {
    await validateNativePanelAgents(panelModels, agentDir);
    await validateNativeJudgeAgent(judgeModel, agentDir);
  } catch (error) {
    if (error instanceof FusionNativePanelDispatchError) {
      throw new Error(formatNativePanelDispatchFailure(error));
    }
    throw error;
  }
}

/**
 * Hybrid visible-native pipeline: launch ONE external main builder and dispatch
 * THREE visible native panel subagents concurrently, then monitor to terminal.
 */
export async function superviseRun(runId: string, deps: SupervisorDeps): Promise<SupervisorState> {
  assertValidFusionRunId(runId);
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const runner = deps.runner ?? createOpenCodeProcessWorkerRunner();
  const nativeDispatcher = resolveNativeDispatcher(deps);
  const state = await loadSupervisorState(deps.cwd, runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${runId}.`);
  if (state.phase === "done") return state;
  state.runLock = { pid: process.pid, acquiredAt: nowIso(now) };

  const panelModels = [1, 2, 3].map((index) => ({
    modelId: state.workers[WORKER_ID.panel(index)].configuredModelId ?? state.workers[WORKER_ID.panel(index)].modelId,
  }));
  await validateHybridNativeAgents(state, deps, panelModels, { modelId: state.judgeModelId });

  if (state.phase === "bootstrapping") {
    if (!deps.autoConfirmReady) {
      throw new Error(
        "Supervisor is still bootstrapping; detached entrypoint must confirm readiness before superviseRun.",
      );
    }
    await confirmSupervisorReady({
      runId: state.runId,
      runDir: supervisorRunDir(deps.cwd, state.runId, deps.traceDir),
      sourceWorkspace: state.sourceWorkspace,
      workingDirectory: deps.cwd,
      entrypointPath: supervisorMainEntry(),
      traceDir: deps.traceDir,
    }, { validateEntrypoint: false });
    const refreshed = await loadSupervisorState(deps.cwd, runId, deps.traceDir);
    if (refreshed) {
      Object.assign(state, refreshed);
    }
  }

  await detectSourceConflict(state, now);

  state.phase = "workers_running";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const mainWorker = state.workers[WORKER_ID.main];
  const panelWorkers: WorkerRecord[] = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)]);
  const primary = [mainWorker, ...panelWorkers];

  for (const w of primary.filter((w) => isTerminalWorkerStatus(w.status))) {
    if (!w.result) w.result = await readResultArtifact(w.resultArtifactPath);
  }

  state.externalMain = {
    pid: mainWorker.pid,
    requestedModelId: mainWorker.requestedModelId,
    configuredModelId: mainWorker.configuredModelId,
    observedProviderId: mainWorker.observedProviderId,
    observedModelId: mainWorker.observedModelId,
    workspace: mainWorker.workspacePath,
    status: mainWorker.status,
    stdoutPath: mainWorker.stdoutPath,
    stderrPath: mainWorker.stderrPath,
    launchRequestedAt: mainWorker.launchRequestedAt,
    spawnedAt: mainWorker.spawnedAt,
    endedAt: mainWorker.endedAt,
  };

  // Main pipeline: spawn external main in its isolated candidate workspace,
  // monitor to terminal, then promote into the real source workspace. This
  // does NOT wait for any panel — promotion can occur while panels still run.
  const mainPipeline = (async () => {
    if (!isTerminalWorkerStatus(mainWorker.status)) {
      const mainMonitor = await spawnPrimaryWorkerMonitor(state, mainWorker, runner, now);
      if (mainMonitor) {
        await monitorUntilTerminal([mainMonitor], state, deps, now, pollIntervalMs);
      }
    }
    await promoteMainCandidate(state, deps, now);
  })();

  // Panel pipeline: prepare isolated panel workspaces concurrently, dispatch
  // all three native subagents via a single Promise.all batch, then monitor to
  // terminal. Panel dispatches never await main or another panel's terminal.
  const pendingPanels = panelWorkers.filter((w) => !isTerminalWorkerStatus(w.status));
  state.snapshot.materializationStartedAt = nowIso(now);
  const panelPipeline = (async () => {
    if (pendingPanels.length > 0) {
      const preparedPanels = await Promise.all(
        pendingPanels.map((w) => preparePanelWorkspace(state, w.logicalPanelIndex as 1 | 2 | 3, deps, now)),
      );
      await launchNativePanelsConcurrently(state, preparedPanels, nativeDispatcher, deps, now);
    }
    const panelMonitors: WorkerMonitor[] = panelWorkers
      .filter((w) => !isTerminalWorkerStatus(w.status))
      .map((panel) => ({
        worker: panel,
        exited: false,
        exitObserved: false,
        lastStdout: 0,
        lastStderr: 0,
        native: true,
      }));
    if (panelMonitors.length > 0) {
      await monitorUntilTerminal(panelMonitors, state, deps, now, pollIntervalMs);
    }
  })();

  await Promise.all([mainPipeline, panelPipeline]);
  state.snapshot.materializationCompletedAt = nowIso(now);
  const materializationStartedMs = state.snapshot.materializationStartedAt
    ? new Date(state.snapshot.materializationStartedAt).getTime()
    : now();
  const materializationCompletedMs = state.snapshot.materializationCompletedAt
    ? new Date(state.snapshot.materializationCompletedAt).getTime()
    : now();
  state.snapshot.materializationDurationMs = materializationCompletedMs - materializationStartedMs;

  computeLaunchVerdict(state, panelWorkers);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  await classifyPanels(state);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  await runJudgeStage(state, deps, nativeDispatcher, now, pollIntervalMs);

  if (!isAbortedPhase(state)) state.phase = "done";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  return state;
}

async function monitorUntilTerminal(
  monitors: WorkerMonitor[],
  state: SupervisorState,
  deps: SupervisorDeps,
  now: () => number,
  pollIntervalMs: number,
): Promise<void> {
  if (monitors.length === 0) return;
  for (;;) {
    for (const monitor of monitors) {
      await pollWorker(monitor, now);
    }
    if (monitors.every((m) => isTerminalWorkerStatus(m.worker.status))) break;
    await writeSupervisorState(state, deps.cwd, deps.traceDir);
    await delay(pollIntervalMs);
  }
}

async function pollWorker(monitor: WorkerMonitor, now: () => number): Promise<void> {
  const { worker } = monitor;
  if (isTerminalWorkerStatus(worker.status)) return;
  const at = nowIso(now);

  const outSize = monitor.native ? 0 : await fileSize(worker.stdoutPath);
  const errSize = monitor.native ? 0 : await fileSize(worker.stderrPath);
  const resultExists = (await fileSize(worker.resultArtifactPath)) >= 0;
  const grew = outSize > monitor.lastStdout || errSize > monitor.lastStderr;
  monitor.lastStdout = Math.max(monitor.lastStdout, outSize);
  monitor.lastStderr = Math.max(monitor.lastStderr, errSize);
  if (grew || resultExists) {
    if (!worker.firstActivityAt) worker.firstActivityAt = at;
    worker.lastActivityAt = at;
  }

  if (monitor.native) {
    if (resultExists) {
      const result = await readResultArtifact(worker.resultArtifactPath);
      if (result) worker.result = result;
      worker.terminalAt = at;
      worker.endedAt = at;
      transitionWorker(worker, result?.status === "failed" ? "failed" : "completed", at, result?.errorSummary);
      return;
    }
    const startedMs = worker.dispatchedAt
      ? new Date(worker.dispatchedAt).getTime()
      : worker.spawnedAt
        ? new Date(worker.spawnedAt).getTime()
        : now();
    if (now() - startedMs >= worker.hardTimeoutMs) {
      worker.timedOutReason = `hard timeout after ${worker.hardTimeoutMs}ms with no terminal native result`;
      transitionWorker(worker, "timed_out", at, worker.timedOutReason);
      worker.endedAt = at;
      worker.terminalAt = at;
    }
    return;
  }

  if (monitor.exited) {
    monitor.exitObserved = true;
    worker.endedAt = at;
    const result = await readResultArtifact(worker.resultArtifactPath);
    if (result) worker.result = result;
    if (worker.role === "main") {
      await enforceMainModelMatch(worker);
      if (worker.status === "failed") return;
    }
    if (worker.status === "timed_out") {
      return;
    }
    const failed = (worker.exitCode ?? 1) !== 0 || result?.status === "failed";
    transitionWorker(worker, failed ? "failed" : "completed", at, result?.errorSummary);
    return;
  }

  const spawnedMs = worker.spawnedAt ? new Date(worker.spawnedAt).getTime() : now();
  if (now() - spawnedMs >= worker.hardTimeoutMs) {
    worker.timedOutReason = `hard timeout after ${worker.hardTimeoutMs}ms with no terminal exit`;
    transitionWorker(worker, "timed_out", at, worker.timedOutReason);
    worker.endedAt = at;
    const result = await readResultArtifact(worker.resultArtifactPath);
    if (result) worker.result = result;
    monitor.handle?.kill("SIGTERM");
    return;
  }

  const lastActivityMs = worker.lastActivityAt
    ? new Date(worker.lastActivityAt).getTime()
    : spawnedMs;
  if (now() - lastActivityMs >= worker.softSuspectMs && worker.status === "running") {
    transitionWorker(worker, "suspected_stalled", at, "no credible activity within soft window");
  } else if (worker.status === "suspected_stalled" && (grew || resultExists)) {
    transitionWorker(worker, "running", at, "activity resumed");
  }
}

async function detectSourceConflict(state: SupervisorState, now: () => number): Promise<void> {
  // Only meaningful before the main builder has begun mutating the real source.
  // On resume (main already ran) source divergence from the bootstrap snapshot
  // is expected, not a conflict.
  const main = state.workers[WORKER_ID.main];
  if (!main || main.status !== "queued") return;
  try {
    const manifest = await captureBaselineManifest(state.sourceWorkspace, new Date(now()));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(manifest.files), "utf8")
      .digest("hex");
    if (fingerprint !== state.sourceFingerprint) {
      state.conflicts.push({
        detectedAt: nowIso(now),
        expectedFingerprint: state.sourceFingerprint,
        actualFingerprint: fingerprint,
        detail:
          "Source workspace changed externally between bootstrap and supervisor launch; " +
          "main builder proceeds but the divergence is recorded and never silently discarded.",
      });
    }
  } catch {
    /* ignore */
  }
}

async function classifyPanels(state: SupervisorState): Promise<void> {
  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const worker = state.workers[WORKER_ID.panel(index)];
    if (!worker) continue;
    const candidateManifestPath = path.join(state.stagingDir, `panel-${index}-manifest.json`);
    const result = await classifyCandidateEvidence({
      logicalPanelIndex: index,
      sourceWorkspace: state.sourceWorkspace,
      expectedSharedPromptHash: state.taskArtifactHash,
      candidateWorkspacePath: worker.workspacePath,
      candidateBaselineManifestPath: candidateManifestPath,
      executionContextSourceWorkspacePath: state.sourceWorkspace,
      executionContextSharedTaskPath: state.taskArtifactPath,
      explicitVerification: worker.result?.verification
        ? {
            typecheck: worker.result.verification.typecheck,
            test: worker.result.verification.test,
            build: worker.result.verification.build,
            commandsRun: worker.result.verification.commandsRun ?? [],
            notes: worker.result.verification.notes ?? [],
          }
        : undefined,
      priorTerminalStatus:
        worker.status === "completed" ? "succeeded" : worker.status === "failed" ? "failed" : "unknown",
    });
    const verificationPassing =
      result.verificationSummary.typecheck !== "fail" &&
      result.verificationSummary.test !== "fail" &&
      result.verificationSummary.build !== "fail" &&
      [
        result.verificationSummary.typecheck,
        result.verificationSummary.test,
        result.verificationSummary.build,
      ].includes("pass");
    worker.candidate = {
      classification: result.classification,
      workspaceSafe: result.evidence.workspaceSafe,
      taskHashMatches: result.evidence.sharedPromptHashMatches,
      meaningfulChangedFiles: result.evidence.meaningfulChangedFiles,
      verificationPassing,
      hasTerminalResult: Boolean(worker.result) || isTerminalWorkerStatus(worker.status),
      reason: result.rerunReason,
    };
  }
}

function computeLaunchVerdict(state: SupervisorState, panelWorkers: WorkerRecord[]): void {
  const main = state.workers[WORKER_ID.main];
  const mainPidOk = main.pid !== undefined;
  const panelLaunchAt: Partial<Record<1 | 2 | 3, string>> = {};
  let panelsLaunched = 0;
  let parallelPanelDispatchIssued = true;
  const dispatchRequestedTimes = panelWorkers
    .map((panel) => (panel.dispatchRequestedAt ? new Date(panel.dispatchRequestedAt).getTime() : undefined))
    .filter((value): value is number => value !== undefined);
  if (dispatchRequestedTimes.length >= 2) {
    const spread = Math.max(...dispatchRequestedTimes) - Math.min(...dispatchRequestedTimes);
    parallelPanelDispatchIssued = spread <= 5;
  }
  let allPanelsHaveSessionId = true;
  for (const panel of panelWorkers) {
    if (panel.dispatchedAt && panel.sessionId) {
      panelsLaunched += 1;
      if (panel.logicalPanelIndex) {
        panelLaunchAt[panel.logicalPanelIndex as 1 | 2 | 3] = panel.dispatchedAt;
      }
    } else if (!isTerminalWorkerStatus(panel.status)) {
      allPanelsHaveSessionId = false;
    } else if (!panel.sessionId) {
      allPanelsHaveSessionId = false;
    }
  }
  const allLaunchTimestampsRecorded = Boolean(
    main.launchRequestedAt &&
      main.spawnedAt &&
      panelWorkers.every((panel) => panel.dispatchRequestedAt && panel.dispatchedAt),
  );
  // No panel may be launched through external opencode run.
  const noPanelViaExternalCli = panelWorkers.every(
    (panel) => panel.executionKind === "native_subagent" && panel.dispatchMechanism !== "opencode-cli-process",
  );
  const expectedMainModel = main.requestedModelId ?? main.configuredModelId ?? main.modelId;
  const mainModelMatched = !main.observedModelId || main.observedModelId === expectedMainModel;
  const confirmed =
    mainPidOk &&
    panelsLaunched === PANEL_COUNT &&
    allPanelsHaveSessionId &&
    parallelPanelDispatchIssued &&
    allLaunchTimestampsRecorded &&
    noPanelViaExternalCli &&
    mainModelMatched;
  state.concurrency = {
    verdict: confirmed ? "HYBRID_PARALLEL_LAUNCH_CONFIRMED" : "HYBRID_PARALLEL_LAUNCH_NOT_CONFIRMED",
    panelsLaunched,
    allLaunchTimestampsRecorded,
    parallelPanelDispatchIssued,
    noPanelViaExternalCli,
    mainModelMatched,
    mainLaunchAt: main.spawnedAt ?? main.launchRequestedAt,
    panelLaunchAt,
    blockingReason: confirmed
      ? undefined
      : !mainPidOk
        ? "main external process never received a PID"
        : panelsLaunched < PANEL_COUNT
          ? `only ${panelsLaunched}/${PANEL_COUNT} native panel dispatches succeeded`
          : !allPanelsHaveSessionId
            ? "one or more native panel session IDs missing"
            : !parallelPanelDispatchIssued
              ? "panel dispatch requests were not issued concurrently"
              : !allLaunchTimestampsRecorded
                ? "one or more primary launch timestamps were not recorded"
                : !noPanelViaExternalCli
                  ? "a panel was launched through external opencode run"
                  : !mainModelMatched
                    ? "main requested model differs from observed runtime model"
                    : "launch evidence incomplete",
  };
  state.externalMain = {
    pid: main.pid,
    requestedModelId: main.requestedModelId,
    configuredModelId: main.configuredModelId,
    observedProviderId: main.observedProviderId,
    observedModelId: main.observedModelId,
    workspace: main.workspacePath,
    status: main.status,
    stdoutPath: main.stdoutPath,
    stderrPath: main.stderrPath,
    launchRequestedAt: main.launchRequestedAt,
    spawnedAt: main.spawnedAt,
    endedAt: main.endedAt,
    exitCode: main.exitCode,
    promoted: state.mainPromotion.status === "promoted",
    promotionManifestPath: state.mainPromotion.manifestPath,
  };
  state.nativePanels = panelWorkers.map((worker) => ({
    panelNumber: worker.logicalPanelIndex as 1 | 2 | 3,
    sessionId: worker.sessionId,
    agentId: worker.agentId ?? worker.workerId,
    configuredModelId: worker.configuredModelId ?? worker.modelId,
    candidateWorkspace: worker.workspacePath,
    dispatchRequestedAt: worker.dispatchRequestedAt,
    dispatchedAt: worker.dispatchedAt,
    terminalAt: worker.terminalAt ?? worker.endedAt,
    status: worker.status,
    resultArtifactPath: worker.resultArtifactPath,
  }));
}

function usablePanelIndexes(state: SupervisorState): number[] {
  const indexes: number[] = [];
  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const worker = state.workers[WORKER_ID.panel(index)];
    if (worker?.candidate?.classification === "usable") indexes.push(index);
  }
  return indexes;
}

/**
 * Preserve these path roots during main candidate promotion. They are never
 * overwritten, deleted, or reset by a snapshot-relative promotion.
 */
const PROMOTION_PRESERVED_REL_PREFIXES = [".git/", ".opencode/fusion-runs/"];

function isPromotionPreservedRelPath(relPath: string): boolean {
  const normalized = relPath.replace(/^\.\//, "");
  return PROMOTION_PRESERVED_REL_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

/**
 * Promote the isolated main candidate workspace into the real source workspace
 * using a snapshot-relative diff. Creates, edits, renames and deletions are
 * applied to the source; `.git` and `.opencode/fusion-runs/<runId>` are
 * preserved; user files changed after the run started that main did not touch
 * are preserved (only main's changed paths are applied). Never uses git clean or
 * reset. Records every promoted path and writes a promotion manifest.
 */
async function promoteMainCandidate(
  state: SupervisorState,
  deps: SupervisorDeps,
  now: () => number,
): Promise<void> {
  const main = state.workers[WORKER_ID.main];

  // Resume safety: never re-promote.
  if (state.mainPromotion.status === "promoted") return;

  if (!isTerminalWorkerStatus(main.status)) {
    state.mainPromotion.status = "skipped";
    state.mainPromotion.detail = "main not terminal when promotion considered";
    return;
  }

  // Validate main candidate before promotion.
  const expectedMainModel = main.requestedModelId ?? main.configuredModelId ?? main.modelId;
  if (main.observedModelId && main.observedModelId !== expectedMainModel) {
    state.mainPromotion.status = "failed";
    state.mainPromotion.detail = "FUSION_MAIN_MODEL_MISMATCH: refusing to promote main candidate with wrong observed model";
    return;
  }
  if (main.status !== "completed") {
    state.mainPromotion.status = "failed";
    state.mainPromotion.detail = `main candidate did not reach successful terminal state (status=${main.status})`;
    return;
  }
  const result = main.result ?? (await readResultArtifact(main.resultArtifactPath));
  if (!result) {
    state.mainPromotion.status = "failed";
    state.mainPromotion.detail = "main candidate produced no result artifact";
    return;
  }
  if (main.taskArtifactHash !== state.taskArtifactHash) {
    state.mainPromotion.status = "failed";
    state.mainPromotion.detail = "main candidate task hash does not match canonical task hash";
    return;
  }

  state.phase = "promotion";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const promotionManifestPath = path.join(runDir, "main-promotion-manifest.json");
  const mainDiffPath = path.join(runDir, "main-diff-vs-snapshot.json");

  // Verify the source workspace was not mutated before promotion.
  let sourceUntouchedBeforePromotion = true;
  try {
    const currentManifest = await captureBaselineManifest(state.sourceWorkspace, new Date(now()));
    const currentFingerprint = createHash("sha256")
      .update(JSON.stringify(currentManifest.files), "utf8")
      .digest("hex");
    sourceUntouchedBeforePromotion = currentFingerprint === state.sourceFingerprint;
  } catch {
    sourceUntouchedBeforePromotion = false;
  }
  state.mainPromotion.sourceUntouchedBeforePromotion = sourceUntouchedBeforePromotion;

  // Snapshot-relative diff: changes between the immutable pre-main snapshot and
  // the main candidate workspace.
  const snapshotBaseline = await loadBaselineManifest(state.sourceSnapshotManifestPath);
  if (!snapshotBaseline) {
    state.mainPromotion.status = "failed";
    state.mainPromotion.detail = "immutable source snapshot manifest unreadable; cannot compute snapshot-relative diff";
    return;
  }
  const diff = await diffAgainstBaseline(main.workspacePath, snapshotBaseline);
  const changedPaths = [...diff.changedFiles, ...diff.addedFiles];
  const removedPaths = diff.removedFiles.filter((rel) => !isPromotionPreservedRelPath(rel));

  const promotedPaths: string[] = [];
  const preservedPaths: string[] = [];

  for (const relPath of changedPaths) {
    if (isPromotionPreservedRelPath(relPath)) {
      preservedPaths.push(relPath);
      continue;
    }
    const srcAbs = path.join(main.workspacePath, relPath);
    const destAbs = path.join(state.sourceWorkspace, relPath);
    try {
      await mkdir(path.dirname(destAbs), { recursive: true });
      await copyFile(srcAbs, destAbs);
      promotedPaths.push(relPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.mainPromotion.status = "failed";
      state.mainPromotion.detail = `failed to promote ${relPath}: ${message}`;
      await writeSupervisorState(state, deps.cwd, deps.traceDir);
      return;
    }
  }
  for (const relPath of removedPaths) {
    if (isPromotionPreservedRelPath(relPath)) {
      preservedPaths.push(relPath);
      continue;
    }
    const destAbs = path.join(state.sourceWorkspace, relPath);
    try {
      await unlink(destAbs);
      promotedPaths.push(relPath);
    } catch {
      // already absent — not an error
    }
  }

  const promotedAt = nowIso(now);
  const promotionManifest = {
    runId: state.runId,
    promotedAt,
    candidateWorkspace: main.workspacePath,
    sourceWorkspace: state.sourceWorkspace,
    sourceUntouchedBeforePromotion,
    promotedPaths,
    removedPaths,
    preservedPaths,
    mainResult: {
      status: main.status,
      changedFiles: result.changedFiles ?? [],
      verification: result.verification,
    },
  };
  await mkdir(path.dirname(promotionManifestPath), { recursive: true });
  await writeFile(promotionManifestPath, `${JSON.stringify(promotionManifest, null, 2)}\n`, "utf8");
  await writeFile(
    mainDiffPath,
    `${JSON.stringify({ changedFiles: diff.changedFiles, addedFiles: diff.addedFiles, removedFiles: diff.removedFiles }, null, 2)}\n`,
    "utf8",
  );

  state.mainPromotion = {
    candidateWorkspace: main.workspacePath,
    manifestPath: promotionManifestPath,
    promotedAt,
    status: "promoted",
    promotedPaths,
    preservedPaths,
    sourceUntouchedBeforePromotion,
  };
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
}

async function writeJudgeManifest(state: SupervisorState, deps: SupervisorDeps): Promise<string> {
  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const manifestPath = path.join(runDir, "judge-preflight-manifest.json");
  const main = state.workers[WORKER_ID.main];
  const manifest = {
    runId: state.runId,
    strategy: state.strategy,
    taskArtifactPath: state.taskArtifactPath,
    taskArtifactHash: state.taskArtifactHash,
    sourceWorkspace: state.sourceWorkspace,
    mainCandidateWorkspace: state.mainCandidateWorkspace,
    mainPromotionManifestPath: state.mainPromotion.manifestPath,
    mainDiffVsSnapshotPath: path.join(runDir, "main-diff-vs-snapshot.json"),
    main: {
      workspacePath: main.workspacePath,
      resultArtifactPath: main.resultArtifactPath,
      status: main.status,
      promoted: state.mainPromotion.status === "promoted",
      promotionManifestPath: state.mainPromotion.manifestPath,
    },
    panels: [1, 2, 3].map((index) => {
      const worker = state.workers[WORKER_ID.panel(index)];
      const outputs = worker ? candidatePanelOutputPaths(worker.workspacePath) : undefined;
      return {
        logicalPanelIndex: index,
        workspacePath: worker?.workspacePath,
        resultArtifactPath: worker?.resultArtifactPath,
        classification: worker?.candidate?.classification,
        status: worker?.status,
        reportPath: outputs?.reportPath,
        testOutputPath: outputs?.notesPath,
        artifactManifestPath: path.join(state.stagingDir, `panel-${index}-manifest.json`),
      };
    }),
    candidateValidationResults: [1, 2, 3].map((index) => ({
      logicalPanelIndex: index,
      ...state.workers[WORKER_ID.panel(index)]?.candidate,
    })),
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function runJudgeStage(
  state: SupervisorState,
  deps: SupervisorDeps,
  nativeDispatcher: NativeSubagentDispatcher,
  now: () => number,
  pollIntervalMs: number,
): Promise<void> {
  const primary = [
    state.workers[WORKER_ID.main],
    state.workers[WORKER_ID.panel(1)],
    state.workers[WORKER_ID.panel(2)],
    state.workers[WORKER_ID.panel(3)],
  ];
  if (!primary.every((w) => isTerminalWorkerStatus(w.status))) {
    state.phase = "aborted";
    state.abortReason = "judge not eligible: some primary worker is not terminal";
    return;
  }
  const existingJudge = state.workers[WORKER_ID.judge];
  if (existingJudge && existingJudge.status === "completed" && state.judge.decision) {
    return;
  }

  const usable = usablePanelIndexes(state);
  const mainUsable = state.workers[WORKER_ID.main].status === "completed";
  const mainPromoted = state.mainPromotion.status === "promoted";
  if (!mainUsable || !mainPromoted || usable.length < 1) {
    state.phase = "aborted";
    state.abortReason = `judge not dispatched: main usable=${mainUsable}, promoted=${mainPromoted}, usable panels=${usable.length}`;
    state.judge.usablePanelIndexes = usable;
    return;
  }

  state.phase = "judge";
  state.judge.eligibleAt = nowIso(now);
  state.judge.usablePanelIndexes = usable;
  state.judge.excludedPanelIndexes = [1, 2, 3].filter((index) => !usable.includes(index));
  const manifestPath = await writeJudgeManifest(state, deps);
  state.judge.manifestPath = manifestPath;
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const judge = makeWorkerRecord({
    workerId: WORKER_ID.judge,
    role: "judge",
    executionKind: "native_subagent",
    modelSpec: { modelId: state.judgeModelId },
    workspacePath: state.sourceWorkspace,
    taskArtifactPath: state.taskArtifactPath,
    taskArtifactHash: state.taskArtifactHash,
    runDir,
    softMs: resolveTimeouts(deps.timeouts).judgeSoftSuspectMs,
    hardMs: resolveTimeouts(deps.timeouts).judgeHardTimeoutMs,
    agentId: FUSION_AGENT_NAMES.judge,
  });
  const contractPath = path.join(runDir, "merge-patch-contract.md");
  const judgePrompt = buildHybridJudgeDispatchPrompt({
    manifestPath,
    resultArtifactPath: judge.resultArtifactPath,
    sourceWorkspace: state.sourceWorkspace,
    contractPath,
  });
  await writeFile(judge.instructionArtifactPath, judgePrompt, "utf8");
  state.workers[judge.workerId] = judge;
  deps.syncWorkers?.(state.workers);
  state.judge.dispatchedAt = nowIso(now);

  const dispatchRequestedAt = state.judge.dispatchedAt;
  judge.dispatchRequestedAt = dispatchRequestedAt;
  transitionWorker(judge, "spawning", dispatchRequestedAt);
  const receipt = await nativeDispatcher.dispatchJudge({
    agentId: judge.agentId ?? FUSION_AGENT_NAMES.judge,
    configuredModelId: judge.configuredModelId ?? judge.modelId,
    prompt: judgePrompt,
    description: "Fusion Judge",
    dispatchRequestedAt,
    resultArtifactPath: judge.resultArtifactPath,
    instructionArtifactPath: judge.instructionArtifactPath,
  });
  judge.sessionId = receipt.sessionId;
  judge.dispatchedAt = receipt.dispatchedAt;
  transitionWorker(judge, "running", receipt.dispatchedAt);
  state.nativeJudge = {
    sessionId: judge.sessionId,
    agentId: judge.agentId ?? FUSION_AGENT_NAMES.judge,
    configuredModelId: judge.configuredModelId ?? judge.modelId,
    dispatchRequestedAt: judge.dispatchRequestedAt,
    dispatchedAt: judge.dispatchedAt,
    terminalAt: judge.terminalAt,
    status: judge.status,
    mergePatchContractPath: state.judge.contractPath,
  };

  const monitor: WorkerMonitor = {
    worker: judge,
    exited: false,
    exitObserved: false,
    lastStdout: 0,
    lastStderr: 0,
    native: true,
  };
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  await monitorUntilTerminal([monitor], state, deps, now, pollIntervalMs);
  state.judge.completedAt = nowIso(now);
  judge.terminalAt = judge.endedAt;
  state.nativeJudge = {
    sessionId: judge.sessionId,
    agentId: judge.agentId ?? FUSION_AGENT_NAMES.judge,
    configuredModelId: judge.configuredModelId ?? judge.modelId,
    dispatchRequestedAt: judge.dispatchRequestedAt,
    dispatchedAt: judge.dispatchedAt,
    terminalAt: judge.terminalAt ?? judge.endedAt,
    status: judge.status,
    mergePatchContractPath: judge.result?.contractPath ?? state.judge.contractPath,
  };

  const result = judge.result;
  if (judge.status !== "completed" || !result) {
    state.phase = "aborted";
    state.abortReason = "judge failed or produced no contract";
    return;
  }
  const decision = result.mergePatchDecision;
  const contractExists = Boolean(result.contractPath) && (await pathExists(result.contractPath!));
  if (!decision || !contractExists) {
    state.phase = "aborted";
    state.abortReason = decision
      ? "judge succeeded but did not write a Merge Patch Contract artifact"
      : "judge succeeded but did not return a mergePatchDecision";
    return;
  }
  state.judge.decision = decision;
  state.judge.contractPath = result.contractPath;
  state.nativeJudge.mergePatchContractPath = result.contractPath;
  // The native judge applies targeted patches itself directly to the real
  // source workspace. Record what it reported and its final verification.
  const appliedItems = (result as Record<string, unknown>).appliedPatchItems as
    | Array<{ severity: "BLOCKER" | "MUST_FIX" | "SAFE_ADDITION"; title: string; status: "applied" | "skipped" | "failed" }>
    | undefined;
  if (appliedItems) {
    state.judge.appliedPatchItems = appliedItems;
  }
  const appliedSummary = appliedItems
    ? appliedItems
        .map((item) => `${item.severity}:${item.title}:${item.status}`)
        .join("; ")
    : "no patch items reported";
  state.nativeJudge.appliedPatchSummary = appliedSummary;
  if (result.verification) {
    state.finalVerification = result.verification;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the phase opaquely so callers are not narrowed to a single literal. */
function isAbortedPhase(state: SupervisorState): boolean {
  return state.phase === "aborted";
}

/** Inspect live worker PIDs for resume/recovery. */
export function liveWorkerSummary(state: SupervisorState): Array<{ workerId: string; pid?: number; alive: boolean; status: string }> {
  return Object.values(state.workers).map((worker) => ({
    workerId: worker.workerId,
    pid: worker.pid,
    alive: isPidAlive(worker.pid),
    status: worker.status,
  }));
}
