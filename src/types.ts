import type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type ProviderKind = "openai-compatible" | "anthropic" | "google";

export type { FusionModelSpec, ReasoningEffort, ReasoningEffortApplication } from "./modelSpec.js";

export type CouncilMode = "plan" | "review" | "decision" | "build_prompt" | "architecture";

export type PanelMode = "advisory" | "candidate_build";

export type PromptVerbosity = "compact" | "standard" | "detailed";

export type CouncilDecision = "implement" | "do_not_implement" | "needs_more_info" | "use_caution";

export type ModelSource = "auto" | "opencode" | "direct";

export type ModelErrorType = "timeout" | "empty_response" | "provider_error" | "rate_limit" | "model_not_found" | "validation" | "unknown";

export type CandidateValidationStatus = "passed" | "usable_with_warnings" | "failed";

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
  artifactDir?: string;
  artifactPaths?: {
    trace: string;
    originalPrompt: string;
    panel1Prompt?: string;
    panel1Output?: string;
    panel2Prompt?: string;
    panel2Output?: string;
    panel3Prompt?: string;
    panel3Output?: string;
    judgePrompt?: string;
    judgeOutput?: string;
    finalGuidance?: string;
  };
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
