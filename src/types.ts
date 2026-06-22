import type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type ProviderKind = "openai-compatible" | "anthropic" | "google";

export type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type CouncilMode = "plan" | "review" | "decision" | "build_prompt" | "architecture";

export type PanelMode = "advisory" | "candidate_build";

export type PromptVerbosity = "compact" | "standard" | "detailed";

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
  panelSessions?: NativePanelSession[];
  artifactDir?: string;
  artifactPaths?: {
    trace: string;
    originalPrompt: string;
    contractGate?: string;
    panel1Prompt?: string;
    panel1Output?: string;
    panel2Prompt?: string;
    panel2Output?: string;
    panel3Prompt?: string;
    panel3Output?: string;
    judgePrompt?: string;
    judgeOutput?: string;
    finalGuidance?: string;
    postBuildAuditPrompt?: string;
    postBuildAuditOutput?: string;
  };
  contractGate?: ContractGateTraceSummary;
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

export type NativePrepareInput = {
  task: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
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
  sharedPanelPrompt: string;
  sharedPanelPromptHash: string;
  sharedPanelPromptPath: string;
  panelAgents: NativePanelAgentPlan[];
  judgeAgent: NativeJudgeAgentPlan;
  todoPlan: NativeTodoItem[];
  mode: CouncilMode;
  panelMode?: PanelMode;
  task: string;
};

export type NativeAuditPrepareResult = {
  runId: string;
  enabled: boolean;
  reason: string;
  artifactDir: string;
  auditAgent: NativeJudgeAgentPlan;
  auditPrompt: string;
  fixCyclesUsed: number;
  maxFixCycles: number;
};

export type NativeCollectResult = {
  runId: string;
  shouldProceed: boolean;
  reason: string;
  quorum: FusionTraceQuorum;
  judgePrompt: string;
  judgeAgent: NativeJudgeAgentPlan;
  panelStatus: Array<{
    agentName: string;
    modelId: string;
    success: boolean;
    validationStatus?: CandidateValidationStatus;
    error?: string;
    errorType?: ModelErrorType;
  }>;
  degraded: boolean;
  todoUpdates: NativeTodoItem[];
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
};

export type NativeAuditFinalizeInput = {
  runId: string;
  auditOutput?: string;
  auditError?: string;
  auditTaskId?: string;
  auditSessionId?: string;
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
};
