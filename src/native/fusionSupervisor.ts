import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import { buildRuntimeIdentity } from "../runtimeManifest.js";
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
  type FusionRunTiming,
  type JudgeStageTrace,
  type NativePanelEvidenceAcceptance,
  type NativePanelRuntimeEvidence,
  type NativeWaveStage,
  type SupervisorCancellation,
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
  type WorkerProcessExit,
  type WorkerRunner,
  type WorkerSpawnSpec,
} from "./workerRunner.js";
import {
  buildHybridJudgeDispatchPrompt,
  buildHybridPanelDispatchPrompt,
  assertJudgeDispatchModelConsistency,
  formatNativePanelDispatchFailure,
  FusionNativePanelDispatchError,
  FusionRestartRequiredAfterAgentResyncError,
  NATIVE_TASK_DISPATCH_MECHANISM,
  readNativeJudgeAgentModel,
  reconcileNativeAgentsAtLaunch,
  type NativeAgentReconcileResult,
  type NativeDispatchRequest,
  type NativeSubagentDispatcher,
} from "./nativeSubagentDispatch.js";
import { candidatePanelOutputPaths } from "./candidateWorkspace.js";
import {
  panelReceiptPaths,
  readPanelReceipt,
  validatePanelReceipt,
} from "./panelReceipt.js";
import {
  detectMeaningfulPanelCandidateMutation,
  harvestPanelEvidence,
  type PanelEvidenceReport,
} from "./panelEvidenceHarvest.js";
import { buildPanelExecutionContext } from "./speculativeBuild.js";
import { confirmSupervisorReady, supervisorMainEntry } from "./supervisorStartup.js";

const PANEL_COUNT = 3;

export type BootstrapInput = {
  runId: string;
  task: string;
  command?: string;
  /** Resolved main builder + patch worker model. */
  mainModel: FusionModelSpec;
  /** Active parent OpenCode session model that requested this fresh build. */
  invokingSessionModelId?: string;
  /** Resolved panel models (1..3). */
  panelModels: FusionModelSpec[];
  /** Resolved judge model. */
  judgeModel: FusionModelSpec;
  /** Canonical /fusion-model config fingerprint at launch time. */
  modelConfigFingerprint: string;
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
  /**
   * Legacy single launch-wave deadline override (ms). When set and a more
   * specific timing override is absent, it seeds BOTH the external-main startup
   * deadline and the native-dispatch registration deadline. Kept for backward
   * compatibility; prefer the specific fields below.
   */
  startupDeadlineMs?: number;
  /** Short guard verifying the external main process obtained a real PID (ms). */
  externalMainStartupDeadlineMs?: number;
  /** Guards only main-spawn -> begin_native_wave registration (ms). */
  nativeDispatchRegistrationDeadlineMs?: number;
  /** Real long-running native panel execution timeout (ms). */
  nativePanelExecutionTimeoutMs?: number;
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

type WorkerArtifactPaths = ReturnType<typeof workerArtifactPaths> & {
  workerContextArtifactPath?: string;
  verificationArtifactPath?: string;
};

function mainWorkerControlPaths(mainWorkspacePath: string) {
  const controlDir = path.join(mainWorkspacePath, ".fusion-worker");
  return {
    controlDir,
    taskArtifactPath: path.join(controlDir, "canonical-task.md"),
    instructionArtifactPath: path.join(controlDir, "main-instructions.md"),
    workerContextArtifactPath: path.join(controlDir, "worker-context.json"),
    resultArtifactPath: path.join(controlDir, "result.json"),
    statusArtifactPath: path.join(controlDir, "status.json"),
    verificationArtifactPath: path.join(controlDir, "verification.json"),
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
    lines.push("Your candidate workspace is the only allowed workspace. Do not read or write any path outside it.");
    lines.push("All worker-control files are inside .fusion-worker in your candidate workspace.");
    lines.push("Use only your candidate workspace for source reads, writes, tests, package commands, and Git commands.");
    lines.push("Before modifying files, verify the current directory is your candidate workspace.");
    lines.push("Never read or modify the source workspace. Never read or copy from another candidate workspace.");
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
  artifactPaths?: WorkerArtifactPaths;
  softMs: number;
  hardMs: number;
  logicalPanelIndex?: number;
  agentId?: string;
}): WorkerRecord {
  const paths: WorkerArtifactPaths = input.artifactPaths ?? workerArtifactPaths(input.runDir, input.workerId);
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
    workerContextArtifactPath: paths.workerContextArtifactPath,
    verificationArtifactPath: paths.verificationArtifactPath,
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
  const mainControlPaths = mainWorkerControlPaths(mainWorkspacePath);
  const mainWorker = makeWorkerRecord({
    workerId: WORKER_ID.main,
    role: "main",
    executionKind: "external_process",
    modelSpec: input.mainModel,
    workspacePath: mainWorkspacePath,
    taskArtifactPath: mainControlPaths.taskArtifactPath,
    taskArtifactHash,
    runDir,
    artifactPaths: {
      instructionArtifactPath: mainControlPaths.instructionArtifactPath,
      resultArtifactPath: mainControlPaths.resultArtifactPath,
      statusArtifactPath: mainControlPaths.statusArtifactPath,
      stdoutPath: path.join(runDir, "logs", `${WORKER_ID.main}.stdout.log`),
      stderrPath: path.join(runDir, "logs", `${WORKER_ID.main}.stderr.log`),
      workerContextArtifactPath: mainControlPaths.workerContextArtifactPath,
      verificationArtifactPath: mainControlPaths.verificationArtifactPath,
    },
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
  for (const worker of Object.values(workers).filter((worker) => worker.role !== "main")) {
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
    invokingSessionModelId: input.invokingSessionModelId,
    judgeModelId: input.judgeModel.modelId,
    modelConfigFingerprint: input.modelConfigFingerprint,
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
  await materializeMainWorkerControlFiles({
    state,
    mainWorker,
    taskContent,
    sourceCanonicalTaskPath: taskArtifactPath,
  });
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  return state;
}

async function materializeMainWorkerControlFiles(input: {
  state: SupervisorState;
  mainWorker: WorkerRecord;
  taskContent: string;
  sourceCanonicalTaskPath: string;
}): Promise<void> {
  const { state, mainWorker, taskContent } = input;
  const controlDir = path.dirname(mainWorker.taskArtifactPath);
  await mkdir(controlDir, { recursive: true });
  await writeFile(mainWorker.taskArtifactPath, taskContent, "utf8");
  const sourceCanonical = await readFile(input.sourceCanonicalTaskPath, "utf8");
  if (sourceCanonical !== taskContent) {
    throw new Error("main local canonical task does not match source canonical task bytes");
  }
  const prompt = buildWorkerPrompt({
    role: "main",
    workerId: mainWorker.workerId,
    workspacePath: mainWorker.workspacePath,
    taskArtifactPath: mainWorker.taskArtifactPath,
    resultArtifactPath: mainWorker.resultArtifactPath,
  });
  await writeFile(mainWorker.instructionArtifactPath, prompt, "utf8");
  if (mainWorker.workerContextArtifactPath) {
    await writeFile(
      mainWorker.workerContextArtifactPath,
      `${JSON.stringify(
        {
          runId: state.runId,
          workerId: mainWorker.workerId,
          role: mainWorker.role,
          workspacePath: mainWorker.workspacePath,
          canonicalTaskPath: mainWorker.taskArtifactPath,
          instructionPath: mainWorker.instructionArtifactPath,
          resultPath: mainWorker.resultArtifactPath,
          statusPath: mainWorker.statusArtifactPath,
          verificationPath: mainWorker.verificationArtifactPath,
          requestedModelId: mainWorker.requestedModelId,
          taskHash: mainWorker.taskArtifactHash,
          allowedWorkspaceOnly: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

/** Best-effort durable write of a small JSON debug/evidence artifact into the run dir. */
async function writeRunJsonArtifact(runDir: string, fileName: string, value: unknown): Promise<void> {
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // Never let a debug-artifact write failure abort an otherwise valid run.
  }
}

async function readResultArtifact(filePath: string): Promise<WorkerResultArtifact | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as WorkerResultArtifact;
  } catch {
    return undefined;
  }
}

async function readVerificationArtifact(filePath: string | undefined): Promise<import("./supervisorTypes.js").WorkerVerification | undefined> {
  if (!filePath) return undefined;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as import("./supervisorTypes.js").WorkerVerification;
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

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mainContractError(offendingPath: string, expectedRoot: string, detail: string): Error {
  return new Error(
    `FUSION_MAIN_WORKSPACE_CONTRACT_INVALID: ${detail}; offending path=${offendingPath}; expected workspace root=${expectedRoot}`,
  );
}

async function assertMainWorkspaceContract(state: SupervisorState, worker: WorkerRecord): Promise<void> {
  const workspaceRoot = path.resolve(worker.workspacePath);
  try {
    const workspaceStat = await stat(workspaceRoot);
    if (!workspaceStat.isDirectory()) {
      throw mainContractError(workspaceRoot, workspaceRoot, "main workspace is not a directory");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("FUSION_MAIN_WORKSPACE_CONTRACT_INVALID")) throw error;
    throw mainContractError(workspaceRoot, workspaceRoot, "main workspace does not exist");
  }

  const suppliedPaths = [
    worker.taskArtifactPath,
    worker.instructionArtifactPath,
    worker.resultArtifactPath,
    worker.statusArtifactPath,
    worker.workerContextArtifactPath,
    worker.verificationArtifactPath,
  ].filter((value): value is string => Boolean(value));
  for (const suppliedPath of suppliedPaths) {
    if (!isPathInside(workspaceRoot, suppliedPath)) {
      throw mainContractError(suppliedPath, workspaceRoot, "main worker path escapes candidate workspace");
    }
  }
  for (const requiredPath of [worker.taskArtifactPath, worker.instructionArtifactPath]) {
    if (!(await pathExists(requiredPath))) {
      throw mainContractError(requiredPath, workspaceRoot, "required main worker local artifact is missing");
    }
  }
  const sourceRunArtifacts = path.join(path.resolve(state.sourceWorkspace), ".opencode", "fusion-runs");
  const checkedStrings = [
    worker.taskArtifactPath,
    worker.instructionArtifactPath,
    worker.resultArtifactPath,
    worker.statusArtifactPath,
    worker.workerContextArtifactPath,
    worker.verificationArtifactPath,
    await readFile(worker.instructionArtifactPath, "utf8").catch(() => ""),
  ].filter((value): value is string => Boolean(value));
  for (const value of checkedStrings) {
    if (value.includes(sourceRunArtifacts)) {
      throw mainContractError(value, workspaceRoot, "main worker argument or context references source run artifacts");
    }
  }
  worker.workspaceContractValidated = true;
}

function assertMainSpawnSpecContract(state: SupervisorState, worker: WorkerRecord, spec: WorkerSpawnSpec): void {
  const workspaceRoot = path.resolve(worker.workspacePath);
  const sourceRunArtifacts = path.join(path.resolve(state.sourceWorkspace), ".opencode", "fusion-runs");
  const values = [
    spec.workspacePath,
    spec.promptText,
    ...Object.values(spec.env),
  ];
  for (const value of values) {
    if (value.includes(sourceRunArtifacts)) {
      throw mainContractError(value, workspaceRoot, "main worker spawn argument references source run artifacts");
    }
  }
  for (const value of [spec.workspacePath, spec.env.FUSION_WORKSPACE, spec.env.FUSION_TASK_ARTIFACT, spec.env.FUSION_INSTRUCTION_ARTIFACT, spec.env.FUSION_RESULT_ARTIFACT, spec.env.FUSION_STATUS_ARTIFACT, spec.env.FUSION_WORKER_CONTEXT, spec.env.FUSION_VERIFICATION_ARTIFACT]) {
    if (value && path.isAbsolute(value) && !isPathInside(workspaceRoot, value)) {
      throw mainContractError(value, workspaceRoot, "main worker spawn path escapes candidate workspace");
    }
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
    ...(worker.workerContextArtifactPath ? { FUSION_WORKER_CONTEXT: worker.workerContextArtifactPath } : {}),
    ...(worker.verificationArtifactPath ? { FUSION_VERIFICATION_ARTIFACT: worker.verificationArtifactPath } : {}),
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
  try {
    if (worker.role === "main") {
      await assertMainWorkspaceContract(state, worker);
    }
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
    if (worker.role === "main") {
      assertMainSpawnSpecContract(state, worker, spec);
    }
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
    if (worker.status === "spawning" || (worker.role === "main" && worker.status === "queued")) {
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
  const receipts = panelReceiptPaths(worker.workspacePath);
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
    runId: state.runId,
    logicalPanelIndex,
    agentId: worker.agentId ?? worker.workerId,
    canonicalTaskHash: state.taskArtifactHash,
    candidateWorkspace: worker.workspacePath,
    prohibitedSourceWorkspace: state.sourceWorkspace,
    taskArtifactPath: state.taskArtifactPath,
    executionContextPath,
    resultArtifactPath: worker.resultArtifactPath,
    receiptArtifactPath: receipts.receiptPath,
    panelResultArtifactPath: receipts.resultPath,
    verificationArtifactPath: receipts.verificationPath,
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
  configFingerprint: string,
): Promise<NativeAgentReconcileResult> {
  if (deps.skipNativeAgentValidation) {
    return {
      synchronized: true,
      configFingerprint,
      installedAgentModels: {
        panelModels: panelModels.map((spec) => spec.modelId),
        judgeModel: judgeModel.modelId,
      },
    };
  }
  try {
    return await reconcileNativeAgentsAtLaunch({
      panelModels,
      judgeModel,
      configFingerprint,
      agentDir: deps.agentDir,
    });
  } catch (error) {
    if (error instanceof FusionRestartRequiredAfterAgentResyncError) {
      throw error;
    }
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
  await validateHybridNativeAgents(
    state,
    deps,
    panelModels,
    { modelId: state.judgeModelId },
    state.modelConfigFingerprint ?? "",
  );

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
    invokingSessionModelId: state.invokingSessionModelId,
    requestedModelId: mainWorker.requestedModelId,
    configuredModelId: mainWorker.configuredModelId,
    observedProviderId: mainWorker.observedProviderId,
    observedModelId: mainWorker.observedModelId,
    workspace: mainWorker.workspacePath,
    localCanonicalTaskPath: mainWorker.taskArtifactPath,
    workspaceContractValidated: mainWorker.workspaceContractValidated,
    status: mainWorker.status,
    stdoutPath: mainWorker.stdoutPath,
    stderrPath: mainWorker.stderrPath,
    launchRequestedAt: mainWorker.launchRequestedAt,
    spawnedAt: mainWorker.spawnedAt,
    endedAt: mainWorker.endedAt,
    failureReason: mainWorker.statusTransitions.at(-1)?.reason,
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
    await deriveMainTerminalEvidence(state, mainWorker, now);
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

async function deriveMainTerminalEvidence(state: SupervisorState, main: WorkerRecord, now: () => number): Promise<void> {
  if (!isTerminalWorkerStatus(main.status)) return;
  const localReport = await readResultArtifact(main.resultArtifactPath);
  if (localReport) {
    main.result = localReport;
    return;
  }
  const snapshotBaseline = await loadBaselineManifest(state.sourceSnapshotManifestPath);
  const diff = snapshotBaseline ? await diffAgainstBaseline(main.workspacePath, snapshotBaseline) : undefined;
  const changedFiles = diff
    ? [...diff.changedFiles, ...diff.addedFiles, ...diff.removedFiles].filter((rel) => !isPromotionPreservedRelPath(rel))
    : [];
  const verification = await readVerificationArtifact(main.verificationArtifactPath);
  const status = main.status === "completed" ? "completed" : "failed";
  const result: WorkerResultArtifact = {
    workerId: main.workerId,
    role: "main",
    runId: state.runId,
    workspacePath: main.workspacePath,
    taskHash: main.taskArtifactHash,
    status,
    changedFiles,
    verification,
    errorSummary: status === "failed" ? main.statusTransitions.at(-1)?.reason ?? "main worker failed without a local report" : undefined,
    completedAt: main.endedAt ?? nowIso(now),
  };
  main.result = result;
  try {
    await mkdir(path.dirname(main.resultArtifactPath), { recursive: true });
    await writeFile(main.resultArtifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch {
    // State still carries the derived evidence even if the local report cannot be materialized.
  }
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
  // A panel counts as truthfully launched when it has dispatch evidence AND at
  // least one verified runtime-evidence source (native session ID, valid receipt
  // + candidate mutation, or parent Task completion with matching task hash).
  let allPanelsHaveEvidence = true;
  for (const panel of panelWorkers) {
    const hasRuntimeEvidence = panelHasVerifiedRuntimeEvidence(panel);
    if (panel.dispatchedAt && hasRuntimeEvidence) {
      panelsLaunched += 1;
      if (panel.logicalPanelIndex) {
        panelLaunchAt[panel.logicalPanelIndex as 1 | 2 | 3] = panel.dispatchedAt;
      }
    } else {
      allPanelsHaveEvidence = false;
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
  const mainModelMatched = main.observedModelId
    ? main.observedModelId === expectedMainModel
    : !isTerminalWorkerStatus(main.status);
  const confirmed =
    mainPidOk &&
    panelsLaunched === PANEL_COUNT &&
    allPanelsHaveEvidence &&
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
    invokingSessionModelId: state.invokingSessionModelId,
    requestedModelId: main.requestedModelId,
    configuredModelId: main.configuredModelId,
    observedProviderId: main.observedProviderId,
    observedModelId: main.observedModelId,
    workspace: main.workspacePath,
    localCanonicalTaskPath: main.taskArtifactPath,
    workspaceContractValidated: main.workspaceContractValidated,
    status: main.status,
    stdoutPath: main.stdoutPath,
    stderrPath: main.stderrPath,
    launchRequestedAt: main.launchRequestedAt,
    spawnedAt: main.spawnedAt,
    endedAt: main.endedAt,
    exitCode: main.exitCode,
    promoted: state.mainPromotion.status === "promoted",
    promotionManifestPath: state.mainPromotion.manifestPath,
    failureReason: main.statusTransitions.at(-1)?.reason ?? state.mainPromotion.detail,
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
    nativeWaveStage: worker.nativeWaveStage,
    resultArtifactPath: worker.resultArtifactPath,
    runtimeEvidence: worker.runtimeEvidence,
  }));
}

function panelAgentId(worker: WorkerRecord): string {
  return worker.agentId ?? worker.workerId;
}

function panelHasVerifiedRuntimeEvidence(worker: WorkerRecord): boolean {
  const ev = worker.runtimeEvidence;
  if (ev?.receiptValidity === "invalid") return false;
  if (Boolean(worker.sessionId)) return true;
  if (isTerminalWorkerStatus(worker.status) && ev?.receiptValidity !== "missing") return true;
  if (isTerminalWorkerStatus(worker.status) && ev?.taskCompletionEvidence && ev.candidateMutationEvidence) {
    return true;
  }
  if (!ev) return false;
  if (ev.nativeSessionIdAvailable && ev.sessionId) return true;
  if (ev.receiptValidity === "valid" && ev.candidateMutationEvidence) return true;
  if (ev.taskCompletionEvidence && ev.receiptValidity === "valid") return true;
  if (
    ev.taskCompletionEvidence &&
    ev.candidateMutationEvidence &&
    ev.reconciledStatus !== "completed_invalid_receipt"
  ) {
    return true;
  }
  // Candidate workspace mutation alone (snapshot-relative, registered identity)
  // is sufficient runtime evidence for a self-healed degraded panel.
  if (isTerminalWorkerStatus(worker.status) && ev.candidateMutationEvidence) return true;
  return (
    ev.reconciledStatus === "completed_with_session" ||
    ev.reconciledStatus === "completed_with_receipt" ||
    ev.reconciledStatus === "completed_with_task" ||
    ev.reconciledStatus === "completed_degraded"
  );
}

function formatPanelEvidenceFailure(worker: WorkerRecord): string {
  const ev = worker.runtimeEvidence;
  const index = worker.logicalPanelIndex ?? "?";
  if (!ev) return `panel ${index}: no runtime evidence reconciled`;
  const parts = [
    `panel ${index} (${ev.agentId})`,
    `native session ID: ${ev.nativeSessionIdAvailable ? ev.sessionId ?? "unavailable" : "unavailable"}`,
    `Task completion evidence: ${ev.taskCompletionEvidence ? "yes" : "no"}`,
    `receipt: ${ev.receiptArtifactPath ?? "—"} (${ev.receiptValidity})`,
    `candidate mutation: ${ev.candidateMutationEvidence ? "yes" : "no"}`,
    `status: ${ev.reconciledStatus}`,
  ];
  if (ev.receiptValidationErrors?.length) {
    parts.push(`receipt errors: ${ev.receiptValidationErrors.join("; ")}`);
  }
  return parts.join("; ");
}

function resolvePanelIndexFromId(id: string | undefined): 1 | 2 | 3 | undefined {
  if (!id) return undefined;
  const match = id.match(/(?:fusion-panel-)?([123])$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value === 1 || value === 2 || value === 3 ? (value as 1 | 2 | 3) : undefined;
}

function resolveOutcomeIndex(outcome: HybridPanelOutcome): 1 | 2 | 3 | undefined {
  if (outcome.logicalPanelIndex === 1 || outcome.logicalPanelIndex === 2 || outcome.logicalPanelIndex === 3) {
    return outcome.logicalPanelIndex;
  }
  return resolvePanelIndexFromId(outcome.panelId) ?? resolvePanelIndexFromId(outcome.agentId);
}

function outcomeReceiptPath(outcome: HybridPanelOutcome | undefined): string | undefined {
  return outcome?.receiptPath ?? outcome?.receiptArtifactPath;
}

/**
 * Detect spoofed/mismatched parent-supplied panelOutcomes fields against the
 * registered panel slot. Any nonempty result means the submitted evidence is
 * untrustworthy and the panel must be rejected (never silently accepted).
 */
function detectOutcomeContractMismatch(
  state: SupervisorState,
  worker: WorkerRecord,
  outcome: HybridPanelOutcome,
): string[] {
  const errors: string[] = [];
  const expectedAgent = panelAgentId(worker);
  if (outcome.panelId && outcome.panelId !== expectedAgent) {
    errors.push(`panelId mismatch: expected ${expectedAgent}, got ${outcome.panelId}`);
  }
  if (outcome.agentId && outcome.agentId !== expectedAgent) {
    errors.push(`agentId mismatch: expected ${expectedAgent}, got ${outcome.agentId}`);
  }
  if (outcome.canonicalTaskHash && outcome.canonicalTaskHash !== state.taskArtifactHash) {
    errors.push(
      `canonicalTaskHash mismatch: expected ${state.taskArtifactHash}, got ${outcome.canonicalTaskHash}`,
    );
  }
  if (
    outcome.candidateWorkspace &&
    path.resolve(outcome.candidateWorkspace) !== path.resolve(worker.workspacePath)
  ) {
    errors.push(
      `candidateWorkspace mismatch: expected ${worker.workspacePath}, got ${outcome.candidateWorkspace}`,
    );
  }
  return errors;
}

async function reconcileNativePanelEvidence(
  state: SupervisorState,
  worker: WorkerRecord,
  dispatch: HybridPanelOutcome | undefined,
  waveDispatchedAt: string,
  now: () => number,
): Promise<NativePanelRuntimeEvidence> {
  const at = nowIso(now);
  const agentId = dispatch?.agentId ?? dispatch?.panelId ?? panelAgentId(worker);
  const panelId = panelAgentId(worker);
  // The canonical candidate workspace is always the REGISTERED one. A parent may
  // supply candidateWorkspace, but we only use it to detect spoofing — never to
  // redirect receipt/mutation reads to a path the parent chose.
  const candidateWorkspace = worker.workspacePath;

  const contractMismatchErrors = dispatch ? detectOutcomeContractMismatch(state, worker, dispatch) : [];
  const hasContractMismatch = contractMismatchErrors.length > 0;

  worker.dispatchRequestedAt = worker.dispatchRequestedAt ?? waveDispatchedAt;
  worker.dispatchedAt = worker.dispatchedAt ?? waveDispatchedAt;
  worker.dispatchMechanism = NATIVE_TASK_DISPATCH_MECHANISM;
  // Never trust a session ID that arrived alongside spoofed identity fields.
  if (dispatch?.sessionId && !hasContractMismatch) worker.sessionId = dispatch.sessionId;

  const receiptPath = outcomeReceiptPath(dispatch) ?? panelReceiptPaths(candidateWorkspace).receiptPath;
  const receiptRaw = await readPanelReceipt(receiptPath);
  const receiptValidation = validatePanelReceipt(receiptRaw, {
    runId: state.runId,
    panelId,
    candidateWorkspace,
    canonicalTaskHash: state.taskArtifactHash,
  });

  const parentTaskHashMatches =
    Boolean(dispatch?.canonicalTaskHash) && dispatch!.canonicalTaskHash === state.taskArtifactHash;
  const taskCompletionEvidence = Boolean(
    dispatch?.status === "completed" ||
      dispatch?.status === "failed" ||
      parentTaskHashMatches ||
      dispatch?.taskResultSummary,
  );

  // Meaningful, receipt-excluding snapshot-relative mutation. A receipt or panel
  // output artifact alone never counts; only real source/test/config changes do.
  const candidateMutationEvidence = await detectMeaningfulPanelCandidateMutation(state, worker);

  const supervisorResultArtifact = isTerminalWorkerStatus(worker.status)
    ? worker.result ?? (await readResultArtifact(worker.resultArtifactPath))
    : await readResultArtifact(worker.resultArtifactPath);

  const hasDispatchEvidence = Boolean(dispatch);

  const evidence: NativePanelRuntimeEvidence = {
    agentId,
    nativeSessionIdAvailable: Boolean((dispatch?.sessionId && !hasContractMismatch) || worker.sessionId),
    sessionId: hasContractMismatch ? worker.sessionId : dispatch?.sessionId ?? worker.sessionId,
    taskId: hasContractMismatch ? undefined : dispatch?.taskId,
    taskCompletionEvidence,
    taskCompletionSummary: dispatch?.taskResultSummary,
    receiptArtifactPath: receiptPath,
    receiptValidity: !receiptRaw ? "missing" : receiptValidation.valid ? "valid" : "invalid",
    receiptValidationErrors:
      receiptValidation.errors.length > 0 ? receiptValidation.errors : undefined,
    candidateMutationEvidence,
    reconciledStatus: "no_dispatch_evidence",
    parentOutcomeProvided: hasDispatchEvidence,
    contractMismatchErrors: hasContractMismatch ? contractMismatchErrors : undefined,
  };

  // A spoofed/mismatched outcome is never accepted: record the evidence so the
  // trace is honest, but do not promote the panel to a terminal "completed".
  if (hasContractMismatch) {
    evidence.reconciledStatus = "completed_invalid_receipt";
    evidence.acceptance = "rejected";
    worker.nativeWaveStage = worker.nativeWaveStage ?? "dispatch_requested";
    worker.runtimeEvidence = evidence;
    return evidence;
  }

  if (!hasDispatchEvidence && !receiptRaw && !supervisorResultArtifact) {
    // Self-healing invariant: a native panel that visibly ran in its REGISTERED
    // candidate workspace and produced a meaningful snapshot-relative source
    // mutation is preserved and classified even when the parent supplied no
    // panelOutcomes, no session ID, and no receipt. Optional native transport is
    // an upgrade, never a gate. No mutation yet → still awaiting (recoverable).
    if (candidateMutationEvidence) {
      if (!isTerminalWorkerStatus(worker.status)) {
        worker.terminalAt = at;
        worker.endedAt = at;
        transitionWorker(
          worker,
          "completed",
          at,
          "completed_degraded: registered candidate workspace mutation without native transport",
        );
      }
      evidence.reconciledStatus = "completed_degraded";
      evidence.acceptance = "accepted";
      worker.nativeWaveStage = "completed";
      worker.runtimeEvidence = evidence;
      return evidence;
    }
    evidence.acceptance = "awaiting";
    worker.runtimeEvidence = evidence;
    return evidence;
  }

  if (supervisorResultArtifact) {
    worker.result = supervisorResultArtifact;
    if (!isTerminalWorkerStatus(worker.status)) {
      worker.terminalAt = at;
      worker.endedAt = at;
      transitionWorker(
        worker,
        supervisorResultArtifact.status === "failed" ? "failed" : "completed",
        at,
        supervisorResultArtifact.errorSummary,
      );
    }
  } else if (receiptValidation.valid && receiptRaw) {
    if (!isTerminalWorkerStatus(worker.status)) {
      worker.terminalAt = receiptRaw.completedAt ?? at;
      worker.endedAt = worker.terminalAt;
      transitionWorker(
        worker,
        receiptRaw.status === "failed" ? "failed" : "completed",
        worker.terminalAt,
        receiptRaw.summary,
      );
    }
  } else if (
    (dispatch?.status === "completed" || dispatch?.status === "failed") &&
    !(receiptRaw && !receiptValidation.valid)
  ) {
    if (!isTerminalWorkerStatus(worker.status)) {
      worker.terminalAt = dispatch.completedAt ?? at;
      worker.endedAt = worker.terminalAt;
      transitionWorker(
        worker,
        dispatch.status === "failed" ? "failed" : "completed",
        worker.terminalAt,
        dispatch.taskResultSummary,
      );
    }
  }

  if (worker.status === "failed") {
    evidence.reconciledStatus = "failed";
    worker.nativeWaveStage = "failed";
  } else if (receiptRaw && !receiptValidation.valid) {
    evidence.reconciledStatus = "completed_invalid_receipt";
    worker.nativeWaveStage = "dispatch_requested";
  } else if (isTerminalWorkerStatus(worker.status)) {
    if (evidence.nativeSessionIdAvailable) {
      evidence.reconciledStatus = "completed_with_session";
    } else if (receiptValidation.valid) {
      evidence.reconciledStatus = "completed_with_receipt";
    } else if (parentTaskHashMatches && taskCompletionEvidence) {
      evidence.reconciledStatus = "completed_with_task";
    } else {
      evidence.reconciledStatus = "completed_with_task";
    }
    worker.nativeWaveStage = "completed";
  } else {
    evidence.reconciledStatus = "dispatched_pending_completion";
    worker.nativeWaveStage = evidence.nativeSessionIdAvailable
      ? "native_task_running_when_observable"
      : "dispatch_requested";
    if (!isTerminalWorkerStatus(worker.status)) {
      transitionWorker(worker, "running", waveDispatchedAt);
    }
  }

  evidence.acceptance = classifyPanelEvidenceAcceptance(worker, evidence);
  worker.runtimeEvidence = evidence;
  return evidence;
}

/**
 * Final accept/reject/await verdict for one reconciled panel:
 * - `rejected`  → submitted evidence is spoofed/mismatched or the on-disk
 *   receipt is invalid. Terminal: confirm_launch fails safely (without
 *   cancelling the run or killing main).
 * - `accepted`  → at least one trustworthy evidence source proves real work.
 * - `awaiting`  → no completion evidence yet; recoverable via a later
 *   confirm_launch with the actual Task outcome (run state is preserved).
 */
function classifyPanelEvidenceAcceptance(
  worker: WorkerRecord,
  evidence: NativePanelRuntimeEvidence,
): NativePanelEvidenceAcceptance {
  if (evidence.contractMismatchErrors?.length) return "rejected";
  if (evidence.receiptValidity === "invalid") return "rejected";
  if (panelHasVerifiedRuntimeEvidence(worker)) return "accepted";
  return "awaiting";
}

/**
 * A panel is usable for the judge when it is a fully-evidenced usable candidate
 * OR a usable_degraded one: completed with a real meaningful snapshot-relative
 * workspace mutation in a safe registered workspace matching the canonical task,
 * even when verification/receipt/session evidence is incomplete. A panel with no
 * mutation is unusable (not fatal); an invalid/missing one is excluded.
 */
function isPanelUsableForJudge(worker: WorkerRecord | undefined): boolean {
  const candidate = worker?.candidate;
  if (!worker || !candidate) return false;
  if (candidate.classification === "usable") return true;
  return (
    worker.status === "completed" &&
    candidate.classification !== "invalid" &&
    candidate.classification !== "missing" &&
    candidate.meaningfulChangedFiles > 0 &&
    candidate.workspaceSafe &&
    candidate.taskHashMatches
  );
}

function usablePanelIndexesFromEvidence(reports: PanelEvidenceReport[]): number[] {
  const indexes: number[] = [];
  for (const report of reports) {
    if (report.reconciledStatus !== "usable" && report.reconciledStatus !== "usable_degraded") continue;
    const index = resolvePanelIndexFromId(report.panelId);
    if (index) indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

function usablePanelIndexes(state: SupervisorState): number[] {
  const indexes: number[] = [];
  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    if (isPanelUsableForJudge(state.workers[WORKER_ID.panel(index)])) indexes.push(index);
  }
  return indexes;
}

/**
 * Preserve these path roots during main candidate promotion. They are never
 * overwritten, deleted, or reset by a snapshot-relative promotion.
 */
const PROMOTION_PRESERVED_REL_PREFIXES = [".git/", ".opencode/fusion-runs/", ".fusion-worker/"];

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
  const dispatchModelId = judge.configuredModelId ?? judge.modelId;
  if (!deps.skipNativeAgentValidation) {
    const agentFileJudgeModelId = (await readNativeJudgeAgentModel(deps.agentDir)) ?? "";
    assertJudgeDispatchModelConsistency({
      configuredJudgeModelId: state.judgeModelId,
      agentFileJudgeModelId,
      dispatchJudgeModelId: dispatchModelId,
    });
  }
  const receipt = await nativeDispatcher.dispatchJudge({
    agentId: judge.agentId ?? FUSION_AGENT_NAMES.judge,
    configuredModelId: dispatchModelId,
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

/** Keep a panel's truthful native-wave trace stage in sync with its status. */
function syncPanelWaveStage(worker: WorkerRecord): void {
  if (worker.status === "completed") worker.nativeWaveStage = "completed";
  else if (worker.status === "failed") worker.nativeWaveStage = "failed";
  else if (worker.status === "timed_out") worker.nativeWaveStage = "timed_out";
  else if (worker.sessionId) worker.nativeWaveStage = "native_task_running_when_observable";
  else if (!worker.nativeWaveStage) worker.nativeWaveStage = "dispatch_requested";
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

// ---------------------------------------------------------------------------
// Foreground, model-driven hybrid orchestration.
//
// The active OpenCode parent session drives this flow stage-by-stage so that
// the THREE panels and the judge are dispatched as REAL, visible native Task
// subagents by the parent model (the only host-supported way to make child
// work visible in the active flow). The ONE main builder is a real external
// `opencode run` process spawned in-process here (real PID). Nothing in this
// flow returns "launch success" until the external main PID and all three
// native panel session IDs are recorded.
// ---------------------------------------------------------------------------

/**
 * Default startup guard for the external main launch wave (ms). This only
 * verifies the external main process obtained a real PID — it never bounds the
 * native panel execution time.
 */
export const FUSION_EXTERNAL_MAIN_STARTUP_DEADLINE_MS = 15_000;
/**
 * Default deadline for the parent to call `begin_native_wave` after the main
 * process spawns. Applies ONLY to registering the dispatch, never to waiting for
 * the panels to finish.
 */
export const FUSION_NATIVE_DISPATCH_REGISTRATION_DEADLINE_MS = 60_000;
/** Default real long-running native panel execution timeout (ms). */
export const FUSION_NATIVE_PANEL_EXECUTION_TIMEOUT_MS = 25 * 60_000;

/** @deprecated retained as a back-compat alias; use the split timing model. */
export const FUSION_HYBRID_STARTUP_DEADLINE_MS = FUSION_EXTERNAL_MAIN_STARTUP_DEADLINE_MS;

type SupervisorCancellationOutcome = SupervisorCancellation["mainProcessOutcome"];

/** Holds the live external-main child handle across separate parent tool calls. */
type MainProcessEntry = { handle: SpawnedWorkerHandle; exited: boolean; exit?: WorkerProcessExit };
const mainProcessRegistry = new Map<string, MainProcessEntry>();

function positiveMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function legacyDeadlineOverride(deps: SupervisorDeps): number | undefined {
  const explicit = positiveMs(deps.startupDeadlineMs);
  if (explicit) return explicit;
  const fromEnv = process.env.FUSION_HYBRID_STARTUP_DEADLINE_MS;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/**
 * Resolve the persisted-or-default run timing. A legacy `startupDeadlineMs`
 * override seeds BOTH the external-main startup deadline and the native dispatch
 * registration deadline so older callers keep working, while a specific override
 * always wins.
 */
function resolveRunTiming(deps: SupervisorDeps): FusionRunTiming {
  const legacy = legacyDeadlineOverride(deps);
  return {
    externalMainStartupDeadlineMs:
      positiveMs(deps.externalMainStartupDeadlineMs) ?? legacy ?? FUSION_EXTERNAL_MAIN_STARTUP_DEADLINE_MS,
    nativeDispatchRegistrationDeadlineMs:
      positiveMs(deps.nativeDispatchRegistrationDeadlineMs) ?? legacy ?? FUSION_NATIVE_DISPATCH_REGISTRATION_DEADLINE_MS,
    nativePanelExecutionTimeoutMs:
      positiveMs(deps.nativePanelExecutionTimeoutMs) ??
      positiveMs(deps.timeouts?.panelHardTimeoutMs) ??
      FUSION_NATIVE_PANEL_EXECUTION_TIMEOUT_MS,
  };
}

/**
 * Read the run timing that governs a later stage. Persisted run config is the
 * source of truth: confirm_launch/collect/begin_native_wave must NEVER silently
 * fall back to a hardcoded 15s value when state already recorded the timing. Any
 * stage-level deps override is only consulted when state has no persisted timing
 * (e.g. an older run created before this field existed).
 */
function readRunTiming(state: SupervisorState, deps: SupervisorDeps): FusionRunTiming {
  if (state.runTiming) return state.runTiming;
  return resolveRunTiming(deps);
}

/** Panel result the parent model may report from a native Task subagent. */
export type NativePanelResultInput = {
  agentName: string;
  modelId?: string;
  content?: string;
  error?: string;
  sessionId?: string;
  taskId?: string;
};

export type HybridPanelDispatchSpec = {
  logicalPanelIndex: 1 | 2 | 3;
  agentId: string;
  configuredModelId: string;
  description: string;
  candidateWorkspace: string;
  resultArtifactPath: string;
  instructionArtifactPath: string;
  receiptArtifactPath: string;
  panelResultArtifactPath: string;
  verificationArtifactPath: string;
  prompt: string;
};

export type HybridLaunchPlan = {
  runId: string;
  strategy: "hybrid_external_main_native_panels";
  runDir: string;
  phase: SupervisorState["phase"];
  /** Back-compat: equals timing.externalMainStartupDeadlineMs. */
  startupDeadlineMs: number;
  timing: FusionRunTiming;
  launchedAt: string;
  nextStage: "begin_native_wave";
  main: {
    workerId: string;
    executionKind: "external_process";
    pid: number;
    requestedModelId: string;
    workspace: string;
    localCanonicalTaskPath: string;
    workspaceContractValidated?: boolean;
    spawnedAt?: string;
    stdoutPath: string;
    stderrPath: string;
  };
  panelDispatchSpecs: HybridPanelDispatchSpec[];
  judge: { status: "pending"; gate: "blocked_until_main_promoted_and_panels_terminal" };
  instructions: string;
};

/** A short-lived deadline guard for the launch wave. */
async function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: ${label} exceeded startup deadline of ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stage 1 (foreground): bootstrap, spawn the external main builder process to a
 * real PID, and materialize + prompt the three panel candidate workspaces. The
 * panels themselves are NOT launched here — they are returned as dispatch specs
 * for the parent model to launch as native visible Task subagents in one wave.
 * Fails loudly if the launch wave cannot obtain a real main PID and ready panel
 * specs within the startup deadline.
 */
export async function hybridLaunch(input: BootstrapInput, deps: SupervisorDeps): Promise<HybridLaunchPlan> {
  const now = deps.now ?? Date.now;
  const timing = resolveRunTiming(deps);
  const deadline = timing.externalMainStartupDeadlineMs;
  const runner = deps.runner ?? createOpenCodeProcessWorkerRunner();

  const agentReconcile = await validateHybridNativeAgents(
    {} as SupervisorState,
    deps,
    input.panelModels.slice(0, PANEL_COUNT),
    input.judgeModel,
    input.modelConfigFingerprint,
  );

  const state = await bootstrapRealParallelBuild(input, deps);

  const mainWorker = state.workers[WORKER_ID.main];
  const panelWorkers: WorkerRecord[] = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)]);

  // Persist run timing as the single source of truth for every later stage and
  // bind the real long-running execution timeout to the panel workers. This is
  // what makes a supplied launch override survive into confirm_launch/collect.
  state.runTiming = timing;
  for (const panel of panelWorkers) {
    panel.hardTimeoutMs = timing.nativePanelExecutionTimeoutMs;
  }
  state.nativeWave = {
    registrationDeadlineMs: timing.nativeDispatchRegistrationDeadlineMs,
    expectedPanelAgentIds: panelWorkers.map((w) => w.agentId ?? w.workerId),
  };

  state.phase = "launching";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  // Record the active runtime identity for this run so a stale install or schema
  // drift is diagnosable from the run directory itself.
  await writeRunJsonArtifact(
    supervisorRunDir(deps.cwd, state.runId, deps.traceDir),
    "runtime-identity.json",
    buildRuntimeIdentity(now, {
      invokingSessionModelId: state.invokingSessionModelId,
      requestedMainModelId: state.workers[WORKER_ID.main].requestedModelId ?? state.mainModelId,
      panelConfigModels: input.panelModels.slice(0, PANEL_COUNT).map((spec) => spec.modelId),
      judgeConfigModel: input.judgeModel.modelId,
      canonicalConfigFingerprint: input.modelConfigFingerprint,
      installedAgentFingerprint: agentReconcile.installedAgentFingerprint,
      installedAgentModels: agentReconcile.installedAgentModels,
    }),
  );

  const launchWave = (async () => {
    // Spawn the external main process and materialize panel workspaces in the
    // same wave; neither waits for the other. Use allSettled so a failure in
    // one branch never leaves the other branch writing files in the background
    // (which would orphan workspace state during cleanup).
    const mainSpawn = (async () => {
      const handle = await spawnWorker(state, mainWorker, runner, now);
      mainProcessRegistry.set(state.runId, { handle, exited: false });
      const entry = mainProcessRegistry.get(state.runId)!;
      void handle.exited.then((exit) => {
        entry.exited = true;
        entry.exit = exit;
        mainWorker.exitCode = exit.code;
        mainWorker.exitSignal = exit.signal;
      });
      return handle;
    })();

    const panelPrep = Promise.all(
      panelWorkers.map(async (worker) => {
        transitionWorker(worker, "preparing", nowIso(now));
        const prepared = await preparePanelWorkspace(state, worker.logicalPanelIndex as 1 | 2 | 3, deps, now);
        transitionWorker(prepared, "launching", nowIso(now));
        return prepared;
      }),
    );

    const [mainOutcome, panelOutcome] = await Promise.allSettled([mainSpawn, panelPrep]);
    if (mainOutcome.status === "rejected") throw mainOutcome.reason;
    if (panelOutcome.status === "rejected") throw panelOutcome.reason;
  })();

  try {
    await withDeadline("parallel launch wave", deadline, launchWave);
  } catch (error) {
    // Clean up a partially launched wave so nothing is left orphaned/queued.
    await hybridCancelInternal(state, deps, now, "launch wave failed");
    const message = error instanceof Error ? error.message : String(error);
    throw message.includes("FUSION_SUPERVISOR_LAUNCH_FAILED") || message.includes("FUSION_MAIN_WORKSPACE_CONTRACT_INVALID")
      ? error
      : new Error(`FUSION_SUPERVISOR_LAUNCH_FAILED: ${message}`);
  }

  if (mainWorker.pid === undefined) {
    await hybridCancelInternal(state, deps, now, "main process produced no PID");
    throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: external main builder produced no PID");
  }

  state.externalMain = {
    pid: mainWorker.pid,
    invokingSessionModelId: state.invokingSessionModelId,
    requestedModelId: mainWorker.requestedModelId,
    configuredModelId: mainWorker.configuredModelId,
    workspace: mainWorker.workspacePath,
    localCanonicalTaskPath: mainWorker.taskArtifactPath,
    workspaceContractValidated: mainWorker.workspaceContractValidated,
    status: mainWorker.status,
    stdoutPath: mainWorker.stdoutPath,
    stderrPath: mainWorker.stderrPath,
    launchRequestedAt: mainWorker.launchRequestedAt,
    spawnedAt: mainWorker.spawnedAt,
  };
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const panelDispatchSpecs: HybridPanelDispatchSpec[] = await Promise.all(
    panelWorkers.map(async (worker) => {
      const receipts = panelReceiptPaths(worker.workspacePath);
      return {
        logicalPanelIndex: worker.logicalPanelIndex as 1 | 2 | 3,
        agentId: worker.agentId ?? worker.workerId,
        configuredModelId: worker.configuredModelId ?? worker.modelId,
        description: `Fusion Panel ${worker.logicalPanelIndex}`,
        candidateWorkspace: worker.workspacePath,
        resultArtifactPath: worker.resultArtifactPath,
        instructionArtifactPath: worker.instructionArtifactPath,
        receiptArtifactPath: receipts.receiptPath,
        panelResultArtifactPath: receipts.resultPath,
        verificationArtifactPath: receipts.verificationPath,
        prompt: await readFile(worker.instructionArtifactPath, "utf8"),
      };
    }),
  );

  return {
    runId: state.runId,
    strategy: "hybrid_external_main_native_panels",
    runDir: supervisorRunDir(deps.cwd, state.runId, deps.traceDir),
    phase: state.phase,
    startupDeadlineMs: deadline,
    timing,
    launchedAt: nowIso(now),
    nextStage: "begin_native_wave",
    main: {
      workerId: mainWorker.workerId,
      executionKind: "external_process",
      pid: mainWorker.pid,
      requestedModelId: mainWorker.requestedModelId ?? mainWorker.modelId,
      workspace: mainWorker.workspacePath,
      localCanonicalTaskPath: mainWorker.taskArtifactPath,
      workspaceContractValidated: mainWorker.workspaceContractValidated,
      spawnedAt: mainWorker.spawnedAt,
      stdoutPath: mainWorker.stdoutPath,
      stderrPath: mainWorker.stderrPath,
    },
    panelDispatchSpecs,
    judge: { status: "pending", gate: "blocked_until_main_promoted_and_panels_terminal" },
    instructions:
      "1) Call begin_native_wave (immediately, before dispatching any Task) to register the dispatch wave. " +
      "2) Dispatch fusion-panel-1/2/3 as native Task subagents in ONE parallel wave using panelDispatchSpecs. " +
      "Native Task calls block the parent until they return, which is expected and may take minutes. " +
      "3) After the Task calls return, call confirm_launch with a complete evidence batch: each panel's agentId, " +
      "native sessionId/taskId when the host exposes them, completed status, task result summary when available, " +
      "candidate workspace, and receiptArtifactPath (or rely on the default .fusion-panel-output/receipt.json path). " +
      "confirm_launch reconciles already-completed panels and will NOT cancel because the panels ran longer than the startup deadline. " +
      "Do NOT report success to the user until confirm_launch returns HYBRID_PARALLEL_LAUNCH_CONFIRMED.",
  };
}

/**
 * One native panel Task outcome submitted by the active parent to confirm_launch
 * AFTER the parallel Task wave returns. This is the production reconciliation
 * contract: it accepts the real Task metadata the host returns and never demands
 * unavailable host fields. `panelId`/`agentId` identify the slot; `sessionId`,
 * `taskId`, and `receiptPath` are all OPTIONAL — a completed Task result plus a
 * mutated candidate workspace is sufficient evidence without any receipt.
 */
export type HybridPanelOutcome = {
  /** Canonical panel identity, e.g. "fusion-panel-1". */
  panelId?: string;
  /** Agent identity (usually identical to panelId). */
  agentId?: string;
  /** 1-based slot; inferred from panelId/agentId when omitted. */
  logicalPanelIndex?: 1 | 2 | 3;
  /** Parent-reported Task completion status when the Task call returned. */
  status?: "completed" | "failed" | "running";
  /** Real native session ID when the host exposes one; omit if unavailable. */
  sessionId?: string;
  /** Real native Task id when the host exposes one; omit if unavailable. */
  taskId?: string;
  /** Parent-reported Task output/error summary when available. */
  taskResultSummary?: string;
  candidateWorkspace?: string;
  /** Parent-reported canonical task hash from the Task completion result. */
  canonicalTaskHash?: string;
  /** Explicit receipt path; defaults to <candidate>/.fusion-panel-output/receipt.json. */
  receiptPath?: string;
  /** @deprecated alias for receiptPath (legacy callers). */
  receiptArtifactPath?: string;
  completedAt?: string;
};

/** @deprecated legacy name retained for backward compatibility. */
export type HybridPanelDispatchReceipt = HybridPanelOutcome;

/**
 * The exact panelOutcomes schema confirm_launch expects, surfaced verbatim when
 * the parent submits an incomplete/missing batch so it can recover without
 * wasting completed panel work.
 */
export const EXPECTED_PANEL_OUTCOMES_SCHEMA = {
  field: "panelOutcomes",
  cardinality: "array of up to 3 entries (one per native panel)",
  entry: {
    panelId: "required (e.g. fusion-panel-1)",
    agentId: "required (usually identical to panelId)",
    status: "required: completed | failed",
    sessionId: "optional (include only when the host exposes it)",
    taskId: "optional (include only when the host exposes it)",
    taskResultSummary: "recommended: the actual returned Task result summary",
    candidateWorkspace: "required: absolute candidate workspace path",
    canonicalTaskHash: "recommended: the run canonical task hash",
    receiptPath: "optional: <candidate>/.fusion-panel-output/receipt.json",
  },
} as const;

export const AWAITING_NATIVE_PANEL_OUTCOMES = "AWAITING_NATIVE_PANEL_OUTCOMES" as const;

/**
 * Lifecycle-only confirm_launch status. Panel evidence is owned by collect.
 */
export type HybridConfirmStatus = "LAUNCH_CONFIRMED" | "MAIN_PROCESS_UNAVAILABLE";

export type HybridBeginWaveResult = {
  runId: string;
  registered: true;
  phase: SupervisorState["phase"];
  dispatchRequestedAt: string;
  expectedPanelAgentIds: string[];
  registrationElapsedMs: number;
  registrationDeadlineMs: number;
  panels: Array<{ logicalPanelIndex: number; agentId: string; nativeWaveStage: NativeWaveStage }>;
};

/**
 * Stage 2 (foreground): register the native panel dispatch wave. The parent
 * calls this IMMEDIATELY before dispatching the three Task subagents. It records
 * the dispatch-requested time and the expected panel agent IDs, marks the panels
 * `dispatch_requested`, and enforces the native-dispatch REGISTRATION deadline —
 * measured only from the main spawn to this call, never spanning panel execution.
 * It never claims a fake session ID or a fake running state.
 */
export async function hybridBeginNativeWave(
  args: { runId: string; expectedPanelAgentIds?: string[]; dispatchRequestedAt?: string },
  deps: SupervisorDeps,
): Promise<HybridBeginWaveResult> {
  assertValidFusionRunId(args.runId);
  const now = deps.now ?? Date.now;
  const state = await loadSupervisorState(deps.cwd, args.runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${args.runId}.`);

  const mainWorker = state.workers[WORKER_ID.main];
  const panelWorkers: WorkerRecord[] = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)]);

  if (mainWorker.pid === undefined) {
    throw new Error("FUSION_SUPERVISOR_LAUNCH_FAILED: external main builder has no PID at begin_native_wave");
  }

  const timing = readRunTiming(state, deps);
  const mainSpawnedMs = mainWorker.spawnedAt
    ? new Date(mainWorker.spawnedAt).getTime()
    : mainWorker.launchRequestedAt
      ? new Date(mainWorker.launchRequestedAt).getTime()
      : now();
  const elapsed = now() - mainSpawnedMs;
  if (elapsed > timing.nativeDispatchRegistrationDeadlineMs) {
    await hybridCancelInternal(
      state,
      deps,
      now,
      `native dispatch registration deadline exceeded (${elapsed}ms > ${timing.nativeDispatchRegistrationDeadlineMs}ms)`,
    );
    throw new Error(
      `FUSION_SUPERVISOR_LAUNCH_FAILED: native dispatch registration deadline fired after ${elapsed}ms ` +
        `(deadline ${timing.nativeDispatchRegistrationDeadlineMs}ms); the parent did not begin the panel wave in time`,
    );
  }

  const dispatchRequestedAt = args.dispatchRequestedAt ?? nowIso(now);
  const expectedPanelAgentIds =
    args.expectedPanelAgentIds && args.expectedPanelAgentIds.length > 0
      ? args.expectedPanelAgentIds
      : panelWorkers.map((w) => w.agentId ?? w.workerId);
  state.nativeWave = {
    registrationDeadlineMs: timing.nativeDispatchRegistrationDeadlineMs,
    dispatchRequestedAt,
    registeredAt: nowIso(now),
    registrationElapsedMs: elapsed,
    registeredVia: "begin_native_wave",
    expectedPanelAgentIds,
  };

  for (const worker of panelWorkers) {
    if (isTerminalWorkerStatus(worker.status)) continue;
    worker.dispatchRequestedAt = dispatchRequestedAt;
    worker.dispatchMechanism = NATIVE_TASK_DISPATCH_MECHANISM;
    worker.nativeWaveStage = "dispatch_requested";
    // Intentionally do NOT transition to "running" and do NOT set a sessionId:
    // there is no host-observable running evidence yet.
  }
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  return {
    runId: state.runId,
    registered: true,
    phase: state.phase,
    dispatchRequestedAt,
    expectedPanelAgentIds,
    registrationElapsedMs: elapsed,
    registrationDeadlineMs: timing.nativeDispatchRegistrationDeadlineMs,
    panels: panelWorkers.map((w) => ({
      logicalPanelIndex: w.logicalPanelIndex as number,
      agentId: w.agentId ?? w.workerId,
      nativeWaveStage: w.nativeWaveStage ?? "dispatch_requested",
    })),
  };
}

export type HybridConfirmResult = {
  runId: string;
  confirmed: boolean;
  /** Lifecycle acknowledgement only — panel evidence is owned by collect. */
  status: HybridConfirmStatus;
  nextStage: "collect";
  main: { pid?: number; status: WorkerRecord["status"]; spawnedAt?: string };
  panels: Array<{
    logicalPanelIndex: number;
    sessionId?: string;
    status: WorkerRecord["status"];
    nativeWaveStage?: NativeWaveStage;
    dispatchedAt?: string;
  }>;
  /** Optional enrichment count when the parent supplied panelOutcomes. */
  panelOutcomesReceived: number;
  waveDispatchedAt?: string;
  waveReturnedAt: string;
  blockingReason?: string;
  phase: SupervisorState["phase"];
};

/**
 * Stage 3 (lifecycle acknowledgement): called AFTER the blocking native Task
 * calls return. Records that the external main PID exists (or has a known
 * terminal state), that the native wave was dispatched, and that the parent
 * returned from the blocking Task wave. Optionally merges panelOutcomes when
 * supplied. Never gates panel evidence — collect owns inspection.
 */
export async function hybridConfirmLaunch(
  args: {
    runId: string;
    panelOutcomes?: HybridPanelOutcome[];
    /** @deprecated legacy alias for panelOutcomes. */
    panelDispatches?: HybridPanelOutcome[];
    waveDispatchedAt?: string;
  },
  deps: SupervisorDeps,
): Promise<HybridConfirmResult> {
  assertValidFusionRunId(args.runId);
  const now = deps.now ?? Date.now;
  const state = await loadSupervisorState(deps.cwd, args.runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${args.runId}.`);

  const mainWorker = state.workers[WORKER_ID.main];
  const panelWorkers: WorkerRecord[] = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)]);
  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const waveDispatchedAt =
    state.nativeWave?.dispatchRequestedAt ?? args.waveDispatchedAt ?? nowIso(now);
  const waveReturnedAt = nowIso(now);
  const outcomes = args.panelOutcomes ?? args.panelDispatches ?? [];

  await writeRunJsonArtifact(runDir, "confirm-launch-input.json", {
    runId: args.runId,
    waveDispatchedAt,
    panelOutcomes: args.panelOutcomes,
    panelDispatches: args.panelDispatches,
    receivedAt: waveReturnedAt,
    schemaPanelOutcomesSupported: true,
  });

  const mainUnavailable =
    mainWorker.pid === undefined ||
    (mainWorker.status === "running" && mainWorker.pid !== undefined && !isPidAlive(mainWorker.pid));
  if (mainUnavailable) {
    const result: HybridConfirmResult = {
      runId: state.runId,
      confirmed: false,
      status: "MAIN_PROCESS_UNAVAILABLE",
      nextStage: "collect",
      panelOutcomesReceived: outcomes.length,
      waveDispatchedAt,
      waveReturnedAt,
      main: { pid: mainWorker.pid, status: mainWorker.status, spawnedAt: mainWorker.spawnedAt },
      panels: panelWorkers.map((w) => ({
        logicalPanelIndex: w.logicalPanelIndex as number,
        sessionId: w.sessionId,
        status: w.status,
        nativeWaveStage: w.nativeWaveStage,
        dispatchedAt: w.dispatchedAt,
      })),
      blockingReason:
        mainWorker.pid === undefined
          ? "external main builder has no PID at confirm_launch"
          : "external main builder PID is no longer alive",
      phase: state.phase,
    };
    await writeRunJsonArtifact(runDir, "confirm-launch-result.json", result);
    return result;
  }

  if (!state.nativeWave?.dispatchRequestedAt) {
    state.nativeWave = {
      registrationDeadlineMs:
        state.nativeWave?.registrationDeadlineMs ?? readRunTiming(state, deps).nativeDispatchRegistrationDeadlineMs,
      dispatchRequestedAt: waveDispatchedAt,
      registeredAt: waveReturnedAt,
      registeredVia: "confirm_launch_implicit",
      expectedPanelAgentIds:
        state.nativeWave?.expectedPanelAgentIds ?? panelWorkers.map((w) => w.agentId ?? w.workerId),
    };
  }

  state.nativeWave = {
    ...state.nativeWave!,
    parentWaveReturned: true,
    waveReturnedAt,
    confirmPanelOutcomesReceived: outcomes.length,
    lastConfirmAt: waveReturnedAt,
  };

  const byIndex = new Map<number, HybridPanelOutcome>();
  for (const outcome of outcomes) {
    const index = resolveOutcomeIndex(outcome);
    if (index !== undefined) byIndex.set(index, outcome);
  }
  for (const worker of panelWorkers) {
    worker.dispatchRequestedAt = worker.dispatchRequestedAt ?? waveDispatchedAt;
    worker.dispatchedAt = worker.dispatchedAt ?? waveDispatchedAt;
    worker.dispatchMechanism = NATIVE_TASK_DISPATCH_MECHANISM;
    worker.nativeWaveStage = worker.nativeWaveStage ?? "completed";
    const dispatch = byIndex.get(worker.logicalPanelIndex as 1 | 2 | 3);
    if (dispatch) {
      await reconcileNativePanelEvidence(state, worker, dispatch, waveDispatchedAt, now);
    }
  }

  computeLaunchVerdict(state, panelWorkers);
  state.phase = "workers_running";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const result: HybridConfirmResult = {
    runId: state.runId,
    confirmed: true,
    status: "LAUNCH_CONFIRMED",
    nextStage: "collect",
    panelOutcomesReceived: outcomes.length,
    waveDispatchedAt,
    waveReturnedAt,
    main: { pid: mainWorker.pid, status: mainWorker.status, spawnedAt: mainWorker.spawnedAt },
    panels: panelWorkers.map((w) => ({
      logicalPanelIndex: w.logicalPanelIndex as number,
      sessionId: w.sessionId,
      status: w.status,
      nativeWaveStage: w.nativeWaveStage,
      dispatchedAt: w.dispatchedAt,
    })),
    phase: state.phase,
  };
  await writeRunJsonArtifact(runDir, "confirm-launch-result.json", result);
  return result;
}

/** Detect and record an external-main terminal state from real process + artifact evidence. */
async function reconcileMainTerminal(state: SupervisorState, deps: SupervisorDeps, now: () => number): Promise<void> {
  const main = state.workers[WORKER_ID.main];
  if (isTerminalWorkerStatus(main.status)) return;
  const entry = mainProcessRegistry.get(state.runId);
  const processGone = entry ? entry.exited : main.pid !== undefined && !isPidAlive(main.pid);
  if (!processGone) {
    // Hard timeout safety even while the parent is polling.
    const spawnedMs = main.spawnedAt ? new Date(main.spawnedAt).getTime() : now();
    if (now() - spawnedMs >= main.hardTimeoutMs) {
      main.timedOutReason = `hard timeout after ${main.hardTimeoutMs}ms with no terminal exit`;
      main.endedAt = nowIso(now);
      transitionWorker(main, "timed_out", main.endedAt, main.timedOutReason);
      mainProcessRegistry.get(state.runId)?.handle.kill("SIGTERM");
    }
    return;
  }
  const at = nowIso(now);
  main.endedAt = at;
  main.terminalAt = at;
  const result = await readResultArtifact(main.resultArtifactPath);
  if (result) main.result = result;
  await enforceMainModelMatch(main);
  if (main.status === "failed" || main.status === "timed_out") return;
  const failed = (main.exitCode ?? (entry?.exit?.code ?? 1)) !== 0 || result?.status === "failed";
  transitionWorker(main, failed ? "failed" : "completed", at, result?.errorSummary);
}

export type HybridCollectResult = {
  runId: string;
  phase: SupervisorState["phase"];
  main: { status: WorkerRecord["status"]; promoted: boolean; promotionStatus?: string; promotionDetail?: string };
  panels: Array<{
    logicalPanelIndex: number;
    status: WorkerRecord["status"];
    classification?: string;
    evidenceStatus?: PanelEvidenceReport["reconciledStatus"];
  }>;
  allPanelsTerminal: boolean;
  allPanelsClassified: boolean;
  awaitingPanelIndexes: number[];
  panelEvidenceReportDir: string;
  judge:
    | { eligible: false; reason: string }
    | {
        eligible: true;
        manifestPath: string;
        usablePanelIndexes: number[];
        dispatch: {
          agentId: string;
          configuredModelId: string;
          description: string;
          resultArtifactPath: string;
          instructionArtifactPath: string;
          contractPath: string;
          prompt: string;
        };
      };
};

/**
 * Stage 4 (foreground): ingest panel results, inspect registered candidate
 * workspaces, reconcile the external main terminal + promotion, classify panels,
 * and — when the promoted main baseline, the returned native wave, and all panel
 * evidence reports are terminal — return the native judge dispatch spec.
 */
export async function hybridCollect(
  args: { runId: string; panelResults?: NativePanelResultInput[] },
  deps: SupervisorDeps,
): Promise<HybridCollectResult> {
  assertValidFusionRunId(args.runId);
  const now = deps.now ?? Date.now;
  const state = await loadSupervisorState(deps.cwd, args.runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${args.runId}.`);

  const panelWorkers: WorkerRecord[] = [1, 2, 3].map((i) => state.workers[WORKER_ID.panel(i)]);
  const resultsByIndex = new Map<number, NativePanelResultInput>();
  for (const entry of args.panelResults ?? []) {
    const match = panelWorkers.find(
      (w) => w.agentId === entry.agentName || w.workerId === entry.agentName,
    );
    if (match?.logicalPanelIndex) resultsByIndex.set(match.logicalPanelIndex, entry);
  }

  for (const worker of panelWorkers) {
    if (isTerminalWorkerStatus(worker.status)) {
      if (!worker.result) worker.result = await readResultArtifact(worker.resultArtifactPath);
      continue;
    }
    const at = nowIso(now);
    const artifact = await readResultArtifact(worker.resultArtifactPath);
    const reported = resultsByIndex.get(worker.logicalPanelIndex as number);
    if (artifact) {
      worker.result = artifact;
      worker.terminalAt = at;
      worker.endedAt = at;
      transitionWorker(worker, artifact.status === "failed" ? "failed" : "completed", at, artifact.errorSummary);
    } else if (reported) {
      worker.terminalAt = at;
      worker.endedAt = at;
      if (reported.error) {
        transitionWorker(worker, "failed", at, reported.error);
      } else {
        transitionWorker(worker, "completed", at);
      }
    } else {
      // Still running; apply the panel hard timeout from the dispatch time.
      const startedMs = worker.dispatchedAt ? new Date(worker.dispatchedAt).getTime() : now();
      if (now() - startedMs >= worker.hardTimeoutMs) {
        worker.timedOutReason = `hard timeout after ${worker.hardTimeoutMs}ms with no terminal native result`;
        worker.endedAt = at;
        worker.terminalAt = at;
        transitionWorker(worker, "timed_out", at, worker.timedOutReason);
      }
    }
  }
  for (const worker of panelWorkers) syncPanelWaveStage(worker);

  await reconcileMainTerminal(state, deps, now);
  if (isTerminalWorkerStatus(state.workers[WORKER_ID.main].status)) {
    await deriveMainTerminalEvidence(state, state.workers[WORKER_ID.main], now);
    await promoteMainCandidate(state, deps, now);
  }

  const allPanelsTerminal = panelWorkers.every((w) => isTerminalWorkerStatus(w.status));
  if (allPanelsTerminal) {
    await classifyPanels(state);
  }

  const waveDispatchedAt = state.nativeWave?.dispatchRequestedAt ?? nowIso(now);
  for (const worker of panelWorkers) {
    await reconcileNativePanelEvidence(state, worker, undefined, waveDispatchedAt, now);
  }

  computeLaunchVerdict(state, panelWorkers);

  const harvest = await harvestPanelEvidence(state, deps.cwd, deps.traceDir, now);
  const evidenceByIndex = new Map<number, PanelEvidenceReport>();
  for (const report of harvest.reports) {
    const index = resolvePanelIndexFromId(report.panelId);
    if (index) evidenceByIndex.set(index, report);
  }
  const awaitingPanelIndexes = harvest.reports
    .map((report, idx) => ({ index: (idx + 1) as 1 | 2 | 3, status: report.reconciledStatus }))
    .filter((entry) => entry.status === "awaiting")
    .map((entry) => entry.index);
  const allPanelsClassified = harvest.reports.every((report) => report.reconciledStatus !== "awaiting");

  const main = state.workers[WORKER_ID.main];
  const mainTerminal = isTerminalWorkerStatus(main.status);
  const mainPromoted = state.mainPromotion.status === "promoted";
  const waveReturned = Boolean(state.nativeWave?.parentWaveReturned);

  let judge: HybridCollectResult["judge"] = { eligible: false, reason: "" };
  if (!waveReturned) {
    judge = { eligible: false, reason: "native Task wave has not returned (confirm_launch not recorded)" };
  } else if (!mainTerminal) {
    judge = { eligible: false, reason: `main builder still ${main.status}` };
  } else if (!mainPromoted) {
    judge = {
      eligible: false,
      reason: `main candidate not promoted (status=${state.mainPromotion.status ?? "pending"}: ${state.mainPromotion.detail ?? "n/a"})`,
    };
  } else if (!allPanelsClassified) {
    judge = { eligible: false, reason: `awaiting panel evidence for panel(s) ${awaitingPanelIndexes.join(", ")}` };
  } else {
    const usable = usablePanelIndexesFromEvidence(harvest.reports);
    state.phase = "judge";
    state.judge.eligibleAt = nowIso(now);
    state.judge.usablePanelIndexes = usable;
    state.judge.excludedPanelIndexes = [1, 2, 3].filter((index) => !usable.includes(index));
    const manifestPath = await writeJudgeManifest(state, deps);
      state.judge.manifestPath = manifestPath;
      const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
      const contractPath = path.join(runDir, "merge-patch-contract.md");
      const existingJudge = state.workers[WORKER_ID.judge];
      const judgeWorker =
        existingJudge ??
        makeWorkerRecord({
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
      const judgePrompt = buildHybridJudgeDispatchPrompt({
        manifestPath,
        resultArtifactPath: judgeWorker.resultArtifactPath,
        sourceWorkspace: state.sourceWorkspace,
        contractPath,
      });
      await writeFile(judgeWorker.instructionArtifactPath, judgePrompt, "utf8");
      state.workers[judgeWorker.workerId] = judgeWorker;
      state.judge.contractPath = contractPath;
      const dispatchModelId = judgeWorker.configuredModelId ?? judgeWorker.modelId;
      if (!deps.skipNativeAgentValidation) {
        const agentFileJudgeModelId = (await readNativeJudgeAgentModel(deps.agentDir)) ?? "";
        assertJudgeDispatchModelConsistency({
          configuredJudgeModelId: state.judgeModelId,
          agentFileJudgeModelId,
          dispatchJudgeModelId: dispatchModelId,
        });
      }
      judge = {
        eligible: true,
        manifestPath,
        usablePanelIndexes: usable,
        dispatch: {
          agentId: judgeWorker.agentId ?? FUSION_AGENT_NAMES.judge,
          configuredModelId: dispatchModelId,
          description: "Fusion Judge",
          resultArtifactPath: judgeWorker.resultArtifactPath,
          instructionArtifactPath: judgeWorker.instructionArtifactPath,
          contractPath,
          prompt: judgePrompt,
        },
      };
  }

  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  return {
    runId: state.runId,
    phase: state.phase,
    main: {
      status: main.status,
      promoted: mainPromoted,
      promotionStatus: state.mainPromotion.status,
      promotionDetail: state.mainPromotion.detail,
    },
    panels: panelWorkers.map((w) => ({
      logicalPanelIndex: w.logicalPanelIndex as number,
      status: w.status,
      classification: w.candidate?.classification,
      evidenceStatus: evidenceByIndex.get(w.logicalPanelIndex as number)?.reconciledStatus,
    })),
    allPanelsTerminal,
    allPanelsClassified,
    awaitingPanelIndexes,
    panelEvidenceReportDir: harvest.reportDir,
    judge,
  };
}

export type HybridFinalizeResult = {
  runId: string;
  phase: SupervisorState["phase"];
  decision?: "PATCH_REQUIRED" | "NO_PATCH_REQUIRED";
  contractPath?: string;
  appliedPatchItems?: JudgeStageTrace["appliedPatchItems"];
  finalVerification?: SupervisorState["finalVerification"];
  abortReason?: string;
};

/**
 * Stage 4 (foreground): record the native judge subagent's terminal result
 * (from its result artifact and/or the model-reported output) and finalize.
 */
export async function hybridFinalize(
  args: {
    runId: string;
    judgeSessionId?: string;
    judgeTaskId?: string;
    judgeOutput?: string;
    judgeError?: string;
  },
  deps: SupervisorDeps,
): Promise<HybridFinalizeResult> {
  assertValidFusionRunId(args.runId);
  const now = deps.now ?? Date.now;
  const state = await loadSupervisorState(deps.cwd, args.runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${args.runId}.`);

  const judge = state.workers[WORKER_ID.judge];
  if (!judge) {
    throw new Error("FUSION_HYBRID_FINALIZE_FAILED: judge was never dispatched (call collect until eligible first)");
  }
  const at = nowIso(now);
  if (args.judgeSessionId) judge.sessionId = args.judgeSessionId;
  judge.terminalAt = at;
  judge.endedAt = at;
  const result = await readResultArtifact(judge.resultArtifactPath);
  if (result) judge.result = result;
  if (args.judgeError && !result) {
    transitionWorker(judge, "failed", at, args.judgeError);
  } else {
    transitionWorker(judge, result?.status === "failed" ? "failed" : "completed", at, result?.errorSummary);
  }

  state.judge.completedAt = at;
  state.nativeJudge = {
    sessionId: judge.sessionId,
    agentId: judge.agentId ?? FUSION_AGENT_NAMES.judge,
    configuredModelId: judge.configuredModelId ?? judge.modelId,
    dispatchRequestedAt: judge.dispatchRequestedAt,
    dispatchedAt: judge.dispatchedAt,
    terminalAt: judge.terminalAt,
    status: judge.status,
    mergePatchContractPath: result?.contractPath ?? state.judge.contractPath,
  };

  if (judge.status !== "completed" || !result) {
    state.phase = "aborted";
    state.abortReason = args.judgeError ?? "judge failed or produced no result artifact";
    await writeSupervisorState(state, deps.cwd, deps.traceDir);
    return { runId: state.runId, phase: state.phase, abortReason: state.abortReason };
  }

  const decision = result.mergePatchDecision;
  const contractExists = Boolean(result.contractPath) && (await pathExists(result.contractPath!));
  if (!decision || !contractExists) {
    state.phase = "aborted";
    state.abortReason = decision
      ? "judge succeeded but did not write a Merge Patch Contract artifact"
      : "judge succeeded but did not return a mergePatchDecision";
    await writeSupervisorState(state, deps.cwd, deps.traceDir);
    return { runId: state.runId, phase: state.phase, abortReason: state.abortReason };
  }

  state.judge.decision = decision;
  state.judge.contractPath = result.contractPath;
  const appliedItems = (result as Record<string, unknown>).appliedPatchItems as
    | JudgeStageTrace["appliedPatchItems"]
    | undefined;
  if (appliedItems) state.judge.appliedPatchItems = appliedItems;
  if (result.verification) state.finalVerification = result.verification;
  state.nativeJudge.appliedPatchSummary = appliedItems
    ? appliedItems.map((item) => `${item.severity}:${item.title}:${item.status}`).join("; ")
    : "no patch items reported";

  state.phase = "done";
  mainProcessRegistry.delete(state.runId);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  return {
    runId: state.runId,
    phase: state.phase,
    decision,
    contractPath: result.contractPath,
    appliedPatchItems: state.judge.appliedPatchItems,
    finalVerification: state.finalVerification,
  };
}

async function hybridCancelInternal(
  state: SupervisorState,
  deps: SupervisorDeps,
  now: () => number,
  reason: string,
): Promise<void> {
  const at = nowIso(now);
  const main = state.workers[WORKER_ID.main];
  const entry = mainProcessRegistry.get(state.runId);

  // Truthfully reconcile/terminate the external main process before final
  // failure so a launch/confirm failure never leaves an orphan main worker.
  let mainProcessOutcome: SupervisorCancellationOutcome;
  if (entry) {
    if (entry.exited) {
      mainProcessOutcome = "already_exited";
    } else {
      try {
        entry.handle.kill("SIGTERM");
        mainProcessOutcome = "terminated";
      } catch {
        mainProcessOutcome = "already_exited";
      }
    }
  } else if (main.pid !== undefined && isPidAlive(main.pid)) {
    try {
      process.kill(main.pid, "SIGTERM");
      mainProcessOutcome = "terminated";
    } catch {
      mainProcessOutcome = "left_running";
    }
  } else if (main.pid !== undefined) {
    mainProcessOutcome = "already_exited";
  } else {
    mainProcessOutcome = "no_handle";
  }
  mainProcessRegistry.delete(state.runId);

  for (const worker of Object.values(state.workers)) {
    if (!isTerminalWorkerStatus(worker.status)) {
      worker.endedAt = at;
      worker.terminalAt = at;
      transitionWorker(worker, "cancelled", at, reason);
      if (worker.executionKind === "native_subagent") worker.nativeWaveStage = "failed";
    }
  }
  state.phase = "cancelled";
  state.abortReason = reason;
  state.cancellation = {
    reason,
    at,
    mainProcessOutcome,
    mainPid: main.pid,
    cleanedUp: mainProcessOutcome !== "left_running",
  };
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
}

/** Cancel a run: terminate the external main process and mark live workers cancelled. */
export async function hybridCancel(
  args: { runId: string; reason?: string },
  deps: SupervisorDeps,
): Promise<{ runId: string; phase: SupervisorState["phase"] }> {
  assertValidFusionRunId(args.runId);
  const now = deps.now ?? Date.now;
  const state = await loadSupervisorState(deps.cwd, args.runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${args.runId}.`);
  await hybridCancelInternal(state, deps, now, args.reason ?? "cancelled by request");
  return { runId: state.runId, phase: state.phase };
}
