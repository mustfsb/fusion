import { collectContext } from "../context/collectContext.js";
import { getDefaultFusionConfig } from "../config.js";
import { getReasoningEffortApplication } from "../modelSpec.js";
import { resolveModels } from "../modelConfig.js";
import { providerLabelForModel } from "../runners/modelRunner.js";
import { extractContractGate, summarizeContractGate } from "../council/contractGate.js";
import { buildCouncilComparison, renderCouncilComparisonMarkdown } from "../council/councilComparison.js";
import {
  buildCorrectnessCoverageGate,
  parseRequirementDecisionMatrixFromJudgeOutput,
  renderCorrectnessCoverageGateMarkdown,
} from "../council/correctnessCoverageGate.js";
import { buildPanelPrompt, buildPostBuildAuditPrompt } from "../council/prompts.js";
import {
  parseFullPromptUnavailable,
  preparePromptTransport,
} from "../council/promptTransport.js";
import { parseContractAuditResponse, parseJudgeResponse } from "../council/judge.js";
import { validateCandidateOutput } from "../council/candidateValidation.js";
import {
  buildQuorum,
  quorumMeetsRequirement,
} from "../council/runCouncil.js";
import {
  buildEnhancedFinalGuidance,
  buildJudgePromptText,
  createRunId,
  enrichTraceMetadata,
  formatLatestTraceSummary,
  writeRunArtifacts,
  resolveTraceRoot,
} from "../trace/runTrace.js";
import {
  councilComparisonArtifactPath,
  correctnessCoverageGateArtifactPath,
  FUSION_RUN_STATE_LIFECYCLE_VERSION,
  hashSharedPanelPrompt,
  loadRunState,
  mainBaselineManifestArtifactPath,
  mainBaselinePatchArtifactPath,
  mergePatchContractArtifactPath,
  panelExecutionContextArtifactPath,
  requirementDecisionMatrixArtifactPath,
  runStatePath,
  sharedPromptArtifactPath,
  sourceArtifactDirPath,
  writeArtifactFile,
  writeRunState,
  writeSharedPromptArtifact,
  type RunState,
} from "./runState.js";
import { FUSION_AGENT_NAMES, FUSION_PANEL_AGENT_NAMES, PANEL_PROMPT } from "./agentTemplates.js";
import { assertNoUnresolvedPlaceholders } from "./placeholderGuard.js";
import {
  PANEL_INACTIVITY_TIMEOUT_MS,
  PANEL_START_GATE_TIMEOUT_MS,
  PANEL_START_GATE_FALLBACK_TIMEOUT_MS,
  MAX_PANEL_ATTEMPTS,
  PANEL_LIVENESS_CAPABILITY,
  PanelScheduler,
  buildPanelExecutionPlan,
} from "./panelScheduler.js";
import {
  collectCandidateReports,
  createCandidateWorkspaces,
  detectCandidateWorkspaceActivity,
  diffAgainstBaseline,
  loadBaselineManifest,
} from "./candidateWorkspace.js";
import { assertValidFusionRunId, assertValidFusionRunLocator, resolveRunLocatorPaths } from "./runLocator.js";
import {
  assertPanelWorkspacesExternal,
  buildSpeculativePathResolutionTrace,
  buildSpeculativeWorkspacePaths,
  SPECULATIVE_RESOLVER_VERSION,
} from "./speculativeWorkspacePaths.js";
import {
  buildMergePatchContractPrompt,
  buildPanelExecutionContext,
  buildPanelInlineDispatchPrompt,
  buildSpeculativeSharedPanelPrompt,
  mergePatchArtifactPaths,
  parseCandidateWorkspaceUnusable,
  parseMergePatchContract,
  renderSpeculativeTraceSummary,
  selectApprovedPatchItems,
} from "./speculativeBuild.js";
import type {
  AppliedPatchItem,
  BuildStrategy,
  CandidateValidationStatus,
  CandidateWorkspaceInfo,
  ContractAuditDecision,
  ContractAuditResult,
  ContextBundle,
  CouncilComparison,
  CouncilMode,
  CouncilResult,
  CorrectnessCoverageGate,
  FusionCouncilConfig,
  FusionModelSpec,
  FusionRunTrace,
  FusionTraceOptions,
  FusionTraceQuorum,
  IsolationCapability,
  MainBaselineTrace,
  MergePatchContract,
  ModelErrorType,
  ModelRunner,
  NativeAdvanceInput,
  NativeAdvanceResult,
  NativeCollectInput,
  NativeCollectResult,
  NativeAuditFinalizeInput,
  NativeAuditFinalizeResult,
  NativeAuditPrepareResult,
  NativeFinalizeInput,
  NativeFinalizeResult,
  NativePanelAgentPlan,
  NativePanelResult,
  NativePrepareInput,
  NativePrepareResult,
  NativeRecordMainBaselineInput,
  NativeRecordMainBaselineResult,
  NativeTodoItem,
  PanelAttemptTrace,
  PanelExecutionAssignmentTrace,
  PanelMode,
  PanelResponse,
  PromptVerbosity,
  RequirementDecisionMatrix,
  SpeculativePanelCandidateTrace,
} from "../types.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_EXECUTION_MODE = "native_subagents" as const;

/**
 * Absolute path of the actually loaded nativeCouncil module. At runtime this
 * resolves to the loaded build artifact (e.g. `.../dist/native/nativeCouncil.js`),
 * letting `/fusion-build` / `/fusion-trace` prove which implementation OpenCode
 * is running.
 */
export const RUNTIME_MODULE_PATH: string = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url;
  }
})();

/** Build the runtime identity marker surfaced in prepare results and traces. */
export function getRuntimeIdentity(): import("../types.js").RuntimeIdentity {
  return {
    modulePath: RUNTIME_MODULE_PATH,
    resolverVersion: SPECULATIVE_RESOLVER_VERSION,
    executionMode: NATIVE_EXECUTION_MODE,
  };
}

function buildRuntimeCapabilities(parallelExecutionSupported: boolean): import("../types.js").RuntimeCapabilityFlags {
  return {
    visibleTaskDispatchVerified: parallelExecutionSupported,
    childSessionStreamEvents: false,
    childReasoningDeltas: false,
    childToolLifecycleEvents: false,
    childSessionStatusInspection: false,
    cancellationAbortSupported: false,
    childTaskCwdOverride: false,
    childTaskWriteScopeEnforced: false,
    parentContinueWhileChildRuns: parallelExecutionSupported,
    safeRedispatchSupported: true,
    visibleJudgeSupported: true,
    tracePersistenceSupported: true,
  };
}

export async function nativePrepare(
  input: NativePrepareInput,
  options: { cwd: string; config?: FusionCouncilConfig; traceDir?: string },
): Promise<NativePrepareResult> {
  const cwd = options.cwd;
  const config = options.config ?? getDefaultFusionConfig();
  const traceOptions = resolveTraceOptions(input.trace);
  const runId = resolvePrepareRunId(input);
  const timestamp = new Date().toISOString();
  const artifactDir = artifactDirFor(cwd, runId, traceOptions.traceDir);
  const runStateFile = runStatePath(cwd, runId, traceOptions.traceDir);

  await mkdir(artifactDir, { recursive: true });
  await writeRunState(
    {
      lifecycleVersion: FUSION_RUN_STATE_LIFECYCLE_VERSION,
      runId,
      timestamp,
      sourceWorkspace: cwd,
      task: input.task,
      mode: input.mode,
      command: input.command,
      requestedFiles: input.files,
      includeDiff: input.includeDiff,
      panelMode: input.panelMode,
      buildStrategy: resolveBuildStrategy(input),
      context: { summary: "prepare in progress", files: [], omitted: [] },
      contractGate: extractContractGate(input.task),
      panelModelSpecs: [],
      judgeModelSpec: { modelId: "pending", raw: "pending" },
      sharedPanelPrompt: "",
      sharedPanelPromptHash: "",
      sharedPanelPromptPath: "",
      panelAgents: [],
      judgeAgent: { agentName: FUSION_AGENT_NAMES.judge, modelId: "pending" },
      traceOptions,
      postBuildContractAudit: config.defaults.postBuildContractAudit,
      maxPostBuildAuditFixCycles: config.defaults.maxPostBuildAuditFixCycles,
    },
    cwd,
    traceOptions.traceDir,
  );

  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const panelModelSpecs = resolved.panelModels.slice(0, 3);
  while (panelModelSpecs.length < 3) panelModelSpecs.push(panelModelSpecs[0]);
  const judgeModelSpec = resolved.judgeModel;
  const contractGate = extractContractGate(input.task);
  const promptVerbosity = input.promptVerbosity ?? (input.panelMode === "candidate_build" ? "compact" : undefined);
  const buildStrategy: BuildStrategy | undefined = resolveBuildStrategy(input);
  const isSpeculative = buildStrategy === "speculative_parallel_build";
  const parallelExecutionSupported = input.parallelExecutionSupported ?? true;
  const runtimeCapabilities = buildRuntimeCapabilities(parallelExecutionSupported);

  const panelExecutionPlan = buildPanelExecutionPlan(
    FUSION_PANEL_AGENT_NAMES.map((agentName, index) => ({
      panelIndex: index + 1,
      agentName,
      modelId: panelModelSpecs[index].modelId,
    })),
    panelModelSpecs,
    {
      startGateTimeoutMs: PANEL_START_GATE_TIMEOUT_MS,
      inactivityTimeoutMs: PANEL_INACTIVITY_TIMEOUT_MS,
      maxAttempts: MAX_PANEL_ATTEMPTS,
      capability: PANEL_LIVENESS_CAPABILITY,
    },
  );

  const judgeAgent = {
    agentName: FUSION_AGENT_NAMES.judge,
    modelId: judgeModelSpec.modelId,
    reasoningEffort: judgeModelSpec.reasoningEffort,
  };

  if (isSpeculative) {
    const sourceArtifactDir = sourceArtifactDirPath(cwd, runId, traceOptions.traceDir);
    const workspacePaths = buildSpeculativeWorkspacePaths({
      sourceWorkspace: cwd,
      sourceArtifactDir,
      runId,
      panelCount: panelModelSpecs.length,
    });
    const pathResolution = buildSpeculativePathResolutionTrace({
      paths: workspacePaths,
      runtimeModulePath: RUNTIME_MODULE_PATH,
    });
    assertPanelWorkspacesExternal({
      sourceWorkspace: workspacePaths.sourceWorkspace,
      sourceArtifactDir: workspacePaths.sourceArtifactDir,
      externalStagingDir: workspacePaths.externalStagingDir,
      panelWorkspacePaths: workspacePaths.panelWorkspacePaths,
      resolverVersion: pathResolution.resolverVersion,
    });

    const canonicalTaskPath = path.join(artifactDir, "canonical-task.md");
    const canonicalTaskHash = hashSharedPanelPrompt(input.task);
    await writeArtifactFile(canonicalTaskPath, `${input.task.trimEnd()}\n`);

    const deferredSharedPanelPromptPath = sharedPromptArtifactPath(cwd, runId, traceOptions.traceDir);
    const panelAgents: NativePanelAgentPlan[] = FUSION_PANEL_AGENT_NAMES.map((agentName, index) => ({
      panelIndex: index + 1,
      agentName,
      modelId: panelModelSpecs[index].modelId,
      reasoningEffort: panelModelSpecs[index].reasoningEffort,
      promptHash: canonicalTaskHash,
      nativeTask: true,
    }));

    const speculative: import("../types.js").SpeculativePrepareResult = {
      buildStrategy: "speculative_parallel_build",
      sourceWorkspace: cwd,
      sourceArtifactDir,
      externalCandidateStagingDir: workspacePaths.externalStagingDir,
      sourceBaselineManifestPath: path.join(sourceArtifactDir, "baseline-manifest.json"),
      sourceBaselineSummaryPath: path.join(sourceArtifactDir, "baseline-summary.md"),
      candidateWorkspaces: [],
      isolationCapability: {
        nativeCwdScoped: false,
        writeBoundaryScoped: false,
        hardLinkSafe: false,
        symlinkSafe: false,
        verified: false,
        limitation: "Candidate workspace isolation is not verified during prepare. Verification occurs later during fusion_native advance when external candidate workspaces are staged.",
      },
      parallelExecutionSupported,
      parallelCapabilityLimitation: parallelExecutionSupported
        ? undefined
        : "OpenCode task overlap has not been runtime-verified. Automatic cancellation remains disabled and overlap claims are suppressed.",
      aborted: false,
      preparedAt: timestamp,
      pathResolution,
    };

    const state: RunState = {
      lifecycleVersion: FUSION_RUN_STATE_LIFECYCLE_VERSION,
      runId,
      timestamp,
      sourceWorkspace: cwd,
      command: input.command,
      requestedFiles: input.files,
      includeDiff: input.includeDiff,
      task: input.task,
      mode: input.mode,
      panelMode: input.panelMode,
      buildStrategy,
      context: { summary: "Speculative panel preparation deferred to fusion_native advance.", files: [], omitted: [] },
      contractGate,
      panelModelSpecs,
      judgeModelSpec,
      sharedPanelPrompt: "",
      sharedPanelPromptHash: "",
      sharedPanelPromptPath: deferredSharedPanelPromptPath,
      panelAgents,
      panelExecutionPlan,
      judgeAgent,
      requireAllPanels: input.requireAllPanels,
      minSuccessfulPanels: input.minSuccessfulPanels,
      allowDegradedJudge: input.allowDegradedJudge,
      promptVerbosity,
      traceOptions,
      postBuildContractAudit: config.defaults.postBuildContractAudit,
      maxPostBuildAuditFixCycles: config.defaults.maxPostBuildAuditFixCycles,
      panelLivenessCapability: PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities,
      speculative: {
        buildStrategy: speculative.buildStrategy,
        sourceWorkspace: speculative.sourceWorkspace,
        sourceArtifactDir: speculative.sourceArtifactDir,
        externalCandidateStagingDir: speculative.externalCandidateStagingDir,
        sourceBaselineManifestPath: speculative.sourceBaselineManifestPath,
        sourceBaselineSummaryPath: speculative.sourceBaselineSummaryPath,
        candidateWorkspaces: speculative.candidateWorkspaces,
        isolationCapability: speculative.isolationCapability,
        parallelExecutionSupported: speculative.parallelExecutionSupported,
        parallelCapabilityLimitation: speculative.parallelCapabilityLimitation,
        preflightDiagnostic: speculative.preflightDiagnostic,
        aborted: speculative.aborted,
        abortReason: speculative.abortReason,
        preparedAt: speculative.preparedAt,
        candidatePreparationCompletedAt: speculative.candidatePreparationCompletedAt,
        pathResolution: speculative.pathResolution,
        sharedTaskPath: speculative.sharedTaskPath,
        panelExecutionAssignments: speculative.panelExecutionAssignments,
      },
    };
    await writeRunState(state, cwd, traceOptions.traceDir);

    const todoPlan = buildTodoPlan({
      panelModelSpecs,
      judgeModelSpec,
      command: input.command,
      phase: "prepare",
      buildStrategy,
    });

    return {
      executionMode: NATIVE_EXECUTION_MODE,
      runId,
      artifactDir,
      traceArtifactDir: artifactDir,
      runStatePath: runStateFile,
      panelAgents,
      panelExecutionPlan,
      judgeAgent,
      todoPlan,
      mode: input.mode,
      panelMode: input.panelMode,
      buildStrategy,
      task: input.task,
      canonicalTaskPath,
      canonicalTaskHash,
      speculative,
      runtimeIdentity: getRuntimeIdentity(),
    };
  }

  const context = await collectContext({ cwd, files: input.files, includeDiff: input.includeDiff });

  const sharedPanelPrompt = buildPanelPrompt({
    task: input.task,
    mode: input.mode,
    context,
    panelMode: input.panelMode,
    promptVerbosity,
    contractGate,
  });
  const sharedPanelPromptHash = hashSharedPanelPrompt(sharedPanelPrompt);

  const panelTransport = await preparePromptTransport({
    kind: "panel",
    canonicalPrompt: sharedPanelPrompt,
    artifactDir,
    briefContext: {
      kind: "panel",
      panelMode: input.panelMode,
    },
    writeArtifacts: traceOptions.saveRunArtifacts !== false,
  });
  const sharedPanelPromptPath = panelTransport.metadata.fullArtifactPath
    ?? await writeSharedPromptArtifact(sharedPanelPrompt, cwd, runId, traceOptions.traceDir);

  const panelAgents: NativePanelAgentPlan[] = FUSION_PANEL_AGENT_NAMES.map((agentName, index) => ({
    panelIndex: index + 1,
    agentName,
    modelId: panelModelSpecs[index].modelId,
    reasoningEffort: panelModelSpecs[index].reasoningEffort,
    promptHash: sharedPanelPromptHash,
    nativeTask: true,
  }));

  const todoPlan = buildTodoPlan({
    panelModelSpecs,
    judgeModelSpec,
    command: input.command,
    phase: "prepare",
    buildStrategy,
  });

  const state: RunState = {
    lifecycleVersion: FUSION_RUN_STATE_LIFECYCLE_VERSION,
    runId,
    timestamp,
    sourceWorkspace: cwd,
    command: input.command,
    requestedFiles: input.files,
    includeDiff: input.includeDiff,
    task: input.task,
    mode: input.mode,
    panelMode: input.panelMode,
    buildStrategy,
    context,
    contractGate,
    panelModelSpecs,
    judgeModelSpec,
    sharedPanelPrompt,
    sharedPanelPromptHash,
    sharedPanelPromptPath,
    panelTransportPrompt: panelTransport.inlineTransportPrompt,
    panelPromptTransport: panelTransport.metadata,
    panelAgents,
    panelExecutionPlan,
    judgeAgent,
    requireAllPanels: input.requireAllPanels,
    minSuccessfulPanels: input.minSuccessfulPanels,
    allowDegradedJudge: input.allowDegradedJudge,
    promptVerbosity,
    traceOptions,
    postBuildContractAudit: config.defaults.postBuildContractAudit,
    maxPostBuildAuditFixCycles: config.defaults.maxPostBuildAuditFixCycles,
    panelLivenessCapability: PANEL_LIVENESS_CAPABILITY,
    runtimeCapabilities,
  };
  await writeRunState(state, cwd, traceOptions.traceDir);

  return {
    executionMode: NATIVE_EXECUTION_MODE,
    runId,
    artifactDir: artifactDirFor(cwd, runId, traceOptions.traceDir),
    traceArtifactDir: artifactDirFor(cwd, runId, traceOptions.traceDir),
    runStatePath: runStateFile,
    sharedPanelPrompt,
    sharedPanelPromptHash,
    sharedPanelPromptPath,
    panelTransportPrompt: panelTransport.inlineTransportPrompt,
    panelPromptTransport: panelTransport.metadata,
    panelAgents,
    panelExecutionPlan,
    judgeAgent,
    todoPlan,
    mode: input.mode,
    panelMode: input.panelMode,
    buildStrategy,
    task: input.task,
    canonicalTaskPath: sharedPanelPromptPath,
    canonicalTaskHash: sharedPanelPromptHash,
    runtimeIdentity: getRuntimeIdentity(),
  };
}

/**
 * Resolve the build strategy for a native prepare call.
 *
 * `/fusion-build` defaults to `speculative_parallel_build` (panels build
 * competing candidates in isolated workspaces while the main agent
 * independently builds a baseline). Explicit `buildStrategy` input always wins.
 * `/fusion-no-build` and other commands leave the strategy unset.
 */
function resolveBuildStrategy(input: NativePrepareInput): BuildStrategy | undefined {
  if (input.buildStrategy) return input.buildStrategy;
  if (input.command === "fusion-build" && input.panelMode === "candidate_build") {
    return "speculative_parallel_build";
  }
  return undefined;
}

function resolvePrepareRunId(input: NativePrepareInput): string {
  if (input.runId != null && String(input.runId).trim() !== "") {
    assertValidFusionRunId(String(input.runId));
    return String(input.runId).trim();
  }
  const generated = createRunId();
  assertValidFusionRunId(generated);
  return generated;
}

async function ensureSpeculativePreparation(
  state: RunState,
  options: { cwd: string; traceDir?: string },
): Promise<RunState> {
  if (state.buildStrategy !== "speculative_parallel_build" || !state.speculative || state.speculative.aborted) {
    return state;
  }
  if (
    state.sharedPanelPrompt
    && state.sharedPanelPromptHash
    && state.speculative.candidateWorkspaces.length === state.panelAgents.length
    && state.speculative.panelExecutionAssignments?.length === state.panelAgents.length
  ) {
    return state;
  }

  const cwd = options.cwd;
  const artifactDir = artifactDirFor(cwd, state.runId, state.traceOptions.traceDir);
  const context = await collectContext({
    cwd,
    files: state.requestedFiles,
    includeDiff: state.includeDiff,
  });
  const sharedPanelPrompt = buildSpeculativeSharedPanelPrompt({
    task: state.task,
    context,
    contractGate: state.contractGate,
    promptVerbosity: state.promptVerbosity,
  });
  const sharedPanelPromptHash = hashSharedPanelPrompt(sharedPanelPrompt);

  const panelTransport = await preparePromptTransport({
    kind: "panel",
    canonicalPrompt: sharedPanelPrompt,
    artifactDir,
    briefContext: {
      kind: "panel",
      panelMode: state.panelMode,
    },
    writeArtifacts: true,
  });
  const sharedPanelPromptPath = panelTransport.metadata.fullArtifactPath
    ?? await writeSharedPromptArtifact(sharedPanelPrompt, cwd, state.runId, state.traceOptions.traceDir);

  const workspacePaths = state.speculative.pathResolution
    ? {
      sourceWorkspace: state.speculative.pathResolution.sourceWorkspace,
      sourceArtifactDir: state.speculative.pathResolution.sourceArtifactDir,
      externalStagingDir: state.speculative.pathResolution.externalCandidateStagingDir,
      panelWorkspacePaths: state.speculative.pathResolution.panelWorkspacePaths as [string, string, string],
    }
    : buildSpeculativeWorkspacePaths({
      sourceWorkspace: cwd,
      sourceArtifactDir: state.speculative.sourceArtifactDir,
      runId: state.runId,
      panelCount: state.panelModelSpecs.length,
    });
  const pathResolution = buildSpeculativePathResolutionTrace({
    paths: workspacePaths,
    runtimeModulePath: RUNTIME_MODULE_PATH,
  });
  assertPanelWorkspacesExternal({
    sourceWorkspace: workspacePaths.sourceWorkspace,
    sourceArtifactDir: workspacePaths.sourceArtifactDir,
    externalStagingDir: workspacePaths.externalStagingDir,
    panelWorkspacePaths: workspacePaths.panelWorkspacePaths,
    resolverVersion: pathResolution.resolverVersion,
  });

  assertNoUnresolvedPlaceholders(
    [{ label: "shared-panel-prompt.full.md", text: sharedPanelPrompt }],
    { mode: "forbidden_tokens" },
  );
  assertNoUnresolvedPlaceholders(
    [{ label: "fusion-panel agent template", text: PANEL_PROMPT }],
    { mode: "forbidden_tokens" },
  );

  const preflight = await createCandidateWorkspaces({
    paths: workspacePaths,
    panelCount: state.panelModelSpecs.length,
  });
  if (!preflight.ok) {
    const abortedState: RunState = {
      ...state,
      context,
      sharedPanelPrompt,
      sharedPanelPromptHash,
      sharedPanelPromptPath,
      panelTransportPrompt: panelTransport.inlineTransportPrompt,
      panelPromptTransport: panelTransport.metadata,
      speculative: {
        ...state.speculative,
        sourceBaselineManifestPath: preflight.baselineManifestPath,
        sourceBaselineSummaryPath: preflight.baselineSummaryPath,
        isolationCapability: preflight.isolationCapability,
        preflightDiagnostic: preflight.diagnostic,
        parallelCapabilityLimitation: preflight.diagnostic,
        aborted: true,
        abortReason: preflight.diagnostic,
      },
    };
    await writeRunState(abortedState, cwd, options.traceDir);
    return abortedState;
  }

  const updatedPanelAgents = state.panelAgents.map((agent) => ({ ...agent, promptHash: sharedPanelPromptHash }));
  const assignments: PanelExecutionAssignmentTrace[] = [];
  for (const workspace of preflight.workspaces) {
    const logicalPanelIndex = workspace.logicalPanelIndex;
    const spec = state.panelModelSpecs[logicalPanelIndex - 1] ?? state.panelModelSpecs[0];
    const executionContextPath = panelExecutionContextArtifactPath(cwd, state.runId, logicalPanelIndex, state.traceOptions.traceDir);
    const executionContext = buildPanelExecutionContext({
      logicalPanelIndex,
      modelId: spec.modelId,
      candidateWorkspacePath: workspace.workspacePath,
      sourceWorkspacePath: cwd,
      reportPath: workspace.candidateReportPath,
      notesPath: workspace.candidateNotesPath,
      sharedTaskPath: sharedPanelPromptPath,
      resolverVersion: SPECULATIVE_RESOLVER_VERSION,
      runtimeModulePath: RUNTIME_MODULE_PATH,
    });
    const inlineDispatchPrompt = buildPanelInlineDispatchPrompt({
      logicalPanelIndex,
      modelId: spec.modelId,
      candidateWorkspacePath: workspace.workspacePath,
      sourceWorkspacePath: cwd,
      reportPath: workspace.candidateReportPath,
      executionContextPath,
      sharedTaskPath: sharedPanelPromptPath,
    });
    assertNoUnresolvedPlaceholders(
      [
        { label: `panel-${logicalPanelIndex}-execution-context.full.md`, text: executionContext },
        { label: `panel-${logicalPanelIndex} inline dispatch prompt`, text: inlineDispatchPrompt },
      ],
      { mode: "generic" },
    );
    await writeArtifactFile(executionContextPath, executionContext);

    const executionContextHash = hashSharedPanelPrompt(executionContext);
    const agent = updatedPanelAgents[logicalPanelIndex - 1];
    if (agent) {
      agent.executionContextPath = executionContextPath;
      agent.executionContextHash = executionContextHash;
      agent.candidateWorkspacePath = workspace.workspacePath;
      agent.sourceWorkspacePath = cwd;
      agent.panelReportPath = workspace.candidateReportPath;
      agent.panelNotesPath = workspace.candidateNotesPath;
      agent.sharedTaskPath = sharedPanelPromptPath;
      agent.inlineDispatchPrompt = inlineDispatchPrompt;
    }

    assignments.push({
      logicalPanelIndex,
      sharedTaskPath: sharedPanelPromptPath,
      executionContextPath,
      assignedCandidateWorkspace: workspace.workspacePath,
      prohibitedSourceWorkspace: cwd,
      panelOutputPath: workspace.candidateReportPath,
      sharedTaskHash: sharedPanelPromptHash,
      executionContextHash,
      unresolvedPlaceholderCheck: "passed",
      nativeCwdScoped: false,
      absolutePathModeRequired: true,
      resolverVersion: SPECULATIVE_RESOLVER_VERSION,
      runtimeModulePath: RUNTIME_MODULE_PATH,
    });
  }

  const updatedState: RunState = {
    ...state,
    context,
    sharedPanelPrompt,
    sharedPanelPromptHash,
    sharedPanelPromptPath,
    panelTransportPrompt: panelTransport.inlineTransportPrompt,
    panelPromptTransport: panelTransport.metadata,
    panelAgents: updatedPanelAgents,
    speculative: {
      ...state.speculative,
      sourceBaselineManifestPath: preflight.baselineManifestPath,
      sourceBaselineSummaryPath: preflight.baselineSummaryPath,
      candidateWorkspaces: preflight.workspaces,
      isolationCapability: preflight.isolationCapability,
      preflightDiagnostic: undefined,
      aborted: false,
      abortReason: undefined,
      pathResolution,
      sharedTaskPath: sharedPanelPromptPath,
      panelExecutionAssignments: assignments,
      candidatePreparationCompletedAt: new Date().toISOString(),
    },
  };
  await writeRunState(updatedState, cwd, options.traceDir);
  return updatedState;
}

function isSpeculativeStagingComplete(state: RunState): boolean {
  return Boolean(
    state.sharedPanelPrompt
    && state.sharedPanelPromptHash
    && state.speculative
    && state.speculative.candidateWorkspaces.length === state.panelAgents.length
    && state.speculative.panelExecutionAssignments?.length === state.panelAgents.length,
  );
}

function shouldDeferSpeculativeStaging(
  state: RunState,
  input: NativeAdvanceInput,
  mainBaselineAlreadyStarted: boolean,
): boolean {
  if (state.buildStrategy !== "speculative_parallel_build" || !state.speculative || state.speculative.aborted) {
    return false;
  }
  if (isSpeculativeStagingComplete(state)) {
    return false;
  }
  if (!input.mainBaselineStartedAt || mainBaselineAlreadyStarted) {
    return false;
  }
  return !input.panelDispatches?.length && !input.panelResults?.length && !input.panelObservations?.length;
}

function resolvePanelIndex(
  state: RunState,
  input: { logicalPanelIndex?: number; agentName?: string; modelId?: string },
): number | undefined {
  if (input.logicalPanelIndex && input.logicalPanelIndex >= 1 && input.logicalPanelIndex <= state.panelAgents.length) {
    return input.logicalPanelIndex;
  }
  if (input.agentName) {
    const byAgent = state.panelAgents.find((agent) => agent.agentName === input.agentName);
    if (byAgent) return byAgent.panelIndex;
  }
  if (input.modelId) {
    const byModel = state.panelAgents.find((agent) => agent.modelId === input.modelId);
    if (byModel) return byModel.panelIndex;
  }
  return undefined;
}

function isMainBaselineTerminal(mainBaseline?: MainBaselineTrace): boolean {
  if (!mainBaseline) return false;
  return mainBaseline.status === "passed" || mainBaseline.status === "failed" || mainBaseline.status === "blocked";
}

function computeUsablePanelCount(state: RunState, panelResults: NativePanelResult[]): number {
  let usable = 0;
  for (const agent of state.panelAgents) {
    const result = panelResults.find((entry) => entry.agentName === agent.agentName) ?? panelResults.find((entry) => entry.modelId === agent.modelId);
    if (!result?.content || result.error) continue;
    if (state.panelMode === "candidate_build") {
      const validation = validateCandidateOutput(result.content);
      if (validation.status === "passed" || validation.status === "usable_with_warnings") {
        usable += 1;
      }
      continue;
    }
    usable += 1;
  }
  return usable;
}

function upsertPanelResults(existing: NativePanelResult[], incoming: NativePanelResult[]): NativePanelResult[] {
  const merged = existing.map((entry) => ({ ...entry }));
  for (const result of incoming) {
    const index = merged.findIndex((entry) =>
      (result.agentName && entry.agentName === result.agentName)
      || (result.modelId && entry.modelId === result.modelId));
    if (index >= 0) merged[index] = { ...merged[index], ...result };
    else merged.push({ ...result });
  }
  return merged;
}

function buildAdvanceTodoPlan(state: RunState): NativeTodoItem[] {
  const plan = buildTodoPlan({
    panelModelSpecs: state.panelModelSpecs,
    judgeModelSpec: state.judgeModelSpec,
    command: state.command,
    phase: "prepare",
    buildStrategy: state.buildStrategy,
    mainBaselineStatus: state.speculative?.mainBaseline?.status,
  }).map((item) => ({ ...item }));

  const panelOffset = state.buildStrategy === "speculative_parallel_build" ? 2 : 1;
  for (let index = 1; index <= state.panelAgents.length; index += 1) {
    const planEntry = plan[panelOffset + index - 1];
    if (!planEntry) continue;
    const attempt = (state.panelAttempts ?? []).filter((entry) => entry.logicalPanelIndex === index).slice(-1)[0];
    const result = (state.panelResults ?? []).find((entry) => entry.agentName === state.panelAgents[index - 1]?.agentName)
      ?? (state.panelResults ?? []).find((entry) => entry.modelId === state.panelAgents[index - 1]?.modelId);
    if (result?.content && !result.error) {
      planEntry.status = "completed";
      continue;
    }
    if (result?.error) {
      planEntry.status = "failed";
      continue;
    }
    if (attempt && ["waiting_for_activity", "running", "healthy", "suspected_stalled", "retrying"].includes(attempt.status)) {
      planEntry.status = "in_progress";
    } else if (attempt && ["stalled", "cancelled", "failed"].includes(attempt.status)) {
      planEntry.status = "failed";
    }
  }

  if (state.buildStrategy === "speculative_parallel_build" && plan[5]) {
    const baselineStatus = state.speculative?.mainBaseline?.status;
    if (baselineStatus === "running") plan[5].status = "in_progress";
  }
  if (plan[6] && state.speculative?.judgeEligibleAt) plan[6].status = "completed";
  if (plan[7] && state.speculative?.judgeEligibleAt) plan[7].status = "completed";
  if (plan[8] && state.speculative?.judgeStartedAt && !state.judgeOutput) plan[8].status = "in_progress";
  if (plan[8] && state.judgeOutput) plan[8].status = "completed";

  return plan;
}

function buildAdvanceSpeculativeResult(state: RunState): import("../types.js").SpeculativePrepareResult | undefined {
  if (!state.speculative) return undefined;
  return {
    buildStrategy: "speculative_parallel_build",
    sourceWorkspace: state.speculative.sourceWorkspace,
    sourceArtifactDir: state.speculative.sourceArtifactDir,
    externalCandidateStagingDir: state.speculative.externalCandidateStagingDir,
    sourceBaselineManifestPath: state.speculative.sourceBaselineManifestPath,
    sourceBaselineSummaryPath: state.speculative.sourceBaselineSummaryPath,
    candidateWorkspaces: state.speculative.candidateWorkspaces,
    isolationCapability: state.speculative.isolationCapability,
    parallelExecutionSupported: state.speculative.parallelExecutionSupported,
    parallelCapabilityLimitation: state.speculative.parallelCapabilityLimitation,
    preflightDiagnostic: state.speculative.preflightDiagnostic,
    aborted: state.speculative.aborted,
    abortReason: state.speculative.abortReason,
    preparedAt: state.speculative.preparedAt,
    candidatePreparationCompletedAt: state.speculative.candidatePreparationCompletedAt,
    judgeEligibleAt: state.speculative.judgeEligibleAt,
    pathResolution: state.speculative.pathResolution!,
    sharedTaskPath: state.speculative.sharedTaskPath,
    panelExecutionAssignments: state.speculative.panelExecutionAssignments,
  };
}

export async function nativeAdvance(
  input: NativeAdvanceInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeAdvanceResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  let state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });

  const mainBaselineAlreadyStarted = Boolean(state.speculative?.mainBaseline?.startedAt);

  if (input.mainBaselineStartedAt && state.speculative && !state.speculative.mainBaseline?.startedAt) {
    state = {
      ...state,
      speculative: {
        ...state.speculative,
        mainBaseline: {
          status: "running",
          workspacePath: state.speculative.sourceWorkspace,
          changedFiles: [],
          startedAt: input.mainBaselineStartedAt,
        },
      },
    };
  }

  const deferSpeculativeStaging = shouldDeferSpeculativeStaging(state, input, mainBaselineAlreadyStarted);

  if (state.buildStrategy === "speculative_parallel_build" && !deferSpeculativeStaging) {
    state = await ensureSpeculativePreparation(state, options);
  }

  if (deferSpeculativeStaging) {
    const todoUpdates = buildAdvanceTodoPlan(state);
    await writeRunState(state, cwd, options.traceDir);
    return {
      runId: state.runId,
      phase: "preparing_panels",
      nextAction: {
        type: "wait",
        deadline: new Date().toISOString(),
        delayMs: 0,
        reason: "all_running",
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults: state.panelResults ?? [],
      judgeEligible: false,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities ?? buildRuntimeCapabilities(state.speculative?.parallelExecutionSupported ?? true),
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  const scheduler = new PanelScheduler(
    state.panelModelSpecs.map((spec) => spec.modelId),
    { capability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY },
  );
  scheduler.loadAttempts(state.panelAttempts ?? []);

  for (const dispatch of input.panelDispatches ?? []) {
    const panelIndex = resolvePanelIndex(state, { logicalPanelIndex: dispatch.logicalPanelIndex });
    if (!panelIndex) continue;
    const current = scheduler.currentAttempt(panelIndex);
    const alreadyRecorded = current
      && current.startReason === dispatch.startReason
      && current.nativeSessionId === dispatch.sessionId
      && !current.endedAt;
    if (!alreadyRecorded) {
      const attempt = scheduler.recordAttemptStart(panelIndex, dispatch.startReason, dispatch.sessionId);
      if (dispatch.startedAt) {
        const writable = scheduler.currentAttempt(panelIndex);
        if (writable) {
          writable.startedAt = dispatch.startedAt;
          writable.dispatchAt = dispatch.startedAt;
          writable.fallbackGateAt = new Date(Date.parse(dispatch.startedAt) + PANEL_START_GATE_FALLBACK_TIMEOUT_MS).toISOString();
        }
      }
      void attempt;
    }
    scheduler.markWorkspacePrepared(panelIndex, dispatch.startedAt);
  }

  for (const observation of input.panelObservations ?? []) {
    const panelIndex = resolvePanelIndex(state, { logicalPanelIndex: observation.logicalPanelIndex });
    if (!panelIndex) continue;
    scheduler.recordCredibleActivity(panelIndex, observation.source, observation.observedAt);
  }

  if (state.speculative?.candidateWorkspaces.length) {
    const candidateObservations = await detectCandidateWorkspaceActivity(state.speculative.candidateWorkspaces);
    for (const observation of candidateObservations) {
      const existingAttempt = scheduler.currentAttempt(observation.logicalPanelIndex);
      if (!existingAttempt || existingAttempt.endedAt) continue;
      const lastObservedAt = existingAttempt.lastActivityAt ? Date.parse(existingAttempt.lastActivityAt) : NaN;
      const observedAt = Date.parse(observation.observedAt);
      if (Number.isFinite(lastObservedAt) && Number.isFinite(observedAt) && observedAt <= lastObservedAt) {
        continue;
      }
      scheduler.recordCredibleActivity(observation.logicalPanelIndex, observation.source, observation.observedAt);
    }
  }

  let panelResults = upsertPanelResults(state.panelResults ?? [], []);
  const frozenPanelIndexes = new Set<number>(state.speculative?.frozenPanelIndexes ?? []);
  const lateExcludedPanelIndexes = new Set<number>(state.speculative?.lateExcludedPanelIndexes ?? []);
  for (const result of input.panelResults ?? []) {
    const panelIndex = resolvePanelIndex(state, result);
    if (!panelIndex) continue;
    const currentAttempt = scheduler.currentAttempt(panelIndex);
    const observedAt = new Date().toISOString();
    if (state.speculative?.judgeEligibleAt && frozenPanelIndexes.has(panelIndex)) {
      if (currentAttempt && !currentAttempt.excludedAt) {
        currentAttempt.excludedAt = observedAt;
        currentAttempt.excludedReason = "Result arrived after judge quorum was frozen.";
      }
      lateExcludedPanelIndexes.add(panelIndex);
      continue;
    }

    panelResults = upsertPanelResults(panelResults, [result]);
    if (result.content && !result.error) {
      scheduler.recordCredibleActivity(panelIndex, "terminal_result", observedAt);
      scheduler.recordAttemptEnd(panelIndex, "succeeded");
    } else if (result.errorType === "timeout") {
      scheduler.recordAttemptEnd(panelIndex, "stalled", "task_timeout");
    } else {
      scheduler.recordAttemptEnd(panelIndex, "failed", result.error ? "task_error" : undefined);
    }
  }

  const usablePanels = computeUsablePanelCount(state, panelResults);
  const requiredPanels = state.minSuccessfulPanels ?? (state.requireAllPanels ? state.panelAgents.length : 2);
  const mainBaselineTerminal = isMainBaselineTerminal(state.speculative?.mainBaseline);
  const judgeEligible = mainBaselineTerminal && usablePanels >= requiredPanels;
  let judgeEligibleAt = state.speculative?.judgeEligibleAt;

  if (judgeEligible && !judgeEligibleAt) {
    judgeEligibleAt = new Date().toISOString();
    for (let index = 1; index <= state.panelAgents.length; index += 1) {
      const result = panelResults.find((entry) => entry.agentName === state.panelAgents[index - 1]?.agentName)
        ?? panelResults.find((entry) => entry.modelId === state.panelAgents[index - 1]?.modelId);
      if (!result) frozenPanelIndexes.add(index);
    }
  }

  if (input.judgeDispatched && state.speculative) {
    state = {
      ...state,
      speculative: {
        ...state.speculative,
        judgeStartedAt: input.judgeDispatched.startedAt ?? new Date().toISOString(),
      },
    };
  }

  state = {
    ...state,
    panelAttempts: scheduler.getAttempts(),
    panelResults,
    runtimeCapabilities: state.runtimeCapabilities ?? buildRuntimeCapabilities(state.speculative?.parallelExecutionSupported ?? true),
    speculative: state.speculative
      ? {
        ...state.speculative,
        judgeEligibleAt,
        frozenPanelIndexes: [...frozenPanelIndexes].sort((a, b) => a - b),
        lateExcludedPanelIndexes: [...lateExcludedPanelIndexes].sort((a, b) => a - b),
      }
      : undefined,
  };

  const todoUpdates = buildAdvanceTodoPlan(state);
  await writeRunState(state, cwd, options.traceDir);

  if (state.speculative?.aborted) {
    return {
      runId: state.runId,
      phase: "done",
      nextAction: {
        type: "done",
        reason: state.speculative.abortReason ?? "Speculative candidate preparation aborted.",
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible: false,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  if (state.judgeOutput || state.finalGuidance) {
    return {
      runId: state.runId,
      phase: "done",
      nextAction: { type: "done", reason: "Judge already finalized for this run." },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible,
      judgeEligibleAt,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  if (state.speculative?.judgeStartedAt) {
    return {
      runId: state.runId,
      phase: "judge_running",
      nextAction: { type: "done", reason: "Judge already dispatched; wait for judge completion." },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible,
      judgeEligibleAt,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  if (judgeEligible && judgeEligibleAt) {
    return {
      runId: state.runId,
      phase: "ready_to_collect",
      nextAction: {
        type: "call_collect",
        reason: `Main baseline is terminal and ${usablePanels}/${state.panelAgents.length} panels are presently usable.`,
        judgeEligibleAt,
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible: true,
      judgeEligibleAt,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  const action = scheduler.nextAction();
  if (action.type === "start_panel") {
    const agent = state.panelAgents[action.panelIndex - 1];
    return {
      runId: state.runId,
      phase: state.sharedPanelPrompt ? "panel_execution" : "preparing_panels",
      nextAction: {
        type: "start_panel",
        logicalPanelIndex: action.panelIndex,
        attempt: action.attempt,
        startReason: action.reason,
        agentName: agent?.agentName ?? `fusion-panel-${action.panelIndex}`,
        modelId: agent?.modelId ?? "",
        prompt: state.buildStrategy === "speculative_parallel_build"
          ? (agent?.inlineDispatchPrompt ?? "")
          : (state.panelTransportPrompt ?? state.sharedPanelPrompt),
        candidateWorkspacePath: agent?.candidateWorkspacePath,
        fallbackGateAt: new Date(Date.now() + PANEL_START_GATE_FALLBACK_TIMEOUT_MS).toISOString(),
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible: false,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  if (action.type === "wait") {
    const delayMs = Math.max(0, action.deadlineMs - Date.now());
    return {
      runId: state.runId,
      phase: "panel_execution",
      nextAction: {
        type: "wait",
        deadline: new Date(action.deadlineMs).toISOString(),
        delayMs,
        reason: action.reason === "all_running" ? "all_running" : action.reason,
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible: false,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  if (!mainBaselineTerminal) {
    const delayMs = 15_000;
    return {
      runId: state.runId,
      phase: "panel_execution",
      nextAction: {
        type: "wait",
        deadline: new Date(Date.now() + delayMs).toISOString(),
        delayMs,
        reason: "all_running",
      },
      panelAttempts: state.panelAttempts ?? [],
      panelResults,
      judgeEligible: false,
      panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
      runtimeCapabilities: state.runtimeCapabilities,
      todoUpdates,
      speculative: buildAdvanceSpeculativeResult(state),
    };
  }

  return {
    runId: state.runId,
    phase: "done",
    nextAction: {
      type: "done",
      reason: `Panel execution exhausted without judge quorum (${usablePanels}/${state.panelAgents.length} usable, required ${requiredPanels}).`,
    },
    panelAttempts: state.panelAttempts ?? [],
    panelResults,
    judgeEligible: false,
    panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
    runtimeCapabilities: state.runtimeCapabilities,
    todoUpdates,
    speculative: buildAdvanceSpeculativeResult(state),
  };
}

export async function nativeCollect(
  input: NativeCollectInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeCollectResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  let state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  if (state.buildStrategy === "speculative_parallel_build") {
    state = await ensureSpeculativePreparation(state, options);
  }
  const config = getDefaultFusionConfig();
  const mergedPanelResults = upsertPanelResults(state.panelResults ?? [], input.panelResults ?? []);
  const panelResponses = buildPanelResponsesFromNativeResults(state, mergedPanelResults, config);
  const panelAttempts = input.panelAttempts ?? state.panelAttempts ?? [];
  const panelLivenessCapability = state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY;
  const quorumInput = {
    task: state.task,
    mode: state.mode,
    requireAllPanels: state.requireAllPanels,
    minSuccessfulPanels: state.minSuccessfulPanels,
    allowDegradedJudge: state.allowDegradedJudge,
  };
  const quorum = buildQuorum(panelResponses, quorumInput, state.panelModelSpecs.length);
  const shouldProceed = computeShouldProceed(quorum, panelResponses, quorumInput);
  const reason = computeReason(shouldProceed, quorum, panelResponses);

  const councilComparison = shouldProceed
    ? buildCouncilComparison({
        task: state.task,
        contractGate: state.contractGate,
        panel: panelResponses,
        quorumDegraded: quorum.degraded,
      })
    : undefined;
  const councilComparisonMarkdown = councilComparison ? renderCouncilComparisonMarkdown(councilComparison) : undefined;

  const isSpeculative = state.buildStrategy === "speculative_parallel_build" && state.speculative != null;

  // For speculative mode, record/refresh the main baseline trace and build the
  // Merge Patch Contract judge prompt instead of the legacy judge prompt.
  let speculative: import("../types.js").SpeculativeCollectResult | undefined;
  let mainBaselineForState: MainBaselineTrace | undefined = state.speculative?.mainBaseline;
  if (isSpeculative && state.speculative) {
    if (input.mainBaseline) {
      mainBaselineForState = input.mainBaseline;
    } else if (!mainBaselineForState) {
      // The orchestrator must record the main baseline before calling collect
      // in speculative mode. If it did not, record a blocked placeholder so
      // the trace is honest. The judge gate will still run if quorum is met,
      // but the Merge Patch Contract will note the missing main baseline.
      mainBaselineForState = {
        status: "blocked",
        workspacePath: state.speculative.sourceWorkspace,
        changedFiles: [],
      };
    }
    const mainBaseline: MainBaselineTrace = mainBaselineForState;

    // Collect each panel's candidate-local report into the source-side artifact
    // directory the judge reads. Panels write only inside their own candidate
    // workspace; this copies those reports source-side without fabricating any.
    await collectCandidateReports(state.speculative.candidateWorkspaces);

    const panelCandidateTrace = buildPanelCandidateTrace(state, panelResponses, state.speculative.candidateWorkspaces);
    const overlapObserved = computeOverlapObserved(mainBaseline, panelCandidateTrace, panelAttempts);
    const overlapDurationMs = computeOverlapDurationMs(mainBaseline, panelAttempts);

    const judgeEligibleAt = state.speculative.judgeEligibleAt
      ?? (shouldProceed && isMainBaselineTerminal(mainBaseline) ? new Date().toISOString() : undefined);
    const frozenPanelIndexes = state.speculative.frozenPanelIndexes
      ?? state.panelAgents
        .filter((agent) => !mergedPanelResults.some((result) => result.agentName === agent.agentName || result.modelId === agent.modelId))
        .map((agent) => agent.panelIndex);

    const mergePatchContractPath = mergePatchContractArtifactPath(cwd, state.runId, state.traceOptions.traceDir);
    const mergePatchContractPrompt = shouldProceed
      ? buildMergePatchContractPrompt({
          task: state.task,
          context: state.context,
          contractGate: state.contractGate,
          realWorkspacePath: state.speculative.sourceWorkspace,
          mainBaseline,
          candidateWorkspaces: state.speculative.candidateWorkspaces,
          panelCandidates: panelCandidateTrace,
          panel: panelResponses,
          quorum,
          councilComparison,
          councilComparisonMarkdown,
          sourceArtifactDir: state.speculative.sourceArtifactDir,
          externalCandidateStagingDir: state.speculative.externalCandidateStagingDir,
          mergePatchContractPath,
        })
      : "";

    speculative = {
      buildStrategy: "speculative_parallel_build",
      mainBaseline,
      candidateWorkspaces: state.speculative.candidateWorkspaces,
      panelCandidateTrace,
      overlapObserved,
      overlapDurationMs,
      judgeEligibleAt,
      frozenPanelIndexes,
      lateExcludedPanelIndexes: state.speculative.lateExcludedPanelIndexes,
      mergePatchContractPrompt,
    };
  }

  // For speculative mode, use the Merge Patch Contract prompt as the judge
  // prompt. For non-speculative mode, keep the existing judge prompt builder.
  const judgePrompt = shouldProceed
    ? (isSpeculative && speculative
      ? speculative.mergePatchContractPrompt
      : buildJudgePromptText({
          task: state.task,
          mode: state.mode,
          context: state.context,
          panel: panelResponses,
          panelMode: state.panelMode,
          quorum,
          contractGate: state.contractGate,
          councilComparison,
          councilComparisonMarkdown,
        }))
    : "";

  const artifactDir = artifactDirFor(cwd, state.runId, state.traceOptions.traceDir);
  const judgeTransport = judgePrompt
    ? await preparePromptTransport({
        kind: "judge",
        canonicalPrompt: judgePrompt,
        artifactDir,
        briefContext: { kind: "judge", panelMode: state.panelMode },
        writeArtifacts: state.traceOptions.saveRunArtifacts !== false,
      })
    : undefined;
  const judgeTransportPrompt = judgeTransport?.inlineTransportPrompt ?? "";
  const judgePromptTransport = judgeTransport?.metadata;

  const updatedState: RunState = {
    ...state,
    panelResults: mergedPanelResults,
    panelResponses,
    panelAttempts,
    quorum,
    judgePrompt,
    judgeTransportPrompt,
    judgePromptTransport,
    councilComparison,
    councilComparisonMarkdown,
    speculative: state.speculative
      ? {
          ...state.speculative,
          mainBaseline: mainBaselineForState,
          panelCandidateTrace: speculative?.panelCandidateTrace,
          overlapObserved: speculative?.overlapObserved,
          overlapDurationMs: speculative?.overlapDurationMs,
          judgeEligibleAt: speculative?.judgeEligibleAt ?? state.speculative.judgeEligibleAt,
          frozenPanelIndexes: speculative?.frozenPanelIndexes ?? state.speculative.frozenPanelIndexes,
          lateExcludedPanelIndexes: speculative?.lateExcludedPanelIndexes ?? state.speculative.lateExcludedPanelIndexes,
          mergePatchContractFullArtifactPath: shouldProceed && isSpeculative
            ? mergePatchContractArtifactPath(cwd, state.runId, state.traceOptions.traceDir)
            : state.speculative.mergePatchContractFullArtifactPath,
        }
      : undefined,
  };
  await writeRunState(updatedState, cwd, options.traceDir);

  if (councilComparisonMarkdown && state.traceOptions.saveRunArtifacts !== false) {
    await writeCouncilComparisonArtifact(councilComparisonMarkdown, cwd, state.runId, options.traceDir);
  }

  const todoUpdates = buildTodoPlan({
    panelModelSpecs: state.panelModelSpecs,
    judgeModelSpec: state.judgeModelSpec,
    command: state.command,
    phase: "collect",
    panelStatuses: panelResponses.map((response) => ({
      success: response.success,
      validationStatus: response.candidateValidationStatus,
    })),
    quorum,
    councilComparison,
    buildStrategy: state.buildStrategy,
    mainBaselineStatus: mainBaselineForState?.status,
  });

  return {
    runId: state.runId,
    shouldProceed,
    reason,
    quorum,
    judgePrompt,
    judgeTransportPrompt,
    judgePromptTransport,
    judgeAgent: state.judgeAgent,
    panelStatus: panelResponses.map((response) => ({
      agentName: agentNameForPanel(state, response),
      modelId: response.modelId,
      success: response.success,
      validationStatus: response.candidateValidationStatus,
      error: response.error,
      errorType: response.errorType,
    })),
    panelAttempts,
    panelLivenessCapability,
    degraded: quorum.degraded,
    todoUpdates,
    councilComparison,
    councilComparisonMarkdown,
    speculative,
  };
}

/**
 * Build the speculative panel candidate trace from the panel responses and
 * candidate workspace info. Each candidate is marked usable/partial/failed
 * based on panel success and candidate validation status.
 */
function buildPanelCandidateTrace(
  state: RunState,
  panelResponses: PanelResponse[],
  candidateWorkspaces: CandidateWorkspaceInfo[],
): SpeculativePanelCandidateTrace[] {
  return candidateWorkspaces.map((ws) => {
    const response = panelResponses[ws.logicalPanelIndex - 1];
    let status: SpeculativePanelCandidateTrace["status"] = "queued";
    if (response) {
      if (!response.success) {
        status = "failed";
      } else if (response.candidateValidationStatus === "passed") {
        status = "usable";
      } else if (response.candidateValidationStatus === "usable_with_warnings") {
        status = "partial";
      } else if (response.candidateValidationStatus === "failed") {
        status = "excluded";
      } else {
        status = "usable";
      }
    }
    return {
      logicalPanelIndex: ws.logicalPanelIndex,
      model: state.panelModelSpecs[ws.logicalPanelIndex - 1]?.modelId ?? "",
      workspacePath: ws.workspacePath,
      reportPath: ws.reportPath,
      patchPath: ws.patchPath,
      status,
    };
  });
}

/**
 * Compute whether main baseline and panel candidate builds actually overlapped
 * in time, based on lifecycle timestamps. Never report overlap without
 * genuinely overlapping timestamps.
 */
function computeOverlapObserved(
  mainBaseline: MainBaselineTrace,
  panelCandidates: SpeculativePanelCandidateTrace[],
  panelAttempts?: PanelAttemptTrace[],
): boolean {
  const mainStart = mainBaseline.startedAt ? Date.parse(mainBaseline.startedAt) : NaN;
  const mainEnd = mainBaseline.completedAt ? Date.parse(mainBaseline.completedAt) : NaN;
  if (!Number.isFinite(mainStart)) return false;
  const mainEndOrNow = Number.isFinite(mainEnd) ? mainEnd : Date.now();
  for (const attempt of panelAttempts ?? []) {
    const start = Date.parse(attempt.startedAt);
    const end = attempt.endedAt ? Date.parse(attempt.endedAt) : NaN;
    if (!Number.isFinite(start)) continue;
    const endOrNow = Number.isFinite(end) ? end : Date.now();
    // Overlap: panel interval [start, endOrNow] intersects main interval [mainStart, mainEndOrNow]
    if (start <= mainEndOrNow && endOrNow >= mainStart) {
      return true;
    }
  }
  // Fallback: if no panel attempts recorded, no overlap can be proven.
  void panelCandidates;
  return false;
}

function computeOverlapDurationMs(
  mainBaseline: MainBaselineTrace,
  panelAttempts?: PanelAttemptTrace[],
): number | undefined {
  const mainStart = mainBaseline.startedAt ? Date.parse(mainBaseline.startedAt) : NaN;
  const mainEnd = mainBaseline.completedAt ? Date.parse(mainBaseline.completedAt) : NaN;
  if (!Number.isFinite(mainStart) || !Number.isFinite(mainEnd)) return undefined;
  let overlapMs = 0;
  for (const attempt of panelAttempts ?? []) {
    const panelStart = Date.parse(attempt.startedAt);
    const panelEnd = attempt.endedAt ? Date.parse(attempt.endedAt) : NaN;
    if (!Number.isFinite(panelStart) || !Number.isFinite(panelEnd)) continue;
    const start = Math.max(mainStart, panelStart);
    const end = Math.min(mainEnd, panelEnd);
    if (end > start) overlapMs += end - start;
  }
  return overlapMs > 0 ? overlapMs : 0;
}

/**
 * Record the main agent's baseline build trace for a speculative parallel
 * build run. The main agent calls this AFTER its independent baseline
 * implementation in the real workspace reaches a terminal state (passed /
 * failed / blocked) and BEFORE the judge is dispatched.
 *
 * This also computes the main baseline changed-files list by diffing the
 * current real workspace state against the Stage 0 source baseline manifest.
 * The diff is honest even when the original workspace was already dirty.
 */
export async function nativeRecordMainBaseline(
  input: NativeRecordMainBaselineInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeRecordMainBaselineResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  const state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  if (!state.speculative) {
    throw new Error("nativeRecordMainBaseline requires a speculative_parallel_build run.");
  }

  const mainBaseline = input.mainBaseline;
  // Compute changed files against the Stage 0 source baseline manifest.
  let changedFiles = mainBaseline.changedFiles;
  let mainBaselineManifestPath = mainBaseline.manifestPath;
  let mainBaselinePatchPath = mainBaseline.patchPath;
  if (state.speculative.sourceBaselineManifestPath) {
    const baseline = await loadBaselineManifest(state.speculative.sourceBaselineManifestPath);
    if (baseline) {
      const diff = await diffAgainstBaseline(state.speculative.sourceWorkspace, baseline);
      changedFiles = [...diff.changedFiles, ...diff.addedFiles, ...diff.removedFiles];
      mainBaselineManifestPath = mainBaselineManifestPath ?? state.speculative.sourceBaselineManifestPath;
      mainBaselinePatchPath = mainBaselinePatchPath ?? mainBaselinePatchArtifactPath(cwd, state.runId, state.traceOptions.traceDir);
    }
  }

  const recorded: MainBaselineTrace = {
    ...mainBaseline,
    startedAt: mainBaseline.startedAt ?? state.speculative.mainBaseline?.startedAt,
    workspacePath: mainBaseline.workspacePath ?? state.speculative.sourceWorkspace,
    changedFiles,
    manifestPath: mainBaselineManifestPath,
    patchPath: mainBaselinePatchPath,
  };

  const updatedState: RunState = {
    ...state,
    speculative: state.speculative ? {
      ...state.speculative,
      mainBaseline: recorded,
      mainBaselineManifestPath,
      mainBaselinePatchPath,
    } : undefined,
  };
  await writeRunState(updatedState, cwd, options.traceDir);

  return {
    runId: state.runId,
    recorded: true,
    mainBaseline: recorded,
    mainBaselineManifestPath,
    mainBaselinePatchPath,
  };
}

export async function nativeFinalize(
  input: NativeFinalizeInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeFinalizeResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  const state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  const traceOptions = state.traceOptions;
  const panel = state.panelResponses ?? [];

  const baseTrace = buildBaseTrace(state, panel);
  const artifactDir = artifactDirFor(cwd, state.runId, traceOptions.traceDir);

  const judgeUnavailableResult = input.judgeOutput
    ? parseFullPromptUnavailable(input.judgeOutput)
    : { unavailable: false as const };
  const judgeUnavailable = judgeUnavailableResult.unavailable;
  if (input.judgeError || !input.judgeOutput || judgeUnavailable) {
    const message = input.judgeError
      ?? (judgeUnavailable
        ? `Judge could not read full canonical context at ${judgeUnavailableResult.unavailable ? judgeUnavailableResult.path : "unknown path"}.`
        : "Judge subagent returned no output.");
    const trace: FusionRunTrace = {
      ...baseTrace,
      judge: {
        modelId: state.judgeModelSpec.modelId,
        success: false,
        error: message,
        reasoningEffort: state.judgeModelSpec.reasoningEffort,
        reasoningEffortApplied: getReasoningEffortApplication(state.judgeModelSpec),
        rawModelSpec: state.judgeModelSpec.raw,
      },
      errors: [message],
    };
    await writeRunArtifacts({
      runId: state.runId,
      cwd,
      traceDir: traceOptions.traceDir,
      task: state.task,
      mode: state.mode,
      panelMode: state.panelMode,
      command: state.command,
      contractGate: state.contractGate,
      context: state.context,
      panelModels: state.panelModelSpecs.map((spec) => spec.modelId),
      judgeModel: state.judgeModelSpec.modelId,
      panelResponses: panel,
      panelPrompts: state.panelModelSpecs.map(() => state.sharedPanelPrompt),
      judgePrompt: state.judgePrompt,
      trace,
    });
    return {
      runId: state.runId,
      executionMode: NATIVE_EXECUTION_MODE,
      success: false,
      error: message,
      artifactDir,
      councilResult: failureCouncilResult(state, message),
      finalGuidance: message,
      trace,
      traceSummary: formatLatestTraceSummary(trace),
    };
  }

  const parsed = parseJudgeResponse(state.mode, input.judgeOutput);
  const requirementDecisionMatrix = parsed.requirementDecisionMatrix
    ?? parseRequirementDecisionMatrixFromJudgeOutput(input.judgeOutput)
    ?? state.requirementDecisionMatrix;
  const judgeStartedMs = state.speculative?.judgeStartedAt ? Date.parse(state.speculative.judgeStartedAt) : NaN;
  const judgeElapsedMs = Number.isFinite(judgeStartedMs)
    ? Math.max(0, Date.now() - judgeStartedMs)
    : undefined;

  const isSpeculative = state.buildStrategy === "speculative_parallel_build" && state.speculative != null;

  // For speculative mode, the judge's output IS the Merge Patch Contract
  // markdown. Parse it into a structured contract and write the artifact.
  let mergePatchContract: MergePatchContract | undefined;
  let mergePatchContractPath: string | undefined;
  let mergePatchDecision: import("../types.js").MergePatchDecision | undefined;
  let speculativeFinalize: import("../types.js").SpeculativeFinalizeResult | undefined;
  if (isSpeculative) {
    mergePatchContract = parseMergePatchContract(input.judgeOutput);
    mergePatchDecision = mergePatchContract.finalDecision;
    mergePatchContractPath = mergePatchContractArtifactPath(cwd, state.runId, traceOptions.traceDir);
    if (state.traceOptions.saveRunArtifacts !== false) {
      await writeArtifactFile(mergePatchContractPath, input.judgeOutput);
    }
    speculativeFinalize = {
      buildStrategy: "speculative_parallel_build",
      mergePatchContractPath,
      mergePatchDecision,
      mergePatchContract,
    };
  }

  const councilResult: CouncilResult = isSpeculative && mergePatchContract
    ? buildCouncilResultFromMergePatchContract(state, mergePatchContract, input.judgeOutput)
    : {
        ...parsed,
        panelMode: state.panelMode,
        panel,
        requirementDecisionMatrix,
        councilComparison: parsed.councilComparison ?? state.councilComparison,
      };
  const baseGuidance = councilResult.finalBuildGuidance || councilResult.finalRecommendation || councilResult.finalOutput;
  const finalGuidance = buildEnhancedFinalGuidance(councilResult, baseGuidance, { ...baseTrace, quorum: state.quorum });

  const trace: FusionRunTrace = {
    ...baseTrace,
    judge: {
      modelId: state.judgeModelSpec.modelId,
      success: true,
      elapsedMs: judgeElapsedMs,
      sessionId: input.judgeSessionId,
      reasoningEffort: state.judgeModelSpec.reasoningEffort,
      reasoningEffortApplied: getReasoningEffortApplication(state.judgeModelSpec),
      rawModelSpec: state.judgeModelSpec.raw,
    },
  };

  const artifactInfo = await writeRunArtifacts({
    runId: state.runId,
    cwd,
    traceDir: traceOptions.traceDir,
    task: state.task,
    mode: state.mode,
    panelMode: state.panelMode,
    command: state.command,
    contractGate: state.contractGate,
    context: state.context,
    panelModels: state.panelModelSpecs.map((spec) => spec.modelId),
    judgeModel: state.judgeModelSpec.modelId,
    panelResponses: panel,
    panelPrompts: state.panelModelSpecs.map(() => state.sharedPanelPrompt),
    judgePrompt: state.judgePrompt,
    judgeOutput: input.judgeOutput,
    finalGuidance,
    councilResult,
    councilComparisonMarkdown: state.councilComparisonMarkdown,
    requirementDecisionMatrix,
    trace,
  });

  const finalTrace: FusionRunTrace = artifactInfo
    ? { ...trace, artifactDir: artifactInfo.artifactDir, artifactPaths: artifactInfo.paths }
    : trace;
  const enrichedTrace = enrichTraceMetadata({
    trace: finalTrace,
    panelResponses: panel,
    finalGuidance,
    judgeOutput: input.judgeOutput,
  });

  // Attach speculative trace fields after enrichment so they survive.
  const speculativeTrace = buildSpeculativeTrace(state, mergePatchContract, mergePatchDecision, mergePatchContractPath);
  const traceWithSpeculative: FusionRunTrace = speculativeTrace
    ? { ...enrichedTrace, speculative: speculativeTrace }
    : enrichedTrace;

  const result: CouncilResult = {
    ...councilResult,
    trace: traceWithSpeculative,
  };

  if (requirementDecisionMatrix && state.traceOptions.saveRunArtifacts !== false) {
    await writeRequirementDecisionMatrixArtifact(
      renderRequirementDecisionMatrixMarkdown(requirementDecisionMatrix),
      cwd,
      state.runId,
      options.traceDir,
    );
  }

  await writeRunState(
    {
      ...state,
      judgeOutput: input.judgeOutput,
      finalGuidance,
      councilResult: result,
      requirementDecisionMatrix,
      speculative: state.speculative ? {
        ...state.speculative,
        mergePatchContractPath,
        mergePatchContractFullArtifactPath: mergePatchContractPath,
        mergePatchDecision,
        mergePatchContract,
        judgeCompletedAt: new Date().toISOString(),
      } : undefined,
    },
    cwd,
    options.traceDir,
  );

  return {
    runId: state.runId,
    executionMode: NATIVE_EXECUTION_MODE,
    success: true,
    artifactDir: artifactInfo?.artifactDir ?? artifactDir,
    artifactPaths: artifactInfo?.paths,
    councilResult: result,
    finalGuidance,
    trace: traceWithSpeculative,
    traceSummary: formatLatestTraceSummary(traceWithSpeculative),
    speculative: speculativeFinalize,
  };
}

/**
 * Build a CouncilResult from a parsed Merge Patch Contract. The contract
 * markdown becomes the final build guidance (the main agent reads it to apply
 * targeted patches). The structured fields populate the standard council
 * result shape so existing trace/artifact machinery keeps working.
 */
function buildCouncilResultFromMergePatchContract(
  state: RunState,
  contract: MergePatchContract,
  judgeOutput: string,
): CouncilResult {
  const approved = selectApprovedPatchItems(contract);
  return {
    mode: state.mode,
    panelMode: state.panelMode,
    buildStrategy: state.buildStrategy,
    decision: contract.finalDecision === "MAIN_BUILD_BLOCKED" ? "do_not_implement" : "implement",
    summary: `Merge Patch Contract: ${contract.finalDecision} (${approved.blockers.length} blockers, ${approved.mustFix.length} must-fix, ${approved.safeAdditions.length} safe additions, ${approved.rejected.length} rejected)`,
    consensus: contract.mainStrengthsToPreserve,
    contradictions: contract.rejectedIdeas.map((r) => r.idea),
    uniqueInsights: contract.adoptedInsights.map((i) => i.idea),
    risks: contract.gaps.filter((g) => g.severity !== "REJECTED").map((g) => g.literalRequirement),
    missingConsiderations: contract.mainBaselineBlockers,
    finalRecommendation: contract.finalDecision,
    requirementChecklist: contract.gaps.filter((g) => g.severity === "BLOCKER" || g.severity === "MUST_FIX").map((g) => g.literalRequirement),
    safeCompatibilityAdditions: contract.gaps.filter((g) => g.severity === "SAFE_ADDITION").map((g) => g.literalRequirement),
    optionalNiceties: [],
    publicSurfaceMatrix: [],
    requiredExternalConsumerProbes: contract.patchPlan.map((p) => `Regression test for ${p.filePath}${p.symbol ? `:${p.symbol}` : ""}`),
    requiredHiddenSemanticProbes: contract.gaps.map((g) => g.requiredRegressionTest).filter((r): r is string => Boolean(r)),
    implementationPriorities: contract.patchPlan.map((p) => `${p.filePath}${p.symbol ? `:${p.symbol}` : ""} — ${p.requiredChange}`),
    packageEntryChecklist: [],
    buildReadyConsumerTestPlan: [],
    rejectedRiskyIdeas: contract.rejectedIdeas.map((r) => `${r.idea} (panel ${r.sourcePanel}: ${r.reason})`),
    finalBuildGuidance: judgeOutput,
    mustNotBreakConstraints: contract.mainStrengthsToPreserve,
    requiredTests: contract.patchPlan.map((p) => p.requiredRegressionTest).filter((r): r is string => Boolean(r)),
    panel: state.panelResponses ?? [],
    finalOutput: judgeOutput,
    councilComparison: state.councilComparison,
  };
}

/**
 * Build the speculative trace section for attachment to the run trace.
 */
function buildSpeculativeTrace(
  state: RunState,
  mergePatchContract: MergePatchContract | undefined,
  mergePatchDecision: import("../types.js").MergePatchDecision | undefined,
  mergePatchContractPath: string | undefined,
): import("../types.js").SpeculativeParallelBuildTrace | undefined {
  if (!state.speculative) return undefined;
  const spec = state.speculative;
  return {
    mode: "speculative_parallel_build",
    sourceWorkspace: spec.sourceWorkspace,
    sourceArtifactDir: spec.sourceArtifactDir,
    externalCandidateStagingDir: spec.externalCandidateStagingDir,
    sourceBaselineManifestPath: spec.sourceBaselineManifestPath,
    parallelExecutionSupported: spec.parallelExecutionSupported,
    overlapObserved: spec.overlapObserved ?? false,
    overlapDurationMs: spec.overlapDurationMs,
    parallelCapabilityLimitation: spec.parallelCapabilityLimitation,
    runtimeCapabilities: state.runtimeCapabilities,
    isolationCapability: spec.isolationCapability,
    pathResolution: spec.pathResolution,
    panelExecutionAssignments: spec.panelExecutionAssignments,
    mainBaseline: spec.mainBaseline ?? {
      status: "blocked",
      workspacePath: spec.sourceWorkspace,
      changedFiles: [],
    },
    panelCandidates: spec.panelCandidateTrace ?? [],
    judgeEligibleAt: spec.judgeEligibleAt,
    judgeStartedAt: spec.judgeStartedAt,
    judgeCompletedAt: spec.judgeCompletedAt,
    frozenPanelIndexes: spec.frozenPanelIndexes,
    lateExcludedPanelIndexes: spec.lateExcludedPanelIndexes,
    mergePatchContractPath,
    mergePatchDecision,
    appliedPatchItems: spec.appliedPatchItems,
  };
}

export async function nativePrepareAudit(
  input: { runId: string },
  options: { cwd: string; traceDir?: string },
): Promise<NativeAuditPrepareResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  const state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  const artifactDir = artifactDirFor(cwd, state.runId, state.traceOptions.traceDir);
  const fixCyclesUsed = state.postBuildAudit?.fixCyclesUsed ?? 0;

  if (state.command !== "fusion-build") {
    return {
      runId: state.runId,
      enabled: false,
      reason: "Post-build contract audit only runs for /fusion-build.",
      artifactDir,
      auditAgent: state.judgeAgent,
      auditPrompt: "",
      auditTransportPrompt: "",
      fixCyclesUsed,
      maxFixCycles: state.maxPostBuildAuditFixCycles,
    };
  }

  if (!state.postBuildContractAudit) {
    return {
      runId: state.runId,
      enabled: false,
      reason: "Post-build contract audit is disabled in Fusion defaults/config.",
      artifactDir,
      auditAgent: state.judgeAgent,
      auditPrompt: "",
      auditTransportPrompt: "",
      fixCyclesUsed,
      maxFixCycles: state.maxPostBuildAuditFixCycles,
    };
  }

  if (!state.finalGuidance || !state.councilResult) {
    return {
      runId: state.runId,
      enabled: false,
      reason: "Judge synthesis must finish before post-build contract audit can run.",
      artifactDir,
      auditAgent: state.judgeAgent,
      auditPrompt: "",
      auditTransportPrompt: "",
      fixCyclesUsed,
      maxFixCycles: state.maxPostBuildAuditFixCycles,
    };
  }

  const auditPrompt = buildPostBuildAuditPrompt({
    task: state.task,
    contractGate: state.contractGate,
    finalGuidance: state.finalGuidance,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
    councilComparisonMarkdown: state.councilComparisonMarkdown,
    requirementDecisionMatrix: state.requirementDecisionMatrix,
  });

  const auditTransport = await preparePromptTransport({
    kind: "audit",
    canonicalPrompt: auditPrompt,
    artifactDir,
    briefContext: { kind: "audit" },
    writeArtifacts: state.traceOptions.saveRunArtifacts !== false,
  });

  await writeRunState({
    ...state,
    postBuildAuditPrompt: auditPrompt,
    postBuildAuditTransportPrompt: auditTransport.inlineTransportPrompt,
    auditPromptTransport: auditTransport.metadata,
  }, cwd, options.traceDir);

  return {
    runId: state.runId,
    enabled: true,
    reason: "Post-build contract audit prepared.",
    artifactDir,
    auditAgent: state.judgeAgent,
    auditPrompt,
    auditTransportPrompt: auditTransport.inlineTransportPrompt,
    auditPromptTransport: auditTransport.metadata,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
  };
}

export async function nativeFinalizeAudit(
  input: NativeAuditFinalizeInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeAuditFinalizeResult> {
  const cwd = options.cwd;
  assertValidFusionRunId(input.runId);
  const locator = resolveRunLocatorPaths(cwd, input.runId, options.traceDir);
  const state = await assertValidFusionRunLocator({
    runId: input.runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  const artifactDir = artifactDirFor(cwd, state.runId, state.traceOptions.traceDir);
  const panel = state.panelResponses ?? [];
  const previousTrace = state.councilResult?.trace ?? buildBaseTrace(state, panel);
  const previousFixCycles = state.postBuildAudit?.fixCyclesUsed ?? 0;

  const auditUnavailableResult = input.auditOutput
    ? parseFullPromptUnavailable(input.auditOutput)
    : { unavailable: false as const };
  const auditUnavailable = auditUnavailableResult.unavailable;
  const auditAvailable = !input.auditError && Boolean(input.auditOutput) && !auditUnavailable;
  const auditResult = input.auditError || !input.auditOutput
    ? buildAuditFailureResult(input.auditError ?? "Post-build audit returned no output.")
    : auditUnavailable
      ? buildAuditFailureResult(
        `Post-build audit could not read full canonical context at ${auditUnavailableResult.unavailable ? auditUnavailableResult.path : "unknown path"}.`,
      )
      : parseContractAuditResponse(input.auditOutput);
  const success = !input.auditError && !auditUnavailable;
  const fixCyclesUsed = success && auditResult.status === "FIX_REQUIRED" ? previousFixCycles + 1 : previousFixCycles;
  const postBuildAudit = {
    enabled: state.postBuildContractAudit,
    sessionId: input.auditSessionId,
    status: auditResult.status === "PASS" ? "pass" as const : "fix_required" as const,
    fixCyclesUsed,
    findings: auditResult.findings,
  };

  const correctnessCoverageGate = buildCorrectnessCoverageGate({
    contractGate: state.contractGate,
    councilComparison: state.councilComparison,
    requirementDecisionMatrix: state.requirementDecisionMatrix,
    auditFindings: auditResult.findings,
    auditDegraded: !auditAvailable,
    auditAvailable,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
  });
  const correctnessCoverageGateMarkdown = renderCorrectnessCoverageGateMarkdown(correctnessCoverageGate);

  const trace: FusionRunTrace = {
    ...previousTrace,
    postBuildAudit,
    councilComparison: state.councilComparison,
    requirementDecisionMatrixSummary: state.requirementDecisionMatrix
      ? {
        entries: state.requirementDecisionMatrix.entries,
        mandatoryCount: state.requirementDecisionMatrix.mandatoryCount,
        safeCompatibilityCount: state.requirementDecisionMatrix.safeCompatibilityCount,
        optionalCount: state.requirementDecisionMatrix.optionalCount,
        rejectedCount: state.requirementDecisionMatrix.rejectedCount,
      }
      : undefined,
    correctnessCoverageGate,
  };

  const artifactInfo = await writeRunArtifacts({
    runId: state.runId,
    cwd,
    traceDir: state.traceOptions.traceDir,
    task: state.task,
    mode: state.mode,
    panelMode: state.panelMode,
    command: state.command,
    contractGate: state.contractGate,
    context: state.context,
    panelModels: state.panelModelSpecs.map((spec) => spec.modelId),
    judgeModel: state.judgeModelSpec.modelId,
    panelResponses: panel,
    panelPrompts: state.panelModelSpecs.map(() => state.sharedPanelPrompt),
    judgePrompt: state.judgePrompt,
    judgeOutput: state.judgeOutput,
    postBuildAuditPrompt: state.postBuildAuditPrompt,
    postBuildAuditOutput: input.auditOutput ?? input.auditError,
    finalGuidance: state.finalGuidance,
    councilResult: state.councilResult,
    councilComparisonMarkdown: state.councilComparisonMarkdown,
    requirementDecisionMatrix: state.requirementDecisionMatrix,
    correctnessCoverageGateMarkdown,
    trace,
  });

  const finalTrace: FusionRunTrace = artifactInfo
    ? { ...trace, artifactDir: artifactInfo.artifactDir, artifactPaths: artifactInfo.paths }
    : trace;
  const enrichedTrace = enrichTraceMetadata({
    trace: finalTrace,
    panelResponses: panel,
    finalGuidance: state.finalGuidance ?? state.councilResult?.finalBuildGuidance ?? state.councilResult?.finalOutput ?? "",
    judgeOutput: state.judgeOutput,
  });

  // For speculative runs, record the applied patch items (the main agent
  // passes them here after applying targeted patches to the real workspace).
  const speculativeAppliedItems = input.appliedPatchItems;
  const traceWithSpeculative: FusionRunTrace = (state.speculative && enrichedTrace.speculative)
    ? {
        ...enrichedTrace,
        speculative: {
          ...enrichedTrace.speculative,
          appliedPatchItems: speculativeAppliedItems ?? enrichedTrace.speculative.appliedPatchItems,
        },
      }
    : (state.speculative && buildSpeculativeTrace(state, state.speculative.mergePatchContract, state.speculative.mergePatchDecision, state.speculative.mergePatchContractPath)
      ? {
          ...enrichedTrace,
          speculative: {
            ...(buildSpeculativeTrace(state, state.speculative.mergePatchContract, state.speculative.mergePatchDecision, state.speculative.mergePatchContractPath) as import("../types.js").SpeculativeParallelBuildTrace),
            appliedPatchItems: speculativeAppliedItems,
          },
        }
      : enrichedTrace);

  const updatedState: RunState = {
    ...state,
    postBuildAuditOutput: input.auditOutput ?? input.auditError,
    postBuildAudit: traceWithSpeculative.postBuildAudit,
    councilResult: state.councilResult ? { ...state.councilResult, trace: traceWithSpeculative, correctnessCoverageGate } : state.councilResult,
    correctnessCoverageGate,
    speculative: state.speculative ? {
      ...state.speculative,
      appliedPatchItems: speculativeAppliedItems ?? state.speculative.appliedPatchItems,
    } : undefined,
  };
  await writeRunState(updatedState, cwd, options.traceDir);

  if (state.traceOptions.saveRunArtifacts !== false) {
    await writeCorrectnessCoverageGateArtifact(correctnessCoverageGateMarkdown, cwd, state.runId, options.traceDir);
  }

  const gateRequiresFix = correctnessCoverageGate.status === "fix_required" || correctnessCoverageGate.status === "degraded";
  const combinedStatus: ContractAuditDecision = auditResult.status === "PASS" && gateRequiresFix
    ? "FIX_REQUIRED"
    : auditResult.status;

  return {
    runId: state.runId,
    success,
    artifactDir,
    trace: traceWithSpeculative,
    traceSummary: formatLatestTraceSummary(traceWithSpeculative),
    status: combinedStatus,
    findings: auditResult.findings,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
    autoFixAllowed: success && combinedStatus === "FIX_REQUIRED" && fixCyclesUsed <= state.maxPostBuildAuditFixCycles,
    finalOutput: auditResult.finalOutput,
    error: input.auditError,
    correctnessCoverageGate,
  };
}

function buildPanelResponsesFromNativeResults(
  state: RunState,
  results: NativePanelResult[],
  config: FusionCouncilConfig,
): PanelResponse[] {
  return state.panelAgents.map((agent) => {
    const result = results.find((entry) => entry.agentName === agent.agentName) ??
      results.find((entry) => entry.modelId === agent.modelId) ??
      results[agent.panelIndex - 1];
    const modelId = agent.modelId;
    const provider = providerLabelForModel(modelId, config, NATIVE_RUNNER);
    const spec = state.panelModelSpecs[agent.panelIndex - 1];
    const effortFields = {
      reasoningEffort: spec?.reasoningEffort,
      reasoningEffortApplied: spec ? getReasoningEffortApplication(spec) : "not_configured" as const,
      rawModelSpec: spec?.raw,
    };
    const identity = modelIdentity(modelId);

    if (!result || result.error || result.content == null) {
      return {
        modelId,
        provider,
        success: false,
        error: result?.error ?? "Panel subagent returned no output.",
        errorType: (result?.errorType ?? "unknown") as ModelErrorType,
        attempts: 1,
        prompt: state.sharedPanelPrompt,
        sessionId: result?.sessionId,
        ...identity,
        ...effortFields,
        latencyMs: 0,
      } satisfies PanelResponse;
    }

    const content = result.content;
    const unavailable = parseFullPromptUnavailable(content);
    if (unavailable.unavailable) {
      return {
        modelId,
        provider,
        success: false,
        error: `Full canonical panel prompt unavailable at ${unavailable.path}.`,
        errorType: "validation" as ModelErrorType,
        attempts: 1,
        prompt: state.panelTransportPrompt ?? state.sharedPanelPrompt,
        content,
        sessionId: result.sessionId,
        ...identity,
        ...effortFields,
        latencyMs: 0,
      } satisfies PanelResponse;
    }

    // A panel that could not safely bind its candidate workspace returns the
    // exact FUSION_CANDIDATE_WORKSPACE_UNUSABLE marker. Treat it as failed —
    // never a usable candidate and never an advisory build report.
    const unusable = parseCandidateWorkspaceUnusable(content);
    if (unusable.unusable) {
      return {
        modelId,
        provider,
        success: false,
        error: `Candidate workspace unusable at ${unusable.path}.`,
        errorType: "validation" as ModelErrorType,
        attempts: 1,
        prompt: state.panelTransportPrompt ?? state.sharedPanelPrompt,
        content,
        sessionId: result.sessionId,
        ...identity,
        ...effortFields,
        latencyMs: 0,
      } satisfies PanelResponse;
    }

    if (state.panelMode === "candidate_build") {
      const validation = validateCandidateOutput(content);
      const success = validation.status !== "failed";
      return {
        modelId,
        provider,
        success,
        content,
        latencyMs: 0,
        attempts: 1,
        prompt: state.sharedPanelPrompt,
        repairAttempted: false,
        candidateValidationPassed: success,
        candidateValidationStatus: validation.status,
        candidateValidationScore: validation.score,
        candidateValidationWarnings: validation.warnings,
        candidateValidationMissingItems: validation.missingSections,
        sessionId: result.sessionId,
        ...identity,
        ...effortFields,
      } satisfies PanelResponse;
    }

    return {
      modelId,
      provider,
      success: true,
      content,
      latencyMs: 0,
      attempts: 1,
      prompt: state.sharedPanelPrompt,
      sessionId: result.sessionId,
      ...identity,
      ...effortFields,
    } satisfies PanelResponse;
  });
}

function computeShouldProceed(
  quorum: FusionTraceQuorum,
  panel: PanelResponse[],
  input: { task: string; mode: CouncilMode; requireAllPanels?: boolean; minSuccessfulPanels?: number; allowDegradedJudge?: boolean },
): boolean {
  if (quorum.usable === 0) return false;
  if (input.requireAllPanels && input.minSuccessfulPanels === undefined) {
    return panel.every((response) => response.success);
  }
  return quorumMeetsRequirement(quorum, input);
}

function computeReason(shouldProceed: boolean, quorum: FusionTraceQuorum, panel: PanelResponse[]): string {
  if (shouldProceed) {
    return quorum.degraded
      ? `Proceeding in degraded mode: ${quorum.usable}/${quorum.total} usable panels (required ${quorum.required}).`
      : `Proceeding with ${quorum.usable}/${quorum.total} usable panels (required ${quorum.required}).`;
  }
  if (quorum.usable === 0) {
    const details = panel.map((response) => `${response.modelId}: ${response.error ?? "unknown"}`).join("; ");
    return `All panel models failed; judge was not run. ${details}`;
  }
  return `Insufficient panel quorum (${quorum.usable}/${quorum.total} usable, required ${quorum.required}); judge was not run.`;
}

function buildBaseTrace(state: RunState, panel: PanelResponse[]): FusionRunTrace {
  return {
    runId: state.runId,
    timestamp: state.timestamp,
    command: state.command,
    commandName: state.command,
    mode: state.mode,
    panelMode: state.panelMode,
    modelSource: "opencode",
    requestedModelSource: "opencode",
    actualModelSource: "opencode",
    fallbackUsed: false,
    executionMode: NATIVE_EXECUTION_MODE,
    sharedPanelPromptPath: state.sharedPanelPromptPath,
    sharedPanelPromptHash: state.sharedPanelPromptHash,
    panelPromptTransport: state.panelPromptTransport,
    judgePromptTransport: state.judgePromptTransport,
    auditPromptTransport: state.auditPromptTransport,
    panelSessions: state.panelAgents.map((agent) => ({
      panelIndex: agent.panelIndex,
      agentName: agent.agentName,
      modelId: agent.modelId,
      promptHash: agent.promptHash,
      nativeTask: true as const,
      sessionId: state.panelResults?.find((result) => result.agentName === agent.agentName)?.sessionId,
      taskId: state.panelResults?.find((result) => result.agentName === agent.agentName)?.taskId,
    })),
    panelAttempts: state.panelAttempts,
    panelLivenessCapability: state.panelLivenessCapability ?? PANEL_LIVENESS_CAPABILITY,
    runtimeCapabilities: state.runtimeCapabilities,
    panelExecutionPlan: state.panelExecutionPlan,
    panelModelsRequested: state.panelModelSpecs,
    judgeModelRequested: state.judgeModelSpec,
    panel: panel.map((entry) => ({
      modelId: entry.modelId,
      success: entry.success,
      error: entry.error,
      errorType: entry.errorType,
      attempts: entry.attempts,
      providerID: entry.providerID,
      modelID: entry.modelID,
      elapsedMs: entry.latencyMs,
      outputCharCount: entry.content?.length ?? 0,
      candidateValidationPassed: entry.candidateValidationPassed,
      candidateValidationStatus: entry.candidateValidationStatus,
      candidateValidationScore: entry.candidateValidationScore,
      candidateValidationWarnings: entry.candidateValidationWarnings,
      repairAttempted: entry.repairAttempted,
      sessionId: entry.sessionId,
      reasoningEffort: entry.reasoningEffort,
      reasoningEffortApplied: entry.reasoningEffortApplied,
      rawModelSpec: entry.rawModelSpec,
    })),
    judge: {
      modelId: state.judgeModelSpec.modelId,
      success: false,
      reasoningEffort: state.judgeModelSpec.reasoningEffort,
      reasoningEffortApplied: getReasoningEffortApplication(state.judgeModelSpec),
      rawModelSpec: state.judgeModelSpec.raw,
    },
    quorum: state.quorum,
    contractGate: summarizeContractGate(state.contractGate),
    postBuildAudit: state.command === "fusion-build"
      ? state.postBuildAudit ?? {
        enabled: state.postBuildContractAudit,
        status: "not_run",
        fixCyclesUsed: 0,
        findings: [],
      }
      : undefined,
    speculative: state.speculative ? {
      mode: "speculative_parallel_build",
      sourceWorkspace: state.speculative.sourceWorkspace,
      sourceArtifactDir: state.speculative.sourceArtifactDir,
      externalCandidateStagingDir: state.speculative.externalCandidateStagingDir,
      sourceBaselineManifestPath: state.speculative.sourceBaselineManifestPath,
      parallelExecutionSupported: state.speculative.parallelExecutionSupported,
      overlapObserved: state.speculative.overlapObserved ?? false,
      overlapDurationMs: state.speculative.overlapDurationMs,
      parallelCapabilityLimitation: state.speculative.parallelCapabilityLimitation,
      runtimeCapabilities: state.runtimeCapabilities,
      isolationCapability: state.speculative.isolationCapability,
      pathResolution: state.speculative.pathResolution,
      panelExecutionAssignments: state.speculative.panelExecutionAssignments,
      mainBaseline: state.speculative.mainBaseline ?? {
        status: "blocked",
        workspacePath: state.speculative.sourceWorkspace,
        changedFiles: [],
      },
      panelCandidates: state.speculative.panelCandidateTrace ?? [],
      judgeEligibleAt: state.speculative.judgeEligibleAt,
      judgeStartedAt: state.speculative.judgeStartedAt,
      judgeCompletedAt: state.speculative.judgeCompletedAt,
      frozenPanelIndexes: state.speculative.frozenPanelIndexes,
      lateExcludedPanelIndexes: state.speculative.lateExcludedPanelIndexes,
      mergePatchContractPath: state.speculative.mergePatchContractPath,
      mergePatchDecision: state.speculative.mergePatchDecision,
      appliedPatchItems: state.speculative.appliedPatchItems,
    } : undefined,
  };
}

function failureCouncilResult(state: RunState, message: string): CouncilResult {
  return {
    mode: state.mode,
    panelMode: state.panelMode,
    buildStrategy: state.buildStrategy,
    decision: "needs_more_info",
    summary: message,
    consensus: [],
    contradictions: [],
    uniqueInsights: [],
    risks: [],
    missingConsiderations: [message],
    finalRecommendation: "Review the judge error and rerun if needed.",
    requirementChecklist: [],
    safeCompatibilityAdditions: [],
    optionalNiceties: [],
    publicSurfaceMatrix: [],
    requiredExternalConsumerProbes: [],
    requiredHiddenSemanticProbes: [],
    implementationPriorities: [],
    packageEntryChecklist: [],
    buildReadyConsumerTestPlan: [],
    rejectedRiskyIdeas: [],
    finalBuildGuidance: message,
    mustNotBreakConstraints: ["Do not implement from a failed judge run."],
    requiredTests: [],
    panel: state.panelResponses ?? [],
    finalOutput: message,
  };
}

function buildAuditFailureResult(message: string): ContractAuditResult {
  return {
    status: "FIX_REQUIRED",
    summary: message,
    findings: [
      {
        requirement: "Post-build contract audit completed successfully.",
        observed: message,
        requiredFix: "Resolve the audit failure or rerun the audit before claiming compliance.",
      },
    ],
    finalOutput: message,
  };
}

function agentNameForPanel(state: RunState, response: PanelResponse): string {
  const match = state.panelAgents.find((agent) => agent.modelId === response.modelId);
  return match?.agentName ?? `fusion-panel-${state.panelAgents.findIndex((agent) => agent.modelId === response.modelId) + 1}`;
}

function modelIdentity(modelId: string): { providerID?: string; modelID?: string } {
  const slash = modelId.indexOf("/");
  if (slash > 0 && slash < modelId.length - 1) {
    return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
  }
  return { modelID: modelId };
}

function artifactDirFor(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId);
}

async function writeCouncilComparisonArtifact(markdown: string, cwd: string, runId: string, traceDir?: string): Promise<string> {
  return writeArtifactFile(councilComparisonArtifactPath(cwd, runId, traceDir), markdown);
}

async function writeRequirementDecisionMatrixArtifact(markdown: string, cwd: string, runId: string, traceDir?: string): Promise<string> {
  return writeArtifactFile(requirementDecisionMatrixArtifactPath(cwd, runId, traceDir), markdown);
}

async function writeCorrectnessCoverageGateArtifact(markdown: string, cwd: string, runId: string, traceDir?: string): Promise<string> {
  return writeArtifactFile(correctnessCoverageGateArtifactPath(cwd, runId, traceDir), markdown);
}

function renderRequirementDecisionMatrixMarkdown(matrix: RequirementDecisionMatrix): string {
  const lines: string[] = ["# Requirement Decision Matrix", ""];
  lines.push(`- Mandatory literal requirements: ${matrix.mandatoryCount}`);
  lines.push(`- Safe compatibility additions: ${matrix.safeCompatibilityCount}`);
  lines.push(`- Optional enhancements: ${matrix.optionalCount}`);
  lines.push(`- Rejected scope expansions: ${matrix.rejectedCount}`);
  lines.push("");
  lines.push("## Entries");
  for (const entry of matrix.entries) {
    lines.push(`### ${entry.requirement}`);
    lines.push(`- Chosen behavior: ${entry.chosenBehavior}`);
    lines.push(`- Why correct: ${entry.whyCorrect}`);
    lines.push(`- Evidence source: ${entry.evidenceSource}`);
    lines.push(`- Required test: ${entry.requiredTest}`);
    lines.push(`- Risk if omitted: ${entry.riskIfOmitted}`);
    lines.push(`- Classification: ${entry.classification}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function resolveTraceOptions(trace?: FusionTraceOptions): Required<Pick<FusionTraceOptions, "saveRunArtifacts" | "keepPanelSessions" | "verboseTrace">> & FusionTraceOptions {
  return {
    saveRunArtifacts: trace?.saveRunArtifacts ?? true,
    keepPanelSessions: trace?.keepPanelSessions ?? false,
    verboseTrace: trace?.verboseTrace ?? false,
    traceDir: trace?.traceDir,
    command: trace?.command,
  };
}

const NATIVE_RUNNER: ModelRunner = {
  source: "opencode",
  async generate() {
    throw new Error("native_subagents mode does not call models through the runner; panels and judge run as native Task subagents.");
  },
};

export function buildTodoPlan(input: {
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  command?: string;
  phase: "prepare" | "collect" | "finalize";
  panelStatuses?: Array<{ success: boolean; validationStatus?: CandidateValidationStatus }>;
  judgeSuccess?: boolean;
  quorum?: FusionTraceQuorum;
  councilComparison?: CouncilComparison;
  buildStrategy?: BuildStrategy;
  mainBaselineStatus?: MainBaselineTrace["status"];
}): NativeTodoItem[] {
  const isBuild = input.command === "fusion-build";
  const isSpeculative = input.buildStrategy === "speculative_parallel_build";
  const items: NativeTodoItem[] = [];
  if (isSpeculative) {
    items.push({ content: "Stage 0: isolate candidate workspaces", status: "completed", priority: "high" });
  }
  items.push({ content: "Build Contract Gate and shared panel prompt", status: "completed", priority: "high" });

  for (let index = 0; index < 3; index += 1) {
    const spec = input.panelModelSpecs[index];
    const label = spec ? spec.modelId : "panel";
    const rolePrefix = isSpeculative ? "Panel candidate build" : "Panel analysis";
    let content = `${rolePrefix} ${index + 1} — ${label}`;
    let status: NativeTodoItem["status"] = "pending";
    if (input.phase !== "prepare" && input.panelStatuses) {
      const panelStatus = input.panelStatuses[index];
      if (panelStatus) {
        status = panelStatus.success ? "completed" : "failed";
        if (panelStatus.success && panelStatus.validationStatus === "usable_with_warnings") {
          content = `${content} (usable with warnings)`;
        }
      }
    }
    items.push({ content, status, priority: "high" });
  }

  if (isSpeculative) {
    let baselineContent = "Main baseline build in real workspace";
    let baselineStatus: NativeTodoItem["status"] = "pending";
    if (input.mainBaselineStatus) {
      if (input.mainBaselineStatus === "passed") {
        baselineStatus = "completed";
        baselineContent = `${baselineContent} — passed`;
      } else if (input.mainBaselineStatus === "failed" || input.mainBaselineStatus === "blocked") {
        baselineStatus = "failed";
        baselineContent = `${baselineContent} — ${input.mainBaselineStatus}`;
      } else if (input.mainBaselineStatus === "running") {
        baselineStatus = "in_progress";
      }
    }
    items.push({ content: baselineContent, status: baselineStatus, priority: "high" });
  }

  let quorumContent = "Validate panel outputs and determine quorum";
  let quorumStatus: NativeTodoItem["status"] = "pending";
  if (input.phase !== "prepare") {
    quorumStatus = "completed";
    if (input.quorum) {
      quorumContent = `${quorumContent} — ${input.quorum.usable}/${input.quorum.total} usable (required ${input.quorum.required})${input.quorum.degraded ? " — degraded" : ""}`;
    }
  }
  items.push({ content: quorumContent, status: quorumStatus, priority: "high" });

  let compareContent = "Compare panel findings and resolve differences";
  let compareStatus: NativeTodoItem["status"] = "pending";
  if (input.phase !== "prepare") {
    compareStatus = "completed";
    if (input.councilComparison) {
      const summary = ` — ${input.councilComparison.commonGround.length} common, ${input.councilComparison.unresolvedDifferences} unresolved, ${input.councilComparison.blindSpots.length} blind spots${input.councilComparison.degraded ? " — degraded" : ""}`;
      compareContent = `${compareContent}${summary}`;
    }
  }
  items.push({ content: compareContent, status: compareStatus, priority: "high" });

  let judgeContent = isSpeculative
    ? `Judge Merge Patch Contract — ${input.judgeModelSpec.modelId}`
    : `Judge synthesis and requirement decision matrix — ${input.judgeModelSpec.modelId}`;
  let judgeStatus: NativeTodoItem["status"] = "pending";
  if (input.phase === "finalize") {
    judgeStatus = input.judgeSuccess === false ? "failed" : "completed";
  }
  items.push({ content: judgeContent, status: judgeStatus, priority: "high" });

  if (isBuild) {
    if (isSpeculative) {
      items.push({ content: "Apply approved targeted patches from Merge Patch Contract", status: "pending", priority: "high" });
    } else {
      items.push({ content: "Implement approved contract", status: "pending", priority: "high" });
      items.push({ content: "Add external consumer probes", status: "pending", priority: "high" });
    }
    items.push({ content: "Run post-build contract audit", status: "pending", priority: "high" });
    items.push({ content: "Run correctness coverage gate", status: "pending", priority: "high" });
    items.push({ content: "Resolve one audit/fix cycle if needed", status: "pending", priority: "high" });
    items.push({ content: "Final verification", status: "pending", priority: "high" });
  }
  return items;
}

export type { CouncilMode, PanelMode, PromptVerbosity, ContextBundle };
