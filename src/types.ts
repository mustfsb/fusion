import type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type ProviderKind = "openai-compatible" | "anthropic" | "google";

export type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type CouncilMode = "plan" | "review" | "decision" | "build_prompt" | "architecture";

export type PanelMode = "advisory" | "candidate_build";

/**
 * Internal build strategy for `/fusion-build`.
 *
 * - `hybrid_external_main_native_panels`: the DEFAULT strategy. A detached Node
 *   supervisor spawns ONE external OpenCode CLI main builder in an isolated
 *   main candidate workspace and dispatches THREE visible native panel
 *   subagents concurrently, all derived from the same immutable pre-main source
 *   snapshot. When the main builder succeeds, its candidate is promoted
 *   snapshot-relatively into the real source workspace (panels may still run).
 *   Then a visible native judge subagent runs against the promoted source,
 *   writes a Merge Patch Contract, and applies targeted fixes itself. There is
 *   no second external patch worker. Concurrency is real OS-level process
 *   overlap plus native subagent dispatch, not prompt wording.
 * - `speculative_parallel_build`: legacy native-subagent compatibility fallback.
 *   Panels build competing candidates in isolated workspaces driven by the
 *   parent orchestrator's advance loop. Retained only as a non-default fallback.
 *
 * `/fusion-no-build` does not set a build strategy (it remains planning-only).
 */
export type BuildStrategy = "hybrid_external_main_native_panels" | "speculative_parallel_build";

/** The default `/fusion-build` strategy. */
export const DEFAULT_BUILD_STRATEGY: BuildStrategy = "hybrid_external_main_native_panels";

export type PromptVerbosity = "compact" | "standard" | "detailed";

export type PromptTransportMode = "inline_full" | "brief_plus_file";

export type PromptTransportMetadata = {
  mode: PromptTransportMode;
  canonicalLineCount: number;
  inlineLineCount: number;
  canonicalSha256: string;
  inlineSha256: string;
  fullArtifactPath?: string;
  briefArtifactPath?: string;
};

export type CouncilDecision = "implement" | "do_not_implement" | "needs_more_info" | "use_caution";

export type ModelSource = "auto" | "opencode" | "direct";

export type ExecutionMode = "native_subagents" | "direct_sdk";

export type ModelErrorType = "timeout" | "empty_response" | "provider_error" | "rate_limit" | "model_not_found" | "validation" | "unknown";

export type CandidateValidationStatus = "passed" | "usable_with_warnings" | "failed";

export type ContractGate = {
  literalPublicSurface: string[];
  behavioralBoundaries: string[];
  consumerCompatibility: string[];
  externalConsumerProbes: string[];
  packageRootExports: string[];
  requiredInstanceMethods: string[];
  requiredTypesAndErrors: string[];
  requiredOptionAndFieldNames: string[];
  returnAndThrowContracts: string[];
};

export type ContractGateTraceSummary = {
  literalRequirementsDetected: number;
  publicExportsRequired: string[];
  consumerProbesRequired: string[];
  compatibilityRecommendations: string[];
};

export type PostBuildAuditFinding = {
  requirement: string;
  observed: string;
  requiredFix: string;
};

export type PostBuildAuditStatus = "pass" | "fix_required" | "not_run";

export type ContractAuditDecision = "PASS" | "FIX_REQUIRED";

export type ContractAuditResult = {
  status: ContractAuditDecision;
  summary: string;
  findings: PostBuildAuditFinding[];
  finalOutput: string;
};

export type PostBuildAuditTrace = {
  enabled: boolean;
  sessionId?: string;
  status: PostBuildAuditStatus;
  fixCyclesUsed: number;
  findings: PostBuildAuditFinding[];
};

export type CouncilComparisonConfidence = "high" | "medium" | "low";

export type CouncilComparisonCommonGround = {
  topic: string;
  taskRequirement?: string;
  supportedBy: number[];
  confidence: CouncilComparisonConfidence;
  rationale: string;
};

export type CouncilComparisonPanelPosition = {
  panelIndex: number;
  position: string;
};

export type CouncilComparisonKeyDifference = {
  topic: string;
  taskRequirement?: string;
  panelPositions: CouncilComparisonPanelPosition[];
  resolutionRule: string;
  requiredDecision: string;
};

export type CouncilComparisonUniqueAdditionClassification =
  | "literal_requirement"
  | "safe_compatibility"
  | "optional_enhancement"
  | "scope_risk";

export type CouncilComparisonUniqueAddition = {
  idea: string;
  proposedBy: number;
  classification: CouncilComparisonUniqueAdditionClassification;
  recommendation: "adopt" | "defer" | "reject";
  reason: string;
};

export type CouncilComparisonPartialCoverage = {
  requirement: string;
  coveredBy: number[];
  requiredFollowUp: string;
};

export type CouncilComparisonBlindSpot = {
  risk: string;
  requiredTestOrAudit: string;
};

export type CouncilComparison = {
  commonGround: CouncilComparisonCommonGround[];
  keyDifferences: CouncilComparisonKeyDifference[];
  uniqueAdditions: CouncilComparisonUniqueAddition[];
  partialCoverage: CouncilComparisonPartialCoverage[];
  blindSpots: CouncilComparisonBlindSpot[];
  unresolvedDifferences: number;
  adoptedUniqueAdditions: number;
  deferredOrRejectedUniqueAdditions: number;
  degraded: boolean;
  notes: string[];
};

export type RequirementDecisionMatrixEntry = {
  requirement: string;
  chosenBehavior: string;
  whyCorrect: string;
  evidenceSource: string;
  requiredTest: string;
  riskIfOmitted: string;
  classification:
    | "mandatory_literal_requirement"
    | "safe_compatibility_addition"
    | "optional_enhancement"
    | "rejected_scope_expansion";
};

export type RequirementDecisionMatrix = {
  entries: RequirementDecisionMatrixEntry[];
  mandatoryCount: number;
  safeCompatibilityCount: number;
  optionalCount: number;
  rejectedCount: number;
};

export type CorrectnessCoverageCategoryStatus = "pass" | "fix_required" | "not_applicable";

export type CorrectnessCoverageCategory = {
  name: string;
  status: CorrectnessCoverageCategoryStatus;
  findings: string[];
};

export type CorrectnessCoverageGateStatus = "pass" | "fix_required" | "degraded" | "not_run";

export type CorrectnessCoverageGate = {
  status: CorrectnessCoverageGateStatus;
  categories: CorrectnessCoverageCategory[];
  degradedReason?: string;
  fixCyclesUsed: number;
  maxFixCycles: number;
};

export type ModelConfig = {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv: string;
  temperature?: number;
  maxTokens?: number;
};

export type FusionCouncilConfig = {
  defaults: {
    panelModels: string[];
    judgeModel: string;
    timeoutMs: number;
    maxPanelConcurrency: number;
    postBuildContractAudit: boolean;
    maxPostBuildAuditFixCycles: number;
  };
  models: Record<string, ModelConfig>;
};

export type ContextBundle = {
  summary: string;
  branch?: string;
  changedFiles?: string[];
  diff?: string;
  files: Array<{ path: string; content: string; truncated: boolean }>;
  omitted: string[];
};

export type PanelResponse = {
  modelId: string;
  provider: string;
  success: boolean;
  content?: string;
  error?: string;
  errorType?: ModelErrorType;
  attempts?: number;
  providerID?: string;
  modelID?: string;
  latencyMs: number;
  prompt?: string;
  repairAttempted?: boolean;
  candidateValidationPassed?: boolean;
  candidateValidationStatus?: CandidateValidationStatus;
  candidateValidationScore?: number;
  candidateValidationWarnings?: string[];
  candidateValidationMissingItems?: string[];
  sessionId?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortApplied?: ReasoningEffortApplication;
  rawModelSpec?: string;
};

export type FusionTracePanelEntry = {
  modelId: string;
  success: boolean;
  error?: string;
  errorType?: ModelErrorType;
  attempts?: number;
  providerID?: string;
  modelID?: string;
  elapsedMs?: number;
  outputCharCount?: number;
  candidateValidationPassed?: boolean;
  candidateValidationStatus?: CandidateValidationStatus;
  candidateValidationScore?: number;
  candidateValidationWarnings?: string[];
  repairAttempted?: boolean;
  sessionId?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortApplied?: ReasoningEffortApplication;
  rawModelSpec?: string;
};

export type FusionTraceQuorumFailedPanel = {
  modelId: string;
  errorType?: ModelErrorType;
  elapsedMs?: number;
  validationFailureReason?: string;
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  outputSnippet?: string;
};

export type FusionTraceQuorum = {
  required: number;
  usable: number;
  total: number;
  degraded: boolean;
  failedPanels: FusionTraceQuorumFailedPanel[];
};

export type NativePanelSession = {
  panelIndex: number;
  agentName: string;
  modelId: string;
  promptHash: string;
  nativeTask: true;
  sessionId?: string;
  taskId?: string;
  success?: boolean;
  validationStatus?: CandidateValidationStatus;
};

export type PanelAttemptStatus =
  | "queued"
  | "waiting_for_previous_output"
  | "waiting_for_activity"
  | "running"
  | "healthy"
  | "suspected_stalled"
  | "stalled"
  | "cancelled"
  | "retrying"
  | "succeeded"
  | "partial"
  | "failed";

export type PanelStartReason =
  | "initial_immediate"
  | "scheduled_delay"
  | "recovery_rerun"
  | "cascade_activity"
  | "start_gate_timeout"
  | "retry";

/**
 * Absolute launch reason for the fixed-delay panel stagger schedule.
 * Distinct from {@link PanelStartReason}, which is the legacy activity-cascade
 * vocabulary retained for backward-compatible attempt traces.
 */
export type PanelLaunchReason =
  | "initial_immediate"
  | "scheduled_delay"
  | "recovery_rerun";

export type CandidateClassification = "usable" | "partial" | "missing" | "invalid";

export type CandidateEvidenceVerificationStatus = "passed" | "failed" | "unknown";

export type CandidateFinalMessageFormat =
  | "structured"
  | "concise"
  | "missing"
  | "invalid";

export type CandidateEvidence = {
  workspaceExists: boolean;
  workspaceSafe: boolean;
  executionContextMatches: boolean;
  sharedPromptHashMatches: boolean;
  meaningfulChangedFiles: number;
  changedSourceFiles: number;
  changedTestFiles: number;
  changedConfigFiles: number;
  changedFiles: string[];
  verification: {
    typecheck?: CandidateEvidenceVerificationStatus;
    test?: CandidateEvidenceVerificationStatus;
    build?: CandidateEvidenceVerificationStatus;
  };
  candidateLocalReportPath?: string;
  sourceSideReportPath?: string;
  selectedReportPath?: string;
  priorTerminalStatus?: "succeeded" | "failed" | "unknown";
  finalMessageFormat: CandidateFinalMessageFormat;
  warnings: string[];
};

/**
 * Per-panel absolute launch schedule entry. `plannedDispatchAt` derives only
 * from the original launch clock (anchor + fixed delay), never from previous
 * panel activity, output, or completion.
 */
export type PanelLaunchSchedule = {
  panelIndex: 1 | 2 | 3;
  plannedDispatchAt: number;
  dispatchRequestedAt: number | null;
  dispatchAt: number | null;
  launchReason: PanelLaunchReason;
  scheduleSkewMs: number | null;
};

/** Hard orchestration violation codes surfaced in the trace, never hidden. */
export type OrchestrationViolationCode =
  | "MAIN_BASELINE_SERIALIZED_BEHIND_PANELS"
  | "NATIVE_DELAYED_TASK_DISPATCH_UNAVAILABLE";

export type PanelStallReason =
  | "inactivity_timeout"
  | "task_timeout"
  | "task_error"
  | "cancelled_by_orchestrator";

export type PanelCredibleActivitySource =
  | "assistant_output"
  | "reasoning_output"
  | "tool_call_start"
  | "tool_call_complete"
  | "tool_result"
  | "session_status"
  | "candidate_file_mutation"
  | "candidate_output_write"
  | "terminal_result";

export type PanelLivenessCapability = {
  streamActivityExposed: boolean;
  tokenLevelLiveness: boolean;
  startGateFallback: boolean;
  taskTimeoutSupported: boolean;
  pendingToolActivityInspectable: boolean;
};

export type PanelAttemptTrace = {
  logicalPanelIndex: number;
  attempt: number;
  nativeSessionId?: string;
  model: string;
  startedAt: string;
  workspacePreparedAt?: string;
  dispatchAt?: string;
  fallbackGateAt?: string;
  firstActivityAt?: string;
  firstActivitySource?: PanelCredibleActivitySource;
  lastActivityAt?: string;
  lastActivitySource?: PanelCredibleActivitySource;
  suspectedStalledAt?: string;
  cancellationRequestedAt?: string;
  cancelledAt?: string;
  retryScheduledAt?: string;
  retryStartedAt?: string;
  endedAt?: string;
  status: PanelAttemptStatus;
  startReason: PanelStartReason;
  stallReason?: PanelStallReason;
  excludedAt?: string;
  excludedReason?: string;
};

export type RuntimeCapabilityFlags = {
  visibleTaskDispatchVerified: boolean;
  childSessionStreamEvents: boolean;
  childReasoningDeltas: boolean;
  childToolLifecycleEvents: boolean;
  childSessionStatusInspection: boolean;
  cancellationAbortSupported: boolean;
  childTaskCwdOverride: boolean;
  childTaskWriteScopeEnforced: boolean;
  parentContinueWhileChildRuns: boolean;
  safeRedispatchSupported: boolean;
  visibleJudgeSupported: boolean;
  tracePersistenceSupported: boolean;
};

export type PanelExecutionStage = {
  panelIndex: number;
  agentName: string;
  modelId: string;
  startsAfter: "immediately" | "launch_clock" | "previous_first_activity" | "previous_start_gate_timeout";
  startGateTimeoutMs: number;
};

export type PanelExecutionPlan = {
  panelCount: number;
  startGateTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxAttemptsPerPanel: number;
  staggered: boolean;
  capability: PanelLivenessCapability;
  stages: PanelExecutionStage[];
};

export type FusionTrace = {
  requestedModelSource: ModelSource;
  actualModelSource: ModelRunner["source"];
  fallbackUsed: boolean;
  panelModelsRequested: FusionModelSpec[];
  judgeModelRequested: FusionModelSpec;
  panel: FusionTracePanelEntry[];
  judge: {
    modelId: string;
    success: boolean;
    error?: string;
    elapsedMs?: number;
    sessionId?: string;
    reasoningEffort?: ReasoningEffort;
    reasoningEffortApplied?: ReasoningEffortApplication;
    rawModelSpec?: string;
  };
  quorum?: FusionTraceQuorum;
};

export type FusionRunTrace = FusionTrace & {
  runId: string;
  timestamp: string;
  command?: string;
  commandName?: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
  modelSource: ModelSource;
  executionMode?: ExecutionMode;
  sharedPanelPromptPath?: string;
  sharedPanelPromptHash?: string;
  panelPromptTransport?: PromptTransportMetadata;
  judgePromptTransport?: PromptTransportMetadata;
  auditPromptTransport?: PromptTransportMetadata;
  panelSessions?: NativePanelSession[];
  panelAttempts?: PanelAttemptTrace[];
  panelLivenessCapability?: PanelLivenessCapability;
  runtimeCapabilities?: RuntimeCapabilityFlags;
  panelExecutionPlan?: PanelExecutionPlan;
  artifactDir?: string;
  artifactPaths?: {
    trace: string;
    originalPrompt: string;
    contractGate?: string;
    sharedPanelPrompt?: string;
    panel1Prompt?: string;
    panel1Output?: string;
    panel2Prompt?: string;
    panel2Output?: string;
    panel3Prompt?: string;
    panel3Output?: string;
    judgePrompt?: string;
    judgeOutput?: string;
    finalGuidance?: string;
    councilComparison?: string;
    requirementDecisionMatrix?: string;
    postBuildAuditPrompt?: string;
    postBuildAuditOutput?: string;
    correctnessCoverageGate?: string;
    sourceBaselineManifest?: string;
    sourceBaselineSummary?: string;
    mainBaselineManifest?: string;
    mainBaselinePatch?: string;
    mergePatchContractFull?: string;
    mergePatchContractBrief?: string;
  };
  contractGate?: ContractGateTraceSummary;
  councilComparison?: CouncilComparison;
  requirementDecisionMatrixSummary?: {
    entries: RequirementDecisionMatrixEntry[];
    mandatoryCount: number;
    safeCompatibilityCount: number;
    optionalCount: number;
    rejectedCount: number;
  };
  correctnessCoverageGate?: CorrectnessCoverageGate;
  candidateValidation?: {
    allPassed: boolean;
    perPanel: Array<{
      modelId: string;
      passed: boolean;
      status?: CandidateValidationStatus;
      score?: number;
      warnings?: string[];
      missingItems?: string[];
      repairAttempted?: boolean;
      repairSucceeded?: boolean;
    }>;
  };
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  panelOutputCompletenessScore?: number;
  judgeOutputSectionsDetected?: string[];
  finalGuidanceContainsHiddenTests?: boolean;
  finalGuidanceContainsPackageChecklist?: boolean;
  finalGuidanceContainsImmutabilityChecklist?: boolean;
  finalGuidanceContainsTypedErrorChecklist?: boolean;
  postBuildAudit?: PostBuildAuditTrace;
  speculative?: SpeculativeParallelBuildTrace;
  artifactFiles?: string[];
  errors?: string[];
};

export type FusionTraceOptions = {
  saveRunArtifacts?: boolean;
  keepPanelSessions?: boolean;
  traceDir?: string;
  verboseTrace?: boolean;
  command?: string;
};

export type PanelAssessment = {
  modelId: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

export type CouncilResult = {
  mode: CouncilMode;
  panelMode?: PanelMode;
  buildStrategy?: BuildStrategy;
  decision?: CouncilDecision;
  summary: string;
  consensus: string[];
  contradictions: string[];
  uniqueInsights: string[];
  risks: string[];
  missingConsiderations: string[];
  finalRecommendation: string;
  requirementChecklist: string[];
  safeCompatibilityAdditions?: string[];
  optionalNiceties?: string[];
  publicSurfaceMatrix?: string[];
  requiredExternalConsumerProbes?: string[];
  requiredHiddenSemanticProbes?: string[];
  implementationPriorities?: string[];
  packageEntryChecklist?: string[];
  buildReadyConsumerTestPlan?: string[];
  rejectedRiskyIdeas: string[];
  finalBuildGuidance: string;
  mustNotBreakConstraints: string[];
  requiredTests: string[];
  panelAssessments?: PanelAssessment[];
  implementationPlan?: string[];
  testPlan?: string[];
  recommendedBuildPrompt?: string;
  knownTraps?: string[];
  finalComplianceChecklist?: string[];
  councilComparison?: CouncilComparison;
  requirementDecisionMatrix?: RequirementDecisionMatrix;
  correctnessCoverageGate?: CorrectnessCoverageGate;
  finalOutput: string;
  panel: PanelResponse[];
  trace?: FusionRunTrace;
};

export type ModelGenerateOptions = {
  model?: ModelConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  sessionTitle?: string;
  keepSession?: boolean;
  onSessionCreated?: (sessionId: string) => void;
  reasoningEffort?: ReasoningEffort;
};

export type ModelClient = {
  generate(prompt: string, options: ModelGenerateOptions): Promise<string>;
};

export type ModelRunner = {
  source: "opencode" | "direct" | "test";
  generate(modelId: string, prompt: string, options: ModelGenerateOptions): Promise<string>;
};

export type CouncilRunInput = {
  task: string;
  mode: CouncilMode;
  files?: string[];
  includeDiff?: boolean;
  panelModels?: string[];
  judgeModel?: string;
  panelModelSpecs?: FusionModelSpec[];
  judgeModelSpec?: FusionModelSpec;
  modelSource?: ModelSource;
  panelMode?: PanelMode;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
  promptVerbosity?: PromptVerbosity;
  panelTimeoutMs?: number;
  judgeTimeoutMs?: number;
  panelMaxAttempts?: number;
  repairMaxAttempts?: number;
  repairTimeoutMs?: number;
  context?: ContextBundle;
  trace?: FusionTraceOptions;
};

export type CouncilRunOptions = {
  config?: FusionCouncilConfig;
  cwd?: string;
  noContext?: boolean;
  modelSource?: ModelSource;
  modelRunner?: ModelRunner;
  opencodeRunner?: ModelRunner;
  modelClientFactory?: (modelId: string, model: ModelConfig) => ModelClient;
  trace?: FusionTraceOptions;
};

export type NativePanelAgentPlan = {
  panelIndex: number;
  agentName: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  promptHash: string;
  nativeTask: true;
  /**
   * Speculative-mode dynamic execution binding. Each panel receives its OWN
   * resolved execution-context file and inline dispatch prompt. The shared task
   * file is byte-identical across panels; the per-panel binding carries the
   * resolved candidate workspace, prohibited source workspace, and output paths.
   * Undefined for advisory / non-speculative runs.
   */
  executionContextPath?: string;
  executionContextHash?: string;
  candidateWorkspacePath?: string;
  sourceWorkspacePath?: string;
  panelReportPath?: string;
  panelNotesPath?: string;
  sharedTaskPath?: string;
  /**
   * Short (<=50 line) per-panel inline prompt the orchestrator sends as the
   * panel Task `prompt`. It requires the panel to read the execution-context
   * file first, then the shared canonical task until EOF. Distinct per panel.
   */
  inlineDispatchPrompt?: string;
};

/**
 * Per-panel execution assignment trace for speculative_parallel_build runs.
 * Proves each panel was bound to its OWN fully resolved candidate workspace and
 * that no unresolved placeholder reached the dispatch. `nativeCwdScoped` is
 * always false (OpenCode does not path-scope per-task CWD/write permissions);
 * panels operate in absolute-path mode instead.
 */
export type PanelExecutionAssignmentTrace = {
  logicalPanelIndex: number;
  sharedTaskPath: string;
  executionContextPath: string;
  assignedCandidateWorkspace: string;
  prohibitedSourceWorkspace: string;
  panelOutputPath: string;
  sharedTaskHash: string;
  executionContextHash: string;
  unresolvedPlaceholderCheck: "passed" | "failed";
  nativeCwdScoped: false;
  absolutePathModeRequired: boolean;
  /** Runtime identity marker so stale plugin/agent templates are detectable. */
  resolverVersion: "external_staging_v1";
  runtimeModulePath?: string;
};

export type NativeJudgeAgentPlan = {
  agentName: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
};

export type NativePanelResult = {
  agentName: string;
  modelId: string;
  content?: string;
  error?: string;
  errorType?: ModelErrorType;
  taskId?: string;
  sessionId?: string;
};

export type NativePanelDispatchEvent = {
  logicalPanelIndex: number;
  startReason: PanelStartReason;
  startedAt?: string;
  taskId?: string;
  sessionId?: string;
};

export type NativePanelObservation = {
  logicalPanelIndex: number;
  source: PanelCredibleActivitySource;
  observedAt?: string;
};

export type NativeJudgeDispatchEvent = {
  startedAt?: string;
  taskId?: string;
  sessionId?: string;
};

export type NativePrepareInput = {
  task: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
  buildStrategy?: BuildStrategy;
  /**
   * Optional explicit run id. When omitted a timestamped id is generated.
   * Provided primarily for deterministic integration tests of the real
   * `fusion_native.prepare` entrypoint.
   */
  runId?: string;
  files?: string[];
  includeDiff?: boolean;
  promptVerbosity?: PromptVerbosity;
  command?: string;
  panelModels?: string[];
  judgeModel?: string;
  modelSource?: ModelSource;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
  parallelExecutionSupported?: boolean;
  trace?: FusionTraceOptions;
};

export type NativeTodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: "high" | "medium" | "low";
};

export type NativePrepareResult = {
  executionMode: "native_subagents";
  runId: string;
  artifactDir: string;
  /** Canonical trace artifact directory (<traceRoot>/<runId>). Same as artifactDir. */
  traceArtifactDir: string;
  /** Absolute path to run-state.json for this run. */
  runStatePath: string;
  sharedPanelPrompt?: string;
  sharedPanelPromptHash?: string;
  sharedPanelPromptPath?: string;
  panelTransportPrompt?: string;
  panelPromptTransport?: PromptTransportMetadata;
  panelAgents: NativePanelAgentPlan[];
  panelExecutionPlan: PanelExecutionPlan;
  judgeAgent: NativeJudgeAgentPlan;
  todoPlan: NativeTodoItem[];
  mode: CouncilMode;
  panelMode?: PanelMode;
  buildStrategy?: BuildStrategy;
  task: string;
  canonicalTaskPath?: string;
  canonicalTaskHash?: string;
  speculative?: SpeculativePrepareResult;
  /**
   * Identity of the actually loaded module/build that produced this result.
   * Lets `/fusion-build` and `/fusion-trace` prove OpenCode is running the
   * current implementation rather than a stale plugin copy.
   */
  runtimeIdentity: RuntimeIdentity;
};

/**
 * Canonical speculative path-resolution record. Produced only by the external
 * staging resolver (`buildSpeculativeWorkspacePaths` +
 * `buildSpeculativePathResolutionTrace`). No runtime path may derive candidate
 * workspaces from `sourceArtifactDir/speculative` or `runDir/speculative`.
 */
export type SpeculativePathResolutionTrace = {
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalCandidateStagingDir: string;
  mainWorkspacePath?: string;
  panelWorkspacePaths: string[];
  resolverVersion: "external_staging_v1";
  runtimeModulePath?: string;
};

/**
 * Runtime build/module identity marker. Surfaced in prepare results and the
 * speculative trace to verify which loaded artifact is executing.
 */
export type RuntimeIdentity = {
  modulePath: string;
  resolverVersion: "external_staging_v1";
  executionMode: "native_subagents";
};

export type SpeculativePrepareResult = {
  buildStrategy: "speculative_parallel_build";
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalCandidateStagingDir: string;
  sourceBaselineManifestPath: string;
  sourceBaselineSummaryPath: string;
  candidateWorkspaces: CandidateWorkspaceInfo[];
  isolationCapability: IsolationCapability;
  parallelExecutionSupported: boolean;
  parallelCapabilityLimitation?: string;
  preflightDiagnostic?: string;
  aborted: boolean;
  abortReason?: string;
  preparedAt?: string;
  /** When the run launch was first requested (minimal bootstrap entry). */
  runLaunchRequestedAt?: string;
  candidatePreparationCompletedAt?: string;
  judgeEligibleAt?: string;
  launchClockAnchorMs?: number;
  panelLaunchSchedule?: PanelLaunchSchedule[];
  judgeManifestPath?: string;
  activeSchedulerCapability?: "persisted_due_times_parent_turn_required" | "persisted_due_times_visible_dispatch";
  /** Canonical external-staging path resolution record. */
  pathResolution: SpeculativePathResolutionTrace;
  /** Absolute path of the shared, workspace-agnostic canonical task file. */
  sharedTaskPath?: string;
  /** Per-panel resolved execution assignments (one per logical panel). */
  panelExecutionAssignments?: PanelExecutionAssignmentTrace[];
};

export type NativeRecordMainBaselineInput = {
  runId: string;
  mainBaseline: MainBaselineTrace;
};

export type NativeRecordMainBaselineResult = {
  runId: string;
  recorded: boolean;
  mainBaseline: MainBaselineTrace;
  mainBaselineManifestPath?: string;
  mainBaselinePatchPath?: string;
};

export type NativeAuditPrepareResult = {
  runId: string;
  enabled: boolean;
  reason: string;
  artifactDir: string;
  auditAgent: NativeJudgeAgentPlan;
  auditPrompt: string;
  auditTransportPrompt: string;
  auditPromptTransport?: PromptTransportMetadata;
  fixCyclesUsed: number;
  maxFixCycles: number;
};

export type NativeCollectInput = {
  runId: string;
  panelResults?: NativePanelResult[];
  panelAttempts?: PanelAttemptTrace[];
  mainBaseline?: MainBaselineTrace;
};

export type NativeCollectResult = {
  runId: string;
  shouldProceed: boolean;
  reason: string;
  quorum: FusionTraceQuorum;
  judgePrompt: string;
  judgeTransportPrompt: string;
  judgePromptTransport?: PromptTransportMetadata;
  judgeAgent: NativeJudgeAgentPlan;
  panelStatus: Array<{
    agentName: string;
    modelId: string;
    success: boolean;
    validationStatus?: CandidateValidationStatus;
    error?: string;
    errorType?: ModelErrorType;
  }>;
  panelAttempts?: PanelAttemptTrace[];
  panelLivenessCapability?: PanelLivenessCapability;
  degraded: boolean;
  todoUpdates: NativeTodoItem[];
  councilComparison?: CouncilComparison;
  councilComparisonMarkdown?: string;
  speculative?: SpeculativeCollectResult;
};

export type SpeculativeCollectResult = {
  buildStrategy: "speculative_parallel_build";
  mainBaseline: MainBaselineTrace;
  candidateWorkspaces: CandidateWorkspaceInfo[];
  panelCandidateTrace: SpeculativePanelCandidateTrace[];
  overlapObserved: boolean;
  overlapDurationMs?: number;
  judgeEligibleAt?: string;
  frozenPanelIndexes?: number[];
  lateExcludedPanelIndexes?: number[];
  mergePatchContractPrompt: string;
};

export type NativeAdvanceInput = {
  runId: string;
  /** Authorizes the main baseline (parent permitted to begin implementation). */
  mainBaselineStartedAt?: string;
  /**
   * First real parent/main workspace operation. Must reflect an actual
   * workspace change or intentional implementation inspection — never a
   * fabricated marker recorded before real work begins.
   */
  mainBaselineFirstWorkAt?: string;
  panelDispatches?: NativePanelDispatchEvent[];
  panelResults?: NativePanelResult[];
  panelObservations?: NativePanelObservation[];
  judgeDispatched?: NativeJudgeDispatchEvent;
};

export type NativeAdvanceAction =
  | {
    type: "start_panel";
    logicalPanelIndex: number;
    attempt: number;
    startReason: PanelStartReason;
    /** Absolute launch reason for the fixed-delay stagger schedule. */
    launchReason?: PanelLaunchReason;
    /** Persisted absolute planned dispatch time (ms epoch), if scheduled. */
    plannedDispatchAt?: number;
    agentName: string;
    modelId: string;
    prompt: string;
    candidateWorkspacePath?: string;
    fallbackGateAt?: string;
  }
  | {
    type: "call_collect";
    reason: string;
    judgeEligibleAt: string;
  }
  | {
    type: "wait";
    deadline: string;
    delayMs: number;
    reason: "start_gate" | "inactivity" | "all_running";
  }
  | {
    type: "done";
    reason: string;
  };

export type NativeAdvanceResult = {
  runId: string;
  phase: "preparing_panels" | "panel_execution" | "ready_to_collect" | "judge_running" | "done";
  nextAction: NativeAdvanceAction;
  panelAttempts: PanelAttemptTrace[];
  panelResults: NativePanelResult[];
  judgeEligible: boolean;
  judgeEligibleAt?: string;
  panelLivenessCapability: PanelLivenessCapability;
  runtimeCapabilities?: RuntimeCapabilityFlags;
  todoUpdates: NativeTodoItem[];
  speculative?: SpeculativePrepareResult;
};

export type RecoveryMetadata = {
  recovered: true;
  recoveredFromRunId: string | null;
  orphanSourceArtifactRoot: string;
  originalSharedPromptHash: string;
  recoveryStartedAt: string;
  mainBaselineReused: boolean;
  recoveredPanelIndexes: number[];
  partialPanelIndexes: number[];
  invalidPanelIndexes: number[];
  rerunPanelIndexes: number[];
};

export type RecoveredPanelCandidate = {
  logicalPanelIndex: number;
  model?: string;
  agentName?: string;
  classification: CandidateClassification;
  evidence: CandidateEvidence;
  evidenceSourcesChecked: string[];
  workspacePath?: string;
  reportPath?: string;
  sourceSideReportPath?: string;
  diffPath?: string;
  changedFileCount?: number;
  verification?: VerificationSummary;
  rerunEligible: boolean;
  rerunReason?: string;
  /** Best report content selected for collect/judge when recovered. Not persisted in classification JSON. */
  reportContent?: string;
};

export type RecoveryCandidateClassificationTrace = {
  recoveredCandidates: RecoveredPanelCandidate[];
  redispatchPlan: Array<{
    logicalPanelIndex: number;
    allowed: boolean;
    reason?: string;
  }>;
  reusedPanelIndexes: number[];
  partialPanelIndexes: number[];
  rerunPanelIndexes: number[];
};

export type NativeResumeInput = {
  runId?: string;
  trace?: FusionTraceOptions;
  panelModels?: string[];
  judgeModel?: string;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
};

export type NativeResumeResult = {
  executionMode: "native_subagents";
  runId: string;
  artifactDir: string;
  traceArtifactDir: string;
  runStatePath: string;
  recovery: RecoveryMetadata;
  classification: RecoveryCandidateClassificationTrace;
  recoveryClassificationPath: string;
  recoveryPanelPlanPath: string;
  recoverySummaryMarkdown: string;
  sharedPanelPromptHash: string;
  mainBaseline: MainBaselineTrace;
  judgeEligible: boolean;
  quorum: FusionTraceQuorum;
  recoveredPanelResults: NativePanelResult[];
  panelsToRerun: NativePanelAgentPlan[];
  panelAgents: NativePanelAgentPlan[];
  panelExecutionPlan: PanelExecutionPlan;
  judgeAgent: NativeJudgeAgentPlan;
  todoPlan: NativeTodoItem[];
  speculative: SpeculativePrepareResult;
  runtimeIdentity: RuntimeIdentity;
};

export type NativeFinalizeInput = {
  runId: string;
  judgeOutput?: string;
  judgeError?: string;
  judgeTaskId?: string;
  judgeSessionId?: string;
};

export type NativeFinalizeResult = {
  runId: string;
  executionMode: "native_subagents";
  success: boolean;
  error?: string;
  artifactDir: string;
  artifactPaths?: FusionRunTrace["artifactPaths"];
  councilResult: CouncilResult;
  finalGuidance: string;
  trace: FusionRunTrace;
  traceSummary: string;
  speculative?: SpeculativeFinalizeResult;
};

export type SpeculativeFinalizeResult = {
  buildStrategy: "speculative_parallel_build";
  mergePatchContractPath?: string;
  mergePatchDecision?: MergePatchDecision;
  mergePatchContract?: MergePatchContract;
  appliedPatchItems?: AppliedPatchItem[];
};

export type NativeAuditFinalizeInput = {
  runId: string;
  auditOutput?: string;
  auditError?: string;
  auditTaskId?: string;
  auditSessionId?: string;
  appliedPatchItems?: AppliedPatchItem[];
};

export type NativeAuditFinalizeResult = {
  runId: string;
  success: boolean;
  artifactDir: string;
  trace: FusionRunTrace;
  traceSummary: string;
  status: ContractAuditDecision;
  findings: PostBuildAuditFinding[];
  fixCyclesUsed: number;
  maxFixCycles: number;
  autoFixAllowed: boolean;
  finalOutput: string;
  error?: string;
  correctnessCoverageGate?: CorrectnessCoverageGate;
};

// ---------------------------------------------------------------------------
// Speculative parallel build (`/fusion-build` internal mode)
//
// The user-facing command is `/fusion-build`. Internally the workflow runs as
// `speculative_parallel_build`: panels build competing candidates in isolated
// candidate workspaces while the main agent independently builds a baseline in
// the real workspace. A visible native `fusion-judge` then compares real main
// workspace evidence against panel candidates and produces a Merge Patch
// Contract. The main agent applies only approved targeted patches.
// ---------------------------------------------------------------------------

export type VerificationSummary = {
  typecheck?: "pass" | "fail" | "not_run";
  test?: "pass" | "fail" | "not_run";
  build?: "pass" | "fail" | "not_run";
  commandsRun?: string[];
  notes?: string[];
};

export type MainBaselineTrace = {
  startedAt?: string;
  completedAt?: string;
  /**
   * When the parent/main agent was authorized to begin real implementation
   * (immediately after minimal bootstrap). Authorization is not work.
   */
  startAuthorizedAt?: string;
  /**
   * First actual parent/main workspace operation that changes or intentionally
   * inspects implementation state. Never fabricated; only set from a real
   * reported first-work marker.
   */
  firstWorkAt?: string;
  /** When the main baseline reached a terminal (passed/failed/blocked) state. */
  terminalAt?: string;
  status: "queued" | "running" | "passed" | "failed" | "blocked";
  workspacePath: string;
  changedFiles: string[];
  manifestPath?: string;
  patchPath?: string;
  verification?: VerificationSummary;
};

export type IsolationCapability = {
  nativeCwdScoped: boolean;
  writeBoundaryScoped: boolean;
  hardLinkSafe: boolean;
  symlinkSafe: boolean;
  verified: boolean;
  limitation?: string;
};

export type CandidateWorkspaceInfo = {
  logicalPanelIndex: number;
  workspacePath: string;
  manifestPath: string;
  /** Source-side collected report path (where the judge reads the report). */
  reportPath: string;
  patchPath: string;
  gitInitialized: boolean;
  /** Candidate-local panel output directory: `<workspace>/.fusion-panel-output`. */
  candidateOutputDir: string;
  /** Candidate-local report path the panel writes to (collected source-side later). */
  candidateReportPath: string;
  /** Candidate-local optional notes path. */
  candidateNotesPath: string;
};

export type SpeculativePanelCandidateTrace = {
  logicalPanelIndex: number;
  model: string;
  workspacePath: string;
  reportPath?: string;
  patchPath?: string;
  status: "queued" | "running" | "usable" | "partial" | "failed" | "excluded";
  classification: CandidateClassification;
  evidence: CandidateEvidence;
  warnings: string[];
  verification?: VerificationSummary;
};

export type MergePatchSeverity = "BLOCKER" | "MUST_FIX" | "SAFE_ADDITION" | "REJECTED";

export type MergePatchDecision =
  | "PATCH_REQUIRED"
  | "NO_PATCH_REQUIRED"
  | "MAIN_BUILD_BLOCKED";

export type AppliedPatchItem = {
  severity: "BLOCKER" | "MUST_FIX" | "SAFE_ADDITION";
  title: string;
  status: "applied" | "skipped" | "failed";
};

export type MergePatchGap = {
  severity: MergePatchSeverity;
  literalRequirement: string;
  observedMainBehavior: string;
  evidence: string;
  relevantPanelEvidence?: string;
  failureScenario?: string;
  requiredCorrection: string;
  requiredRegressionTest?: string;
};

export type MergePatchAdoptedInsight = {
  sourcePanels: number[];
  idea: string;
  whyCorrect: string;
  whyFitsMainArchitecture: string;
  implementationDirection: string;
  requiredTest?: string;
};

export type MergePatchRejectedIdea = {
  sourcePanel: number;
  idea: string;
  reason: string;
};

export type MergePatchPlanItem = {
  filePath: string;
  symbol?: string;
  requiredChange: string;
  requiredRegressionTest?: string;
  risk?: string;
};

export type MergePatchContract = {
  mainBaselineStatus: string;
  mainBaselineKeyPaths: string[];
  mainBaselineBlockers: string[];
  panelCandidateStatus: Array<{
    panelIndex: number;
    status: "usable" | "partial" | "failed" | "excluded";
    verificationEvidence?: string;
  }>;
  gaps: MergePatchGap[];
  mainStrengthsToPreserve: string[];
  adoptedInsights: MergePatchAdoptedInsight[];
  rejectedIdeas: MergePatchRejectedIdea[];
  patchPlan: MergePatchPlanItem[];
  finalDecision?: MergePatchDecision;
};

export type SpeculativeParallelBuildTrace = {
  mode: "speculative_parallel_build";
  sourceWorkspace: string;
  sourceArtifactDir: string;
  externalCandidateStagingDir: string;
  sourceBaselineManifestPath: string;
  parallelExecutionSupported: boolean;
  overlapObserved: boolean;
  overlapDurationMs?: number;
  parallelCapabilityLimitation?: string;
  runtimeCapabilities?: RuntimeCapabilityFlags;
  isolationCapability: IsolationCapability;
  pathResolution?: SpeculativePathResolutionTrace;
  launchClockAnchorMs?: number;
  panelLaunchSchedule?: PanelLaunchSchedule[];
  activeSchedulerCapability?: "persisted_due_times_parent_turn_required" | "persisted_due_times_visible_dispatch";
  /** Per-panel resolved execution assignments (dynamic dispatch binding). */
  panelExecutionAssignments?: PanelExecutionAssignmentTrace[];
  mainBaseline: MainBaselineTrace;
  panelCandidates: SpeculativePanelCandidateTrace[];
  judgeManifestPath?: string;
  judgeEligibleAt?: string;
  judgeDispatchAt?: string;
  judgeStartedAt?: string;
  judgeCompletedAt?: string;
  judgeFirstCredibleActivityAt?: string;
  judgeLastCredibleActivityAt?: string;
  judgeSuspectedStalledAt?: string;
  judgeTerminalAt?: string;
  judgeAttempt?: number;
  judgeRetryScheduledAt?: string;
  judgeDispatched?: boolean;
  judgeTerminal?: boolean;
  judgeContractValid?: boolean;
  judgeDecisionStatus?: MergePatchDecision | "JUDGE_NOT_DISPATCHED_NO_QUORUM" | "JUDGE_DISPATCHED_CONTRACT_INVALID" | "JUDGE_PENDING";
  frozenPanelIndexes?: number[];
  lateExcludedPanelIndexes?: number[];
  mergePatchContractPath?: string;
  mergePatchDecision?: MergePatchDecision;
  appliedPatchItems?: AppliedPatchItem[];
};
