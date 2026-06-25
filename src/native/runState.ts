import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BuildStrategy,
  CandidateWorkspaceInfo,
  ContractGate,
  ContextBundle,
  CouncilComparison,
  CouncilResult,
  CouncilMode,
  CorrectnessCoverageGate,
  FusionModelSpec,
  IsolationCapability,
  MainBaselineTrace,
  MergePatchContract,
  PanelAttemptTrace,
  PanelExecutionPlan,
  PanelLivenessCapability,
  PostBuildAuditTrace,
  RuntimeCapabilityFlags,
  FusionTraceOptions,
  NativePanelAgentPlan,
  NativePanelResult,
  NativeJudgeAgentPlan,
  PanelMode,
  PromptTransportMetadata,
  PromptVerbosity,
  RequirementDecisionMatrix,
  SpeculativePanelCandidateTrace,
  SpeculativePathResolutionTrace,
} from "../types.js";
import { resolveTraceRoot } from "../trace/runTrace.js";
import { assertValidFusionRunId } from "./runLocator.js";

export const FUSION_RUN_STATE_LIFECYCLE_VERSION = 2;

export type RunState = {
  lifecycleVersion: number;
  runId: string;
  timestamp: string;
  /** Absolute path of the real user workspace that owns this run. */
  sourceWorkspace: string;
  command?: string;
  requestedFiles?: string[];
  includeDiff?: boolean;
  task: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
  buildStrategy?: BuildStrategy;
  context: ContextBundle;
  contractGate: ContractGate;
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  sharedPanelPrompt: string;
  sharedPanelPromptHash: string;
  sharedPanelPromptPath: string;
  panelTransportPrompt?: string;
  panelPromptTransport?: PromptTransportMetadata;
  panelAgents: NativePanelAgentPlan[];
  panelExecutionPlan?: PanelExecutionPlan;
  judgeAgent: NativeJudgeAgentPlan;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
  promptVerbosity?: PromptVerbosity;
  traceOptions: FusionTraceOptions;
  postBuildContractAudit: boolean;
  maxPostBuildAuditFixCycles: number;
  panelResults?: NativePanelResult[];
  panelResponses?: import("../types.js").PanelResponse[];
  panelAttempts?: PanelAttemptTrace[];
  panelLivenessCapability?: PanelLivenessCapability;
  runtimeCapabilities?: RuntimeCapabilityFlags;
  quorum?: import("../types.js").FusionTraceQuorum;
  judgePrompt?: string;
  judgeTransportPrompt?: string;
  judgePromptTransport?: PromptTransportMetadata;
  judgeOutput?: string;
  judgeError?: string;
  finalGuidance?: string;
  councilResult?: CouncilResult;
  councilComparison?: CouncilComparison;
  councilComparisonMarkdown?: string;
  requirementDecisionMatrix?: RequirementDecisionMatrix;
  correctnessCoverageGate?: CorrectnessCoverageGate;
  postBuildAuditPrompt?: string;
  postBuildAuditTransportPrompt?: string;
  auditPromptTransport?: PromptTransportMetadata;
  postBuildAuditOutput?: string;
  postBuildAudit?: PostBuildAuditTrace;
  // Speculative parallel build state
  speculative?: SpeculativeRunState;
  recovery?: import("../types.js").RecoveryMetadata;
};

export type SpeculativeRunState = {
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
  candidatePreparationCompletedAt?: string;
  // --- Real concurrent launch contract (absolute stagger schedule) ---
  /** When the run launch was first requested (minimal bootstrap entry). */
  runLaunchRequestedAt?: string;
  /** Bounded synchronous source snapshot capture, traced separately. */
  sourceSnapshotStartedAt?: string;
  sourceSnapshotCompletedAt?: string;
  sourceSnapshotDurationMs?: number;
  /** Original launch clock anchor (ms epoch) for the fixed-delay schedule. */
  launchClockAnchorMs?: number;
  /** Persisted absolute per-panel launch schedule. */
  panelLaunchSchedule?: import("../types.js").PanelLaunchSchedule[];
  /** Hard orchestration violations; surfaced, never hidden. */
  orchestrationViolations?: import("../types.js").OrchestrationViolationCode[];
  // --- Judge liveness / incremental preflight ---
  judgeManifestPath?: string;
  judgeDispatchAt?: string;
  judgeFirstCredibleActivityAt?: string;
  judgeLastCredibleActivityAt?: string;
  judgeSuspectedStalledAt?: string;
  judgeTerminalAt?: string;
  judgeAttempt?: number;
  judgeRetryScheduledAt?: string;
  pathResolution?: SpeculativePathResolutionTrace;
  sharedTaskPath?: string;
  panelExecutionAssignments?: import("../types.js").PanelExecutionAssignmentTrace[];
  mainBaseline?: MainBaselineTrace;
  mainBaselineManifestPath?: string;
  mainBaselinePatchPath?: string;
  panelCandidateTrace?: SpeculativePanelCandidateTrace[];
  overlapObserved?: boolean;
  overlapDurationMs?: number;
  judgeEligibleAt?: string;
  judgeStartedAt?: string;
  judgeCompletedAt?: string;
  frozenPanelIndexes?: number[];
  lateExcludedPanelIndexes?: number[];
  mergePatchContractPath?: string;
  mergePatchContractFullArtifactPath?: string;
  mergePatchContractBriefArtifactPath?: string;
  mergePatchDecision?: import("../types.js").MergePatchDecision;
  mergePatchContract?: MergePatchContract;
  appliedPatchItems?: import("../types.js").AppliedPatchItem[];
};

export function hashSharedPanelPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function runStatePath(cwd: string, runId: string, traceDir?: string): string {
  assertValidFusionRunId(runId);
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "run-state.json");
}

export function sharedPromptArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "shared-panel-prompt.md");
}

export async function writeRunState(state: RunState, cwd: string, traceDir?: string): Promise<string> {
  const filePath = runStatePath(cwd, state.runId, traceDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

export async function loadRunState(cwd: string, runId: string, traceDir?: string): Promise<RunState> {
  const filePath = runStatePath(cwd, runId, traceDir);
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as RunState;
}

export async function writeSharedPromptArtifact(prompt: string, cwd: string, runId: string, traceDir?: string): Promise<string> {
  const filePath = sharedPromptArtifactPath(cwd, runId, traceDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, prompt, "utf8");
  return filePath;
}

export function councilComparisonArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "council-comparison.md");
}

export function requirementDecisionMatrixArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "requirement-decision-matrix.md");
}

export function correctnessCoverageGateArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "correctness-coverage-gate.md");
}

export function sourceArtifactDirPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId);
}

export function panelExecutionContextArtifactPath(
  cwd: string,
  runId: string,
  logicalPanelIndex: number,
  traceDir?: string,
): string {
  return path.join(
    resolveTraceRoot(cwd, traceDir),
    runId,
    `panel-${logicalPanelIndex}-execution-context.full.md`,
  );
}

export function mainBaselineManifestArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "main-baseline-manifest.json");
}

export function mainBaselinePatchArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "main-baseline.patch");
}

export function mergePatchContractArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "merge-patch-contract.full.md");
}

export function judgeManifestArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "judge-preflight-manifest.json");
}

export async function writeArtifactFile(filePath: string, content: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}
