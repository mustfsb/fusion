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
  | "preparing"
  | "launching"
  | "spawning"
  | "running"
  | "retrying"
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

/**
 * Truthful native-wave trace for a panel/judge dispatched as a visible Task
 * subagent. These distinguish what the host actually exposed at each point:
 * - `dispatch_requested`: the parent has been told to dispatch (begin_native_wave)
 *   but no host-observable running/terminal evidence exists yet. Never implies a
 *   fake session ID or fake running state.
 * - `native_task_running_when_observable`: the host exposed a real native session
 *   ID (or equivalent running evidence) for the Task subagent.
 * - `completed` / `failed` / `timed_out`: a real terminal result was observed.
 */
export type NativeWaveStage =
  | "dispatch_requested"
  | "native_task_running_when_observable"
  | "completed"
  | "failed"
  | "timed_out";

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
  /** Truthful native-wave trace stage for native_subagent workers. */
  nativeWaveStage?: NativeWaveStage;
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
  /** Optional local worker-control artifacts, used by the external main worker. */
  workerContextArtifactPath?: string;
  verificationArtifactPath?: string;
  workspaceContractValidated?: boolean;
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
  /** Multi-source native panel evidence reconciled at confirm_launch. */
  runtimeEvidence?: NativePanelRuntimeEvidence;
};

export type SupervisorPhase =
  | "initializing"
  | "bootstrapping"
  | "preparing"
  | "launching"
  | "running"
  | "workers_running"
  | "promotion"
  | "judge"
  | "done"
  | "aborted"
  | "cancelled"
  | "timed_out";

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

export type NativePanelReconciledStatus =
  | "no_dispatch_evidence"
  | "dispatched_pending_completion"
  | "completed_with_session"
  | "completed_with_receipt"
  | "completed_with_task"
  /**
   * The panel visibly ran and mutated its REGISTERED candidate workspace
   * (snapshot-relative meaningful source change) but the parent supplied no
   * native session ID, no valid receipt, and no panelOutcomes entry. This is a
   * self-healed, usable-degraded candidate — never a fatal/awaiting one.
   */
  | "completed_degraded"
  | "completed_invalid_receipt"
  | "failed";

/** Final accept/reject/await verdict for one native panel's reconciled evidence. */
export type NativePanelEvidenceAcceptance = "accepted" | "rejected" | "awaiting";

/** Multi-source runtime evidence reconciled at confirm_launch for one native panel. */
export type NativePanelRuntimeEvidence = {
  agentId: string;
  nativeSessionIdAvailable: boolean;
  sessionId?: string;
  taskId?: string;
  taskCompletionEvidence: boolean;
  taskCompletionSummary?: string;
  receiptArtifactPath?: string;
  receiptValidity: "valid" | "invalid" | "missing";
  receiptValidationErrors?: string[];
  candidateMutationEvidence: boolean;
  reconciledStatus: NativePanelReconciledStatus;
  /**
   * Whether the parent supplied an explicit panelOutcomes entry for this panel
   * (vs the supervisor reconstructing evidence purely from on-disk artifacts).
   */
  parentOutcomeProvided?: boolean;
  /** Spoof/mismatch errors found in the parent-supplied panelOutcomes entry. */
  contractMismatchErrors?: string[];
  /** Accept/reject/await classification computed at confirm_launch. */
  acceptance?: NativePanelEvidenceAcceptance;
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
  nativeWaveStage?: NativeWaveStage;
  resultArtifactPath: string;
  runtimeEvidence?: NativePanelRuntimeEvidence;
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
  invokingSessionModelId?: string;
  requestedModelId?: string;
  configuredModelId?: string;
  observedProviderId?: string;
  observedModelId?: string;
  /** Isolated main candidate workspace (never the source workspace pre-promotion). */
  workspace: string;
  localCanonicalTaskPath?: string;
  workspaceContractValidated?: boolean;
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
  failureReason?: string;
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

/**
 * Run-level timing config, persisted at launch and reused by every later stage.
 * These are intentionally SEPARATE concepts so a long native panel execution can
 * never be mistaken for a slow startup:
 * - `externalMainStartupDeadlineMs`: short guard that only verifies the external
 *   main process obtained a real PID at launch (or fails loudly).
 * - `nativeDispatchRegistrationDeadlineMs`: guards only the time from main spawn
 *   to the parent calling `begin_native_wave` (registering the dispatch). It does
 *   NOT bound how long the panels run.
 * - `nativePanelExecutionTimeoutMs`: the real long-running panel execution
 *   timeout, applied while monitoring/collecting, never at launch confirmation.
 */
export type FusionRunTiming = {
  externalMainStartupDeadlineMs: number;
  nativeDispatchRegistrationDeadlineMs: number;
  nativePanelExecutionTimeoutMs: number;
};

/** Native panel dispatch-wave registration trace recorded by begin_native_wave. */
export type NativeWaveTrace = {
  registrationDeadlineMs: number;
  /** ISO time the parent declared it is about to dispatch the panel wave. */
  dispatchRequestedAt?: string;
  /** ISO time begin_native_wave was accepted. */
  registeredAt?: string;
  /** main-spawn -> begin_native_wave elapsed at registration time. */
  registrationElapsedMs?: number;
  /** Whether registration was explicit (begin_native_wave) or implied at confirm. */
  registeredVia?: "begin_native_wave" | "confirm_launch_implicit";
  expectedPanelAgentIds: string[];
  /** ISO time the parent returned from the blocking native Task wave. */
  waveReturnedAt?: string;
  /** True once confirm_launch records the parent wave return. */
  parentWaveReturned?: boolean;
  /** Number of panelOutcomes entries the most recent confirm_launch received. */
  confirmPanelOutcomesReceived?: number;
  /** ISO time of the last confirm_launch acknowledgement. */
  lastConfirmAt?: string;
};

/** Cancellation / failure cleanup record (duplicate-run + orphan safety). */
export type SupervisorCancellation = {
  reason: string;
  at: string;
  /** What happened to the external main process during cleanup. */
  mainProcessOutcome: "terminated" | "already_exited" | "no_handle" | "left_running";
  mainPid?: number;
  cleanedUp: boolean;
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
  invokingSessionModelId?: string;
  modelConfigFingerprint?: string;

  /** Persisted run-level timing config; written at launch, reused everywhere. */
  runTiming?: FusionRunTiming;
  /** Native panel dispatch-wave registration trace (begin_native_wave). */
  nativeWave?: NativeWaveTrace;
  /** Cancellation / failure cleanup record. */
  cancellation?: SupervisorCancellation;

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
