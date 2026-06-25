/**
 * Type model for the `real_parallel_process_build` strategy.
 *
 * This strategy is driven by a durable, detached Node supervisor that spawns
 * REAL concurrent OpenCode CLI worker processes (one main builder + three
 * panels), then a visible judge process and an optional patch worker. Every
 * worker is a genuine OS process tracked by PID; concurrency here means actual
 * overlapping process intervals, never prompt wording.
 *
 * Nothing in this module performs model calls or HTTP. Process execution is
 * delegated to the {@link WorkerRunner} abstraction so tests can inject a fake
 * OpenCode executable.
 */

export type WorkerRole = "main" | "panel" | "judge" | "patch";

/** Stable worker identifiers used as session titles and trace labels. */
export const WORKER_ID = {
  main: "fusion-main-builder",
  panel: (index: number) => `fusion-panel-${index}`,
  judge: "fusion-judge",
  patch: "fusion-main-patch-worker",
} as const;

/**
 * Worker process lifecycle states. These are derived from real process
 * evidence (PID liveness, stdout/stderr activity, result-artifact writes,
 * workspace mutations, child exit code), never fake heartbeats.
 */
export type WorkerStatus =
  | "queued"
  | "spawning"
  | "running"
  | "suspected_stalled"
  | "timed_out"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "timed_out",
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return TERMINAL_WORKER_STATUSES.has(status);
}

export type WorkerStatusTransition = {
  status: WorkerStatus;
  at: string;
  reason?: string;
};

export type WorkerVerification = {
  typecheck?: "pass" | "fail" | "not_run";
  test?: "pass" | "fail" | "not_run";
  build?: "pass" | "fail" | "not_run";
  commandsRun?: string[];
  notes?: string[];
};

/**
 * Machine-readable result artifact each worker is instructed to write. The
 * supervisor reads this from disk rather than parsing chat prose, so a short
 * final chat message never invalidates a real candidate.
 */
export type WorkerResultArtifact = {
  workerId: string;
  role: WorkerRole;
  runId: string;
  workspacePath: string;
  taskHash: string;
  status: "completed" | "failed";
  changedFiles?: string[];
  verification?: WorkerVerification;
  errorSummary?: string;
  completedAt?: string;
  /** Judge-only: merge patch decision and contract location. */
  mergePatchDecision?: "PATCH_REQUIRED" | "NO_PATCH_REQUIRED";
  contractPath?: string;
};

export type WorkerCandidateEvidence = {
  classification: "usable" | "partial" | "invalid" | "missing" | "pending";
  workspaceSafe: boolean;
  taskHashMatches: boolean;
  meaningfulChangedFiles: number;
  verificationPassing: boolean;
  hasTerminalResult: boolean;
  reason?: string;
};

export type WorkerRecord = {
  workerId: string;
  role: WorkerRole;
  /** 1-based logical panel slot for panel workers. */
  logicalPanelIndex?: number;
  modelId: string;
  variant?: string;
  /** Absolute workspace this worker owns. */
  workspacePath: string;
  /** Canonical task artifact + hash shared byte-identically by all panels. */
  taskArtifactPath: string;
  taskArtifactHash: string;
  /** Worker-specific instruction artifact path. */
  instructionArtifactPath: string;
  /** Deterministic machine-readable output + status artifact paths. */
  resultArtifactPath: string;
  statusArtifactPath: string;
  stdoutPath: string;
  stderrPath: string;
  sessionTitle: string;

  status: WorkerStatus;
  pid?: number;
  /** When the supervisor invoked spawn (process launch request). */
  launchRequestedAt?: string;
  /** When the OS reported the process started (pid assigned). */
  spawnedAt?: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;

  softSuspectMs: number;
  hardTimeoutMs: number;
  timedOutReason?: string;

  statusTransitions: WorkerStatusTransition[];
  result?: WorkerResultArtifact;
  candidate?: WorkerCandidateEvidence;
};

export type SupervisorPhase =
  | "bootstrapping"
  | "workers_running"
  | "judge"
  | "patch"
  | "audit"
  | "done"
  | "aborted";

export type ConcurrencyVerdict =
  | "REAL_PARALLEL_EXECUTION_CONFIRMED"
  | "REAL_PARALLEL_EXECUTION_NOT_CONFIRMED";

export type SupervisorConcurrency = {
  verdict: ConcurrencyVerdict;
  /** Number of panel processes whose run interval overlapped the main process. */
  panelsOverlappingMain: number;
  overlapDurationMs: number;
  blockingReason?: string;
};

export type SourceConflict = {
  detectedAt: string;
  expectedFingerprint: string;
  actualFingerprint: string;
  detail: string;
};

export type SnapshotTrace = {
  method: "git_worktree" | "concurrent_copy" | "reflink" | "archive_extract";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Workspace materialization (panel copies) duration, recorded separately. */
  materializationStartedAt?: string;
  materializationCompletedAt?: string;
  materializationDurationMs?: number;
};

export type JudgeStageTrace = {
  manifestPath?: string;
  eligibleAt?: string;
  dispatchedAt?: string;
  completedAt?: string;
  decision?: "PATCH_REQUIRED" | "NO_PATCH_REQUIRED";
  contractPath?: string;
  /** Panels frozen into the judged subset / excluded as late. */
  usablePanelIndexes?: number[];
  excludedPanelIndexes?: number[];
};

export type PatchStageTrace = {
  required: boolean;
  dispatchedAt?: string;
  completedAt?: string;
  status?: "completed" | "failed" | "skipped";
};

export const SUPERVISOR_STATE_VERSION = 1;

export type SupervisorState = {
  version: number;
  runId: string;
  command: string;
  strategy: "real_parallel_process_build";
  createdAt: string;
  updatedAt: string;
  phase: SupervisorPhase;

  /** Real user source workspace owned by the main builder. */
  sourceWorkspace: string;
  /** Fingerprint of the source captured before main begins, to detect drift. */
  sourceFingerprint: string;
  /** Detached supervisor process lock. */
  runLock?: { pid: number; acquiredAt: string };

  /** External staging root holding panel candidate workspaces. */
  stagingDir: string;
  /** Path of the immutable pre-main source snapshot manifest. */
  sourceSnapshotManifestPath: string;
  snapshot: SnapshotTrace;

  /** Canonical task artifact shared byte-identically by all panels. */
  taskArtifactPath: string;
  taskArtifactHash: string;

  judgeModelId: string;
  mainModelId: string;

  workers: Record<string, WorkerRecord>;

  judge: JudgeStageTrace;
  patch: PatchStageTrace;
  concurrency: SupervisorConcurrency;
  conflicts: SourceConflict[];

  abortReason?: string;
  finalVerification?: WorkerVerification;
};

export type SupervisorTimeouts = {
  mainSoftSuspectMs: number;
  mainHardTimeoutMs: number;
  panelSoftSuspectMs: number;
  panelHardTimeoutMs: number;
  judgeSoftSuspectMs: number;
  judgeHardTimeoutMs: number;
  patchSoftSuspectMs: number;
  patchHardTimeoutMs: number;
};

export const DEFAULT_SUPERVISOR_TIMEOUTS: SupervisorTimeouts = {
  mainSoftSuspectMs: 8 * 60_000,
  mainHardTimeoutMs: 25 * 60_000,
  panelSoftSuspectMs: 8 * 60_000,
  panelHardTimeoutMs: 25 * 60_000,
  judgeSoftSuspectMs: 5 * 60_000,
  judgeHardTimeoutMs: 15 * 60_000,
  patchSoftSuspectMs: 5 * 60_000,
  patchHardTimeoutMs: 15 * 60_000,
};
