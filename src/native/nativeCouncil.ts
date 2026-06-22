import { collectContext } from "../context/collectContext.js";
import { getDefaultFusionConfig } from "../config.js";
import { getReasoningEffortApplication } from "../modelSpec.js";
import { resolveModels } from "../modelConfig.js";
import { providerLabelForModel } from "../runners/modelRunner.js";
import { extractContractGate, summarizeContractGate } from "../council/contractGate.js";
import { buildPanelPrompt, buildPostBuildAuditPrompt } from "../council/prompts.js";
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
import { hashSharedPanelPrompt, loadRunState, writeRunState, writeSharedPromptArtifact, type RunState } from "./runState.js";
import { FUSION_AGENT_NAMES, FUSION_PANEL_AGENT_NAMES } from "./agentTemplates.js";
import type {
  CandidateValidationStatus,
  ContractAuditResult,
  ContextBundle,
  CouncilMode,
  CouncilResult,
  FusionCouncilConfig,
  FusionModelSpec,
  FusionRunTrace,
  FusionTraceOptions,
  FusionTraceQuorum,
  ModelErrorType,
  ModelRunner,
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
  NativeTodoItem,
  PanelMode,
  PanelResponse,
  PromptVerbosity,
} from "../types.js";
import path from "node:path";

export const NATIVE_EXECUTION_MODE = "native_subagents" as const;

export async function nativePrepare(
  input: NativePrepareInput,
  options: { cwd: string; config?: FusionCouncilConfig; traceDir?: string },
): Promise<NativePrepareResult> {
  const cwd = options.cwd;
  const config = options.config ?? getDefaultFusionConfig();
  const traceOptions = resolveTraceOptions(input.trace);
  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const panelModelSpecs = resolved.panelModels.slice(0, 3);
  while (panelModelSpecs.length < 3) panelModelSpecs.push(panelModelSpecs[0]);
  const judgeModelSpec = resolved.judgeModel;

  const context = await collectContext({ cwd, files: input.files, includeDiff: input.includeDiff });
  const contractGate = extractContractGate(input.task);
  const promptVerbosity = input.promptVerbosity ?? (input.panelMode === "candidate_build" ? "compact" : undefined);
  const sharedPanelPrompt = buildPanelPrompt({
    task: input.task,
    mode: input.mode,
    context,
    panelMode: input.panelMode,
    promptVerbosity,
    contractGate,
  });
  const sharedPanelPromptHash = hashSharedPanelPrompt(sharedPanelPrompt);

  const runId = createRunId();
  const timestamp = new Date().toISOString();
  const sharedPanelPromptPath = await writeSharedPromptArtifact(sharedPanelPrompt, cwd, runId, traceOptions.traceDir);

  const panelAgents: NativePanelAgentPlan[] = FUSION_PANEL_AGENT_NAMES.map((agentName, index) => ({
    panelIndex: index + 1,
    agentName,
    modelId: panelModelSpecs[index].modelId,
    reasoningEffort: panelModelSpecs[index].reasoningEffort,
    promptHash: sharedPanelPromptHash,
    nativeTask: true,
  }));

  const judgeAgent = {
    agentName: FUSION_AGENT_NAMES.judge,
    modelId: judgeModelSpec.modelId,
    reasoningEffort: judgeModelSpec.reasoningEffort,
  };

  const todoPlan = buildTodoPlan({
    panelModelSpecs,
    judgeModelSpec,
    command: input.command,
    phase: "prepare",
  });

  const state: RunState = {
    runId,
    timestamp,
    command: input.command,
    task: input.task,
    mode: input.mode,
    panelMode: input.panelMode,
    context,
    contractGate,
    panelModelSpecs,
    judgeModelSpec,
    sharedPanelPrompt,
    sharedPanelPromptHash,
    sharedPanelPromptPath,
    panelAgents,
    judgeAgent,
    requireAllPanels: input.requireAllPanels,
    minSuccessfulPanels: input.minSuccessfulPanels,
    allowDegradedJudge: input.allowDegradedJudge,
    promptVerbosity,
    traceOptions,
    postBuildContractAudit: config.defaults.postBuildContractAudit,
    maxPostBuildAuditFixCycles: config.defaults.maxPostBuildAuditFixCycles,
  };
  await writeRunState(state, cwd, traceOptions.traceDir);

  return {
    executionMode: NATIVE_EXECUTION_MODE,
    runId,
    artifactDir: artifactDirFor(cwd, runId, traceOptions.traceDir),
    sharedPanelPrompt,
    sharedPanelPromptHash,
    sharedPanelPromptPath,
    panelAgents,
    judgeAgent,
    todoPlan,
    mode: input.mode,
    panelMode: input.panelMode,
    task: input.task,
  };
}

export async function nativeCollect(
  input: { runId: string; panelResults: NativePanelResult[] },
  options: { cwd: string; traceDir?: string },
): Promise<NativeCollectResult> {
  const cwd = options.cwd;
  const state = await loadRunState(cwd, input.runId, options.traceDir);
  const config = getDefaultFusionConfig();
  const panelResponses = buildPanelResponsesFromNativeResults(state, input.panelResults, config);
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

  const judgePrompt = shouldProceed
    ? buildJudgePromptText({
        task: state.task,
        mode: state.mode,
        context: state.context,
        panel: panelResponses,
        panelMode: state.panelMode,
        quorum,
        contractGate: state.contractGate,
      })
    : "";

  const updatedState: RunState = {
    ...state,
    panelResults: input.panelResults,
    panelResponses,
    quorum,
    judgePrompt,
  };
  await writeRunState(updatedState, cwd, options.traceDir);

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
  });

  return {
    runId: state.runId,
    shouldProceed,
    reason,
    quorum,
    judgePrompt,
    judgeAgent: state.judgeAgent,
    panelStatus: panelResponses.map((response) => ({
      agentName: agentNameForPanel(state, response),
      modelId: response.modelId,
      success: response.success,
      validationStatus: response.candidateValidationStatus,
      error: response.error,
      errorType: response.errorType,
    })),
    degraded: quorum.degraded,
    todoUpdates,
  };
}

export async function nativeFinalize(
  input: NativeFinalizeInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeFinalizeResult> {
  const cwd = options.cwd;
  const state = await loadRunState(cwd, input.runId, options.traceDir);
  const traceOptions = state.traceOptions;
  const panel = state.panelResponses ?? [];

  const baseTrace = buildBaseTrace(state, panel);
  const artifactDir = artifactDirFor(cwd, state.runId, traceOptions.traceDir);

  if (input.judgeError || !input.judgeOutput) {
    const message = input.judgeError ?? "Judge subagent returned no output.";
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
  const judgeStarted = Date.now();
  const judgeElapsedMs = Date.now() - judgeStarted;
  const councilResult: CouncilResult = {
    ...parsed,
    panelMode: state.panelMode,
    panel,
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

  const result: CouncilResult = {
    ...councilResult,
    trace: enrichedTrace,
  };

  await writeRunState(
    {
      ...state,
      judgeOutput: input.judgeOutput,
      finalGuidance,
      councilResult: result,
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
    trace: enrichedTrace,
    traceSummary: formatLatestTraceSummary(enrichedTrace),
  };
}

export async function nativePrepareAudit(
  input: { runId: string },
  options: { cwd: string; traceDir?: string },
): Promise<NativeAuditPrepareResult> {
  const cwd = options.cwd;
  const state = await loadRunState(cwd, input.runId, options.traceDir);
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
  });

  await writeRunState({ ...state, postBuildAuditPrompt: auditPrompt }, cwd, options.traceDir);

  return {
    runId: state.runId,
    enabled: true,
    reason: "Post-build contract audit prepared.",
    artifactDir,
    auditAgent: state.judgeAgent,
    auditPrompt,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
  };
}

export async function nativeFinalizeAudit(
  input: NativeAuditFinalizeInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeAuditFinalizeResult> {
  const cwd = options.cwd;
  const state = await loadRunState(cwd, input.runId, options.traceDir);
  const artifactDir = artifactDirFor(cwd, state.runId, state.traceOptions.traceDir);
  const panel = state.panelResponses ?? [];
  const previousTrace = state.councilResult?.trace ?? buildBaseTrace(state, panel);
  const previousFixCycles = state.postBuildAudit?.fixCyclesUsed ?? 0;

  const auditResult = input.auditError || !input.auditOutput
    ? buildAuditFailureResult(input.auditError ?? "Post-build audit returned no output.")
    : parseContractAuditResponse(input.auditOutput);
  const success = !input.auditError;
  const fixCyclesUsed = success && auditResult.status === "FIX_REQUIRED" ? previousFixCycles + 1 : previousFixCycles;
  const postBuildAudit = {
    enabled: state.postBuildContractAudit,
    sessionId: input.auditSessionId,
    status: auditResult.status === "PASS" ? "pass" as const : "fix_required" as const,
    fixCyclesUsed,
    findings: auditResult.findings,
  };

  const trace: FusionRunTrace = {
    ...previousTrace,
    postBuildAudit,
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

  const updatedState: RunState = {
    ...state,
    postBuildAuditOutput: input.auditOutput ?? input.auditError,
    postBuildAudit: enrichedTrace.postBuildAudit,
    councilResult: state.councilResult ? { ...state.councilResult, trace: enrichedTrace } : state.councilResult,
  };
  await writeRunState(updatedState, cwd, options.traceDir);

  return {
    runId: state.runId,
    success,
    artifactDir,
    trace: enrichedTrace,
    traceSummary: formatLatestTraceSummary(enrichedTrace),
    status: auditResult.status,
    findings: auditResult.findings,
    fixCyclesUsed,
    maxFixCycles: state.maxPostBuildAuditFixCycles,
    autoFixAllowed: success && auditResult.status === "FIX_REQUIRED" && fixCyclesUsed <= state.maxPostBuildAuditFixCycles,
    finalOutput: auditResult.finalOutput,
    error: input.auditError,
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
    panelSessions: state.panelAgents.map((agent) => ({
      panelIndex: agent.panelIndex,
      agentName: agent.agentName,
      modelId: agent.modelId,
      promptHash: agent.promptHash,
      nativeTask: true as const,
      sessionId: state.panelResults?.find((result) => result.agentName === agent.agentName)?.sessionId,
      taskId: state.panelResults?.find((result) => result.agentName === agent.agentName)?.taskId,
    })),
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
  };
}

function failureCouncilResult(state: RunState, message: string): CouncilResult {
  return {
    mode: state.mode,
    panelMode: state.panelMode,
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
}): NativeTodoItem[] {
  const isBuild = input.command === "fusion-build";
  const items: NativeTodoItem[] = [];
  items.push({ content: "Build Contract Gate and shared panel prompt", status: "completed", priority: "high" });

  for (let index = 0; index < 3; index += 1) {
    const spec = input.panelModelSpecs[index];
    const label = spec ? spec.modelId : "panel";
    let content = `Panel ${index + 1} analysis — ${label}`;
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

  let quorumContent = "Validate panel outputs and determine quorum";
  let quorumStatus: NativeTodoItem["status"] = "pending";
  if (input.phase !== "prepare") {
    quorumStatus = "completed";
    if (input.quorum) {
      quorumContent = `${quorumContent} — ${input.quorum.usable}/${input.quorum.total} usable (required ${input.quorum.required})${input.quorum.degraded ? " — degraded" : ""}`;
    }
  }
  items.push({ content: quorumContent, status: quorumStatus, priority: "high" });

  let judgeStatus: NativeTodoItem["status"] = "pending";
  if (input.phase === "finalize") {
    judgeStatus = input.judgeSuccess === false ? "failed" : "completed";
  }
  items.push({ content: `Judge synthesis — ${input.judgeModelSpec.modelId}`, status: judgeStatus, priority: "high" });

  if (isBuild) {
    items.push({ content: "Implement approved plan", status: "pending", priority: "high" });
    items.push({ content: "Create or update contract-focused consumer tests", status: "pending", priority: "high" });
    items.push({ content: "Post-build contract audit", status: "pending", priority: "high" });
    items.push({ content: "Resolve contract audit findings", status: "pending", priority: "high" });
    items.push({ content: "Final verification", status: "pending", priority: "high" });
  }
  return items;
}

export type { CouncilMode, PanelMode, PromptVerbosity, ContextBundle };
