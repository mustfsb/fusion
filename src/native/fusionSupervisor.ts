import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import { resolveTraceRoot } from "../trace/runTrace.js";
import { assertValidFusionRunId } from "./runLocator.js";
import {
  captureBaselineManifest,
  createCandidateWorkspaces,
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
  now?: () => number;
  /** Liveness poll interval. */
  pollIntervalMs?: number;
  timeouts?: Partial<SupervisorTimeouts>;
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
    lines.push("Implement the task independently in THIS workspace (the real source).");
    lines.push("Do NOT wait for or read any panel candidate workspace, judge, or merge patch contract.");
    lines.push("Run typecheck/test/build.");
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
  } else if (input.role === "patch") {
    lines.push("Apply only the required fixes from the Merge Patch Contract to THIS real source workspace.");
    if (input.contractPath) lines.push(`Merge Patch Contract: ${input.contractPath}`);
    lines.push("Run typecheck/test/build.");
  }
  lines.push(
    `When finished, write your machine-readable result JSON to: ${input.resultArtifactPath} ` +
      "(fields: workerId, role, status[completed|failed], changedFiles, verification, errorSummary, completedAt; " +
      "judge additionally writes mergePatchDecision + contractPath). A short final chat message is fine.",
  );
  return lines.join("\n");
}

function makeWorkerRecord(input: {
  workerId: string;
  role: WorkerRole;
  modelSpec: FusionModelSpec;
  workspacePath: string;
  taskArtifactPath: string;
  taskArtifactHash: string;
  runDir: string;
  softMs: number;
  hardMs: number;
  logicalPanelIndex?: number;
}): WorkerRecord {
  const paths = workerArtifactPaths(input.runDir, input.workerId);
  return {
    workerId: input.workerId,
    role: input.role,
    logicalPanelIndex: input.logicalPanelIndex,
    modelId: input.modelSpec.modelId,
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
    throw new Error(`real_parallel_process_build requires ${PANEL_COUNT} panel models.`);
  }
  const now = deps.now ?? Date.now;
  const timeouts = resolveTimeouts(deps.timeouts);
  const sourceWorkspace = path.resolve(input.sourceWorkspace);
  const runDir = supervisorRunDir(deps.cwd, input.runId, deps.traceDir);
  await mkdir(path.join(runDir, "logs"), { recursive: true });

  // Canonical task artifact (byte-identical task hash for all panels).
  const taskArtifactPath = path.join(runDir, "canonical-task.md");
  const taskContent = `# Fusion Canonical Task\n\n${input.task}\n`;
  await writeFile(taskArtifactPath, taskContent, "utf8");
  const taskArtifactHash = hashTask(taskContent);

  // Immutable source snapshot fingerprint (taken before main mutates source).
  const snapshotStartIso = nowIso(now);
  const snapshotStart = now();
  const sourceManifest = await captureBaselineManifest(sourceWorkspace, new Date(now()));
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(sourceManifest.files), "utf8")
    .digest("hex");
  const sourceSnapshotManifestPath = path.join(runDir, "source-snapshot-manifest.json");
  await writeFile(sourceSnapshotManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
  const snapshotEnd = now();

  // Concurrent materialization of isolated panel candidate workspaces.
  const materializeStartIso = nowIso(now);
  const materializeStart = now();
  const paths = buildSpeculativeWorkspacePaths({
    sourceWorkspace,
    sourceArtifactDir: runDir,
    runId: input.runId,
    panelCount: PANEL_COUNT,
  });
  const candidate = await createCandidateWorkspaces({ paths, panelCount: PANEL_COUNT, now: () => new Date(now()) });
  if (!candidate.ok) {
    throw new Error(`Failed to materialize panel candidate workspaces: ${candidate.diagnostic ?? "unknown"}`);
  }
  const materializeEnd = now();

  const workers: Record<string, WorkerRecord> = {};
  const mainWorker = makeWorkerRecord({
    workerId: WORKER_ID.main,
    role: "main",
    modelSpec: input.mainModel,
    workspacePath: sourceWorkspace,
    taskArtifactPath,
    taskArtifactHash,
    runDir,
    softMs: timeouts.mainSoftSuspectMs,
    hardMs: timeouts.mainHardTimeoutMs,
  });
  workers[mainWorker.workerId] = mainWorker;

  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const ws = candidate.workspaces[index - 1];
    const panelWorker = makeWorkerRecord({
      workerId: WORKER_ID.panel(index),
      role: "panel",
      modelSpec: input.panelModels[index - 1],
      workspacePath: ws.workspacePath,
      taskArtifactPath,
      taskArtifactHash,
      runDir,
      softMs: timeouts.panelSoftSuspectMs,
      hardMs: timeouts.panelHardTimeoutMs,
      logicalPanelIndex: index,
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
        sourceWorkspaceProhibited: worker.role === "panel" ? sourceWorkspace : undefined,
        logicalPanelIndex: worker.logicalPanelIndex,
      }),
      "utf8",
    );
  }

  const state: SupervisorState = {
    version: SUPERVISOR_STATE_VERSION,
    runId: input.runId,
    command: input.command ?? "fusion-build",
    strategy: "real_parallel_process_build",
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    phase: "bootstrapping",
    sourceWorkspace,
    sourceFingerprint,
    stagingDir: paths.externalStagingDir,
    sourceSnapshotManifestPath,
    snapshot: {
      method: "concurrent_copy",
      startedAt: snapshotStartIso,
      completedAt: nowIso(now),
      durationMs: snapshotEnd - snapshotStart,
      materializationStartedAt: materializeStartIso,
      materializationCompletedAt: nowIso(now),
      materializationDurationMs: materializeEnd - materializeStart,
    },
    taskArtifactPath,
    taskArtifactHash,
    mainModelId: input.mainModel.modelId,
    judgeModelId: input.judgeModel.modelId,
    workers,
    judge: {},
    patch: { required: false },
    concurrency: {
      verdict: "REAL_PARALLEL_EXECUTION_NOT_CONFIRMED",
      panelsOverlappingMain: 0,
      overlapDurationMs: 0,
      blockingReason: "workers not yet launched",
    },
    conflicts: [],
  };
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
  };
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
    workspacePath: worker.workspacePath,
    sessionTitle: worker.sessionTitle,
    promptText,
    env: workerEnv(state, worker),
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
  };
  const handle = await runner.spawn(spec);
  worker.pid = handle.pid;
  worker.spawnedAt = nowIso(now);
  transitionWorker(worker, "running", worker.spawnedAt);
  return handle;
}

type WorkerMonitor = {
  worker: WorkerRecord;
  handle: SpawnedWorkerHandle;
  exited: boolean;
  exitObserved: boolean;
  lastStdout: number;
  lastStderr: number;
};

/**
 * Launch the four primary workers (main + 3 panels) as real concurrent
 * processes WITHOUT awaiting any worker result, then monitor them to terminal
 * state using genuine process evidence and hard timeouts.
 */
export async function superviseRun(runId: string, deps: SupervisorDeps): Promise<SupervisorState> {
  assertValidFusionRunId(runId);
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const runner = deps.runner ?? createOpenCodeProcessWorkerRunner();
  const state = await loadSupervisorState(deps.cwd, runId, deps.traceDir);
  if (!state) throw new Error(`No supervisor state for run ${runId}.`);
  state.runLock = { pid: process.pid, acquiredAt: nowIso(now) };

  // Detect external source drift before main owns the workspace.
  await detectSourceConflict(state, now);

  // ---- Phase: launch + monitor the four primary workers concurrently ----
  state.phase = "workers_running";
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  const primary = [
    state.workers[WORKER_ID.main],
    state.workers[WORKER_ID.panel(1)],
    state.workers[WORKER_ID.panel(2)],
    state.workers[WORKER_ID.panel(3)],
  ];

  // Reuse completed workers on resume; never rerun a valid completed worker.
  const toLaunch = primary.filter((w) => !isTerminalWorkerStatus(w.status));
  for (const w of primary.filter((w) => isTerminalWorkerStatus(w.status))) {
    if (!w.result) w.result = await readResultArtifact(w.resultArtifactPath);
  }

  // Launch all pending workers concurrently. We await only process creation,
  // never a worker's exit — the four spawn calls all happen before any worker
  // finishes.
  const monitors: WorkerMonitor[] = await Promise.all(
    toLaunch.map(async (worker) => {
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
    }),
  );
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  await monitorUntilTerminal(monitors, state, deps, now, pollIntervalMs);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  // ---- Candidate classification from workspace evidence ----
  await classifyPanels(state);
  computeConcurrency(state);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);

  // ---- Judge: only after main + all panels are terminal ----
  await runJudgeStage(state, deps, runner, now, pollIntervalMs);

  // ---- Patch worker: only on valid PATCH_REQUIRED contract ----
  await runPatchStage(state, deps, runner, now, pollIntervalMs);

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

  // Real activity evidence: stdout/stderr growth + result artifact existence.
  const outSize = await fileSize(worker.stdoutPath);
  const errSize = await fileSize(worker.stderrPath);
  const resultExists = (await fileSize(worker.resultArtifactPath)) >= 0;
  const grew = outSize > monitor.lastStdout || errSize > monitor.lastStderr;
  monitor.lastStdout = Math.max(monitor.lastStdout, outSize);
  monitor.lastStderr = Math.max(monitor.lastStderr, errSize);
  if (grew || resultExists) {
    if (!worker.firstActivityAt) worker.firstActivityAt = at;
    worker.lastActivityAt = at;
  }

  // Process exited?
  if (monitor.exited) {
    monitor.exitObserved = true;
    worker.endedAt = at;
    const result = await readResultArtifact(worker.resultArtifactPath);
    if (result) worker.result = result;
    if (worker.status === "timed_out") {
      // Keep timed_out terminal status, but retain any valid pre-kill result.
      return;
    }
    const failed = (worker.exitCode ?? 1) !== 0 || result?.status === "failed";
    transitionWorker(worker, failed ? "failed" : "completed", at, result?.errorSummary);
    return;
  }

  // Hard timeout: terminate only this worker process.
  const spawnedMs = worker.spawnedAt ? new Date(worker.spawnedAt).getTime() : now();
  if (now() - spawnedMs >= worker.hardTimeoutMs) {
    worker.timedOutReason = `hard timeout after ${worker.hardTimeoutMs}ms with no terminal exit`;
    transitionWorker(worker, "timed_out", at, worker.timedOutReason);
    worker.endedAt = at;
    // Capture any candidate result written before termination.
    const result = await readResultArtifact(worker.resultArtifactPath);
    if (result) worker.result = result;
    monitor.handle.kill("SIGTERM");
    return;
  }

  // Soft suspect: no credible activity within the soft window.
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

function computeConcurrency(state: SupervisorState): void {
  const main = state.workers[WORKER_ID.main];
  const mainStart = main.spawnedAt ? new Date(main.spawnedAt).getTime() : undefined;
  const mainEnd = main.endedAt ? new Date(main.endedAt).getTime() : undefined;
  let overlapping = 0;
  let maxOverlap = 0;
  if (mainStart !== undefined) {
    const mainStop = mainEnd ?? Number.MAX_SAFE_INTEGER;
    for (let index = 1; index <= PANEL_COUNT; index += 1) {
      const panel = state.workers[WORKER_ID.panel(index)];
      if (!panel?.spawnedAt) continue;
      const pStart = new Date(panel.spawnedAt).getTime();
      const pStop = panel.endedAt ? new Date(panel.endedAt).getTime() : Number.MAX_SAFE_INTEGER;
      const overlap = Math.min(mainStop, pStop) - Math.max(mainStart, pStart);
      if (overlap > 0) {
        overlapping += 1;
        maxOverlap = Math.max(maxOverlap, overlap === Number.MAX_SAFE_INTEGER ? 0 : overlap);
      }
    }
  }
  if (overlapping >= 2) {
    state.concurrency = {
      verdict: "REAL_PARALLEL_EXECUTION_CONFIRMED",
      panelsOverlappingMain: overlapping,
      overlapDurationMs: Number.isFinite(maxOverlap) ? maxOverlap : 0,
    };
  } else {
    state.concurrency = {
      verdict: "REAL_PARALLEL_EXECUTION_NOT_CONFIRMED",
      panelsOverlappingMain: overlapping,
      overlapDurationMs: Number.isFinite(maxOverlap) ? maxOverlap : 0,
      blockingReason:
        mainStart === undefined
          ? "main builder never spawned"
          : `only ${overlapping} panel process interval(s) overlapped the main process; need >= 2`,
    };
  }
}

function usablePanelIndexes(state: SupervisorState): number[] {
  const indexes: number[] = [];
  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const worker = state.workers[WORKER_ID.panel(index)];
    if (worker?.candidate?.classification === "usable") indexes.push(index);
  }
  return indexes;
}

async function writeJudgeManifest(state: SupervisorState, deps: SupervisorDeps): Promise<string> {
  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const manifestPath = path.join(runDir, "judge-preflight-manifest.json");
  const main = state.workers[WORKER_ID.main];
  const manifest = {
    runId: state.runId,
    taskArtifactPath: state.taskArtifactPath,
    taskArtifactHash: state.taskArtifactHash,
    main: {
      workspacePath: main.workspacePath,
      resultArtifactPath: main.resultArtifactPath,
      status: main.status,
    },
    panels: [1, 2, 3].map((index) => {
      const worker = state.workers[WORKER_ID.panel(index)];
      return {
        logicalPanelIndex: index,
        workspacePath: worker?.workspacePath,
        resultArtifactPath: worker?.resultArtifactPath,
        classification: worker?.candidate?.classification,
        status: worker?.status,
      };
    }),
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function runJudgeStage(
  state: SupervisorState,
  deps: SupervisorDeps,
  runner: WorkerRunner,
  now: () => number,
  pollIntervalMs: number,
): Promise<void> {
  const primary = [
    state.workers[WORKER_ID.main],
    state.workers[WORKER_ID.panel(1)],
    state.workers[WORKER_ID.panel(2)],
    state.workers[WORKER_ID.panel(3)],
  ];
  // Judge launch policy: main + ALL panels must be terminal.
  if (!primary.every((w) => isTerminalWorkerStatus(w.status))) {
    state.phase = "aborted";
    state.abortReason = "judge not eligible: some primary worker is not terminal";
    return;
  }
  // Resume: a completed judge with a recorded decision is never re-run.
  const existingJudge = state.workers[WORKER_ID.judge];
  if (existingJudge && existingJudge.status === "completed" && state.judge.decision) {
    return;
  }

  const usable = usablePanelIndexes(state);
  const mainUsable = state.workers[WORKER_ID.main].status === "completed";
  if (!mainUsable || usable.length < 1) {
    state.phase = "aborted";
    state.abortReason = `judge not dispatched: main usable=${mainUsable}, usable panels=${usable.length}`;
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
    modelSpec: { modelId: state.judgeModelId },
    workspacePath: state.sourceWorkspace,
    taskArtifactPath: state.taskArtifactPath,
    taskArtifactHash: state.taskArtifactHash,
    runDir,
    softMs: resolveTimeouts(deps.timeouts).judgeSoftSuspectMs,
    hardMs: resolveTimeouts(deps.timeouts).judgeHardTimeoutMs,
  });
  await writeFile(
    judge.instructionArtifactPath,
    buildWorkerPrompt({
      role: "judge",
      workerId: judge.workerId,
      workspacePath: judge.workspacePath,
      taskArtifactPath: state.taskArtifactPath,
      resultArtifactPath: judge.resultArtifactPath,
    }) + `\nPreflight manifest: ${manifestPath}\n`,
    "utf8",
  );
  state.workers[judge.workerId] = judge;
  state.judge.dispatchedAt = nowIso(now);

  await runSingleWorker(state, judge, deps, runner, now, pollIntervalMs);
  state.judge.completedAt = nowIso(now);

  const result = judge.result;
  if (judge.status !== "completed" || !result) {
    state.phase = "aborted";
    state.abortReason = "judge failed or produced no contract";
    return;
  }
  // A valid contract is required. NO_PATCH_REQUIRED is only valid here, after
  // judge success and a written contract.
  state.judge.decision = result.mergePatchDecision ?? "NO_PATCH_REQUIRED";
  state.judge.contractPath = result.contractPath;
}

async function runPatchStage(
  state: SupervisorState,
  deps: SupervisorDeps,
  runner: WorkerRunner,
  now: () => number,
  pollIntervalMs: number,
): Promise<void> {
  if (state.phase === "aborted") return;
  if (state.judge.decision !== "PATCH_REQUIRED") {
    state.patch = { required: false, status: "skipped" };
    return;
  }
  // Resume: never re-run a completed patch worker.
  const existingPatch = state.workers[WORKER_ID.patch];
  if (existingPatch && isTerminalWorkerStatus(existingPatch.status)) {
    state.patch.required = true;
    state.patch.status = existingPatch.status === "completed" ? "completed" : "failed";
    state.phase = "audit";
    if (existingPatch.result?.verification) state.finalVerification = existingPatch.result.verification;
    return;
  }
  state.phase = "patch";
  state.patch.required = true;
  state.patch.dispatchedAt = nowIso(now);
  const runDir = supervisorRunDir(deps.cwd, state.runId, deps.traceDir);
  const patch = makeWorkerRecord({
    workerId: WORKER_ID.patch,
    role: "patch",
    modelSpec: { modelId: state.mainModelId },
    workspacePath: state.sourceWorkspace,
    taskArtifactPath: state.taskArtifactPath,
    taskArtifactHash: state.taskArtifactHash,
    runDir,
    softMs: resolveTimeouts(deps.timeouts).patchSoftSuspectMs,
    hardMs: resolveTimeouts(deps.timeouts).patchHardTimeoutMs,
  });
  await writeFile(
    patch.instructionArtifactPath,
    buildWorkerPrompt({
      role: "patch",
      workerId: patch.workerId,
      workspacePath: patch.workspacePath,
      taskArtifactPath: state.taskArtifactPath,
      resultArtifactPath: patch.resultArtifactPath,
      contractPath: state.judge.contractPath,
    }),
    "utf8",
  );
  state.workers[patch.workerId] = patch;
  await runSingleWorker(state, patch, deps, runner, now, pollIntervalMs);
  state.patch.completedAt = nowIso(now);
  state.patch.status = patch.status === "completed" ? "completed" : "failed";
  state.phase = "audit";
  if (patch.result?.verification) state.finalVerification = patch.result.verification;
}

async function runSingleWorker(
  state: SupervisorState,
  worker: WorkerRecord,
  deps: SupervisorDeps,
  runner: WorkerRunner,
  now: () => number,
  pollIntervalMs: number,
): Promise<void> {
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
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
  await monitorUntilTerminal([monitor], state, deps, now, pollIntervalMs);
  await writeSupervisorState(state, deps.cwd, deps.traceDir);
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
