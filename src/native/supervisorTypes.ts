/**
 * Type model for the hybrid `hybrid_external_main_native_panels` strategy.
 *
 * Fresh `/fusion-build` uses a hybrid visible-native pipeline:
 * - ONE external `opencode run` main builder in an ISOLATED main candidate
 *   workspace (never the real source workspace during initial implementation);
 * - THREE visible native Task subagents for panels (`fusion-panel-1/2/3`) in
 *   isolated panel candidate workspaces, all derived from the same immutable
 *   pre-main source snapshot;
 * - On successful main terminal, the main candidate is promoted snapshot-
 *   relatively into the real source workspace (panels may still be running);
 * - ONE visible native Task subagent for the judge (`fusion-judge`) that runs
 *   directly against the promoted real source workspace, compares all
 *   implementations, writes a Merge Patch Contract, and applies targeted fixes
 *   ITSELF — there is no second external patch worker.
 *
 * Nothing in this module performs model calls or HTTP. External workers use
 * {@link WorkerRunner}; native panel/judge dispatch uses
 * {@link NativeSubagentDispatcher}.
 */

export type WorkerRole = "main" | "panel" | "judge";

export type WorkerExecutionKind = "external_process" | "native_subagent";

/** Stable worker identifiers used as session titles and trace labels. */
export const WORKER_ID = {
  main: "fusion-main-builder",
  panel: (index: number) => `fusion-panel-${index}`,
  judge: "fusion-judge",
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
  executionKind: WorkerExecutionKind;
  /** 1-based logical panel slot for panel workers. */
  logicalPanelIndex?: number;
  modelId: string;
  configuredModelId?: string;
  requestedModelId?: string;
  observedProviderId?: string;
  observedModelId?: string;
  variant?: string;
  agentId?: string;
  sessionId?: string;
  dispatchMechanism?: string;
  dispatchRequestedAt?: string;
  dispatchedAt?: string;
  terminalAt?: string;
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
  /** When the worker's owned workspace was fully materialized and ready. */
  workspaceReadyAt?: string;
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
  | "running"
  | "workers_running"
  | "promotion"
  | "judge"
  | "done"
  | "aborted";

export type ConcurrencyVerdict =
  | "HYBRID_PARALLEL_LAUNCH_CONFIRMED"
  | "HYBRID_PARALLEL_LAUNCH_NOT_CONFIRMED";

export type SupervisorConcurrency = {
  verdict: ConcurrencyVerdict;
  /** Number of native panel dispatches that succeeded at launch. */
  panelsLaunched: number;
  /** Whether all four primary launch timestamps were recorded. */
  allLaunchTimestampsRecorded: boolean;
  /** Whether panel dispatch requests were issued without serial completion waits. */
  parallelPanelDispatchIssued: boolean;
  /** Whether any panel was dispatched through external opencode run (must be false). */
  noPanelViaExternalCli: boolean;
  /** Whether the main requested model equals the observed runtime model. */
  mainModelMatched: boolean;
  mainLaunchAt?: string;
  panelLaunchAt?: Partial<Record<1 | 2 | 3, string>>;
  blockingReason?: string;
};

export type NativePanelSessionTrace = {
  panelNumber: 1 | 2 | 3;
  sessionId?: string;
  agentId: string;
  configuredModelId: string;
  candidateWorkspace: string;
  dispatchRequestedAt?: string;
  dispatchedAt?: string;
  terminalAt?: string;
  status: WorkerStatus;
  resultArtifactPath: string;
};

export type NativeJudgeSessionTrace = {
  sessionId?: string;
  agentId: string;
  configuredModelId: string;
  dispatchRequestedAt?: string;
  dispatchedAt?: string;
  terminalAt?: string;
  status: WorkerStatus;
  mergePatchContractPath?: string;
  appliedPatchSummary?: string;
};

export type ExternalMainWorkerTrace = {
  pid?: number;
  requestedModelId?: string;
  configuredModelId?: string;
  observedProviderId?: string;
  observedModelId?: string;
  /** Isolated main candidate workspace (never the source workspace pre-promotion). */
  workspace: string;
  status: WorkerStatus;
  stdoutPath: string;
  stderrPath: string;
  launchRequestedAt?: string;
  spawnedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Whether the main candidate was promoted into the real source workspace. */
  promoted?: boolean;
  promotionManifestPath?: string;
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
  /** Patch items the judge reported applying directly to the source workspace. */
  appliedPatchItems?: Array<{ severity: "BLOCKER" | "MUST_FIX" | "SAFE_ADDITION"; title: string; status: "applied" | "skipped" | "failed" }>;
};

export type MainPromotionTrace = {
  /** Absolute path of the isolated main candidate workspace. */
  candidateWorkspace: string;
  /** Path of the written promotion manifest. */
  manifestPath?: string;
  promotedAt?: string;
  status?: "pending" | "promoted" | "failed" | "skipped";
  /** Relative paths promoted from the main candidate into the source workspace. */
  promotedPaths?: string[];
  /** Paths in the source workspace preserved (not overwritten) due to post-run user edits. */
  preservedPaths?: string[];
  /** Whether the source workspace was confirmed untouched before promotion. */
  sourceUntouchedBeforePromotion?: boolean;
  detail?: string;
};

export const SUPERVISOR_STATE_VERSION = 1;

export type SupervisorState = {
  version: number;
  runId: string;
  command: string;
  strategy: "hybrid_external_main_native_panels";
  createdAt: string;
  updatedAt: string;
  launchRequestedAt: string;
  supervisorPid?: number;
  phase: SupervisorPhase;

  /** Real user source workspace; promoted-into after main candidate completes. */
  sourceWorkspace: string;
  /** Fingerprint of the source captured before main begins, to detect drift. */
  sourceFingerprint: string;
  /** Detached supervisor process lock. */
  runLock?: { pid: number; acquiredAt: string };

  /** External staging root holding main + panel candidate workspaces. */
  stagingDir: string;
  /** Immutable copy of the source captured before main mutations begin. */
  sourceSnapshotWorkspacePath: string;
  /** Path of the immutable pre-main source snapshot manifest. */
  sourceSnapshotManifestPath: string;
  /** Isolated main candidate workspace (external, never the source workspace). */
  mainCandidateWorkspace: string;
  snapshot: SnapshotTrace;

  /** Canonical task artifact shared byte-identically by main and all panels. */
  taskArtifactPath: string;
  taskArtifactHash: string;

  judgeModelId: string;
  mainModelId: string;

  workers: Record<string, WorkerRecord>;

  /** Main candidate → source promotion record. */
  mainPromotion: MainPromotionTrace;
  judge: JudgeStageTrace;
  concurrency: SupervisorConcurrency;
  externalMain?: ExternalMainWorkerTrace;
  nativePanels?: NativePanelSessionTrace[];
  nativeJudge?: NativeJudgeSessionTrace;
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
};

export const DEFAULT_SUPERVISOR_TIMEOUTS: SupervisorTimeouts = {
  mainSoftSuspectMs: 8 * 60_000,
  mainHardTimeoutMs: 25 * 60_000,
  panelSoftSuspectMs: 8 * 60_000,
  panelHardTimeoutMs: 25 * 60_000,
  judgeSoftSuspectMs: 8 * 60_000,
  judgeHardTimeoutMs: 25 * 60_000,
};
