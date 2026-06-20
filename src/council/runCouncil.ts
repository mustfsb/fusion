import { collectContext } from "../context/collectContext.js";
import { getDefaultFusionConfig } from "../config.js";
import { formatModelSpecTraceLine } from "../modelSpec.js";
import { resolveModelRunner } from "../runners/modelRunner.js";
import type {
  CouncilResult,
  CouncilRunInput,
  CouncilRunOptions,
  FusionModelSpec,
  FusionRunTrace,
  FusionTraceOptions,
  FusionTraceQuorum,
  FusionTraceQuorumFailedPanel,
  ModelSource,
  PanelResponse,
} from "../types.js";
import { errorMessage } from "../utils/errors.js";
import { FusionCouncilError } from "../utils/errors.js";
import { runJudge } from "./judge.js";
import { runPanel } from "./panel.js";
import {
  buildJudgePromptText,
  buildPanelPrompts,
  createRunId,
  formatLatestTraceSummary,
  writeRunArtifacts,
} from "../trace/runTrace.js";

export async function runCouncil(input: CouncilRunInput, options: CouncilRunOptions): Promise<CouncilResult> {
  const config = options.config ?? getDefaultFusionConfig();
  const { panelModelSpecs, judgeModelSpec } = resolveCouncilModelSpecs(input, config);
  const requestedModelSource = input.modelSource ?? options.modelSource ?? "auto";
  const traceOptions = mergeTraceOptions(input.trace, options.trace);
  const cwd = options.cwd ?? process.cwd();
  const runId = createRunId();
  const timestamp = new Date().toISOString();
  const modelRunner = options.modelRunner ?? resolveModelRunner({
    modelSource: requestedModelSource,
    config,
    opencodeRunner: options.opencodeRunner,
    modelClientFactory: options.modelClientFactory,
  });
  const context = input.context ?? (options.noContext
    ? { summary: "Context collection disabled.", files: [], omitted: [] }
    : await collectContext({ cwd, files: input.files, includeDiff: input.includeDiff }));

  const promptVerbosity = input.promptVerbosity ?? (input.panelMode === "candidate_build" ? "compact" : undefined);
  const panelPrompts = buildPanelPrompts({
    task: input.task,
    mode: input.mode,
    context,
    panelMode: input.panelMode,
    panelModels: panelModelSpecs.map((spec) => spec.modelId),
    promptVerbosity,
  });

  const panel = await runPanel({
    task: input.task,
    mode: input.mode,
    context,
    modelSpecs: panelModelSpecs,
    config,
    modelRunner,
    panelMode: input.panelMode,
    promptVerbosity,
    timeoutMs: input.panelTimeoutMs,
    maxAttempts: input.panelMaxAttempts,
    repairMaxAttempts: input.repairMaxAttempts,
    repairTimeoutMs: input.repairTimeoutMs,
    keepPanelSessions: traceOptions.keepPanelSessions,
  });

  const quorum = buildQuorum(panel, input, panelModelSpecs.length);
  const baseTrace = buildTrace({
    runId,
    timestamp,
    command: traceOptions.command,
    mode: input.mode,
    panelMode: input.panelMode,
    requestedModelSource,
    actualModelSource: modelRunner.source,
    panelModelSpecs,
    judgeModelSpec,
    panel,
    quorum,
  });

  if (quorum.usable === 0) {
    const details = panel.map((response) => formatPanelFailure(response)).join("; ");
    await maybeWriteFailedTrace({
      traceOptions,
      cwd,
      runId,
      timestamp,
      input,
      context,
      panelModelSpecs,
      judgeModelSpec,
      panel,
      panelPrompts,
      trace: { ...baseTrace, errors: [`All panel models failed: ${details}`] },
    });
    throw new FusionCouncilError(`All panel models failed; judge was not run. ${details}${formatArtifactHint(baseTrace)}`);
  }

  if (input.requireAllPanels && input.minSuccessfulPanels === undefined) {
    const failedPanels = panel.filter((response) => !response.success);
    if (failedPanels.length > 0) {
      const details = failedPanels.map((response) => formatPanelFailure(response)).join("; ");
      await maybeWriteFailedTrace({
        traceOptions,
        cwd,
        runId,
        timestamp,
        input,
        context,
        panelModelSpecs,
        judgeModelSpec,
        panel,
        panelPrompts,
        trace: { ...baseTrace, errors: [`Required panel models failed: ${details}`] },
      });
      throw new FusionCouncilError(`Required panel models failed; judge was not run. ${details}${formatArtifactHint(baseTrace)}`);
    }
  } else if (!quorumMeetsRequirement(quorum, input)) {
    const details = quorum.failedPanels.map((entry) => formatQuorumFailure(entry)).join("; ");
    await maybeWriteFailedTrace({
      traceOptions,
      cwd,
      runId,
      timestamp,
      input,
      context,
      panelModelSpecs,
      judgeModelSpec,
      panel,
      panelPrompts,
      trace: { ...baseTrace, errors: [`Insufficient panel quorum (${quorum.usable}/${quorum.required} usable): ${details}`] },
    });
    throw new FusionCouncilError(`Insufficient panel quorum (${quorum.usable}/${quorum.required} usable); judge was not run. ${details}${formatArtifactHint(baseTrace)}`);
  }

  const judgePrompt = buildJudgePromptText({
    task: input.task,
    mode: input.mode,
    context,
    panel,
    panelMode: input.panelMode,
    quorum,
  });

  try {
    const judgeStarted = Date.now();
    const result = await runJudge({
      task: input.task,
      mode: input.mode,
      context,
      panel,
      judgeModelSpec,
      config,
      modelRunner,
      panelMode: input.panelMode,
      timeoutMs: input.judgeTimeoutMs,
      keepSession: traceOptions.keepPanelSessions,
      judgePrompt,
      quorum,
    });
    const judgeElapsedMs = Date.now() - judgeStarted;
    const trace: FusionRunTrace = {
      ...baseTrace,
      judge: {
        modelId: judgeModelSpec.modelId,
        success: true,
        elapsedMs: judgeElapsedMs,
        sessionId: result.judgeSessionId,
        reasoningEffort: result.judgeReasoningEffort,
        reasoningEffortApplied: result.judgeReasoningEffortApplied,
        rawModelSpec: result.judgeRawModelSpec,
      },
    };
    const finalGuidance = result.finalBuildGuidance || result.finalRecommendation || result.finalOutput;
    const artifactInfo = await maybeWriteSuccessTrace({
      traceOptions,
      cwd,
      runId,
      timestamp,
      input,
      context,
      panelModelSpecs,
      judgeModelSpec,
      panel,
      panelPrompts,
      judgePrompt,
      judgeOutput: result.judgeRawOutput,
      finalGuidance,
      councilResult: result,
      trace,
    });
    return {
      ...result,
      trace: artifactInfo ? { ...trace, artifactDir: artifactInfo.artifactDir, artifactPaths: artifactInfo.paths } : trace,
    };
  } catch (error) {
    const message = errorMessage(error);
    const trace: FusionRunTrace = {
      ...baseTrace,
      judge: { modelId: judgeModelSpec.modelId, success: false, error: message },
      errors: [message],
    };
    await maybeWriteFailedTrace({
      traceOptions,
      cwd,
      runId,
      timestamp,
      input,
      context,
      panelModelSpecs,
      judgeModelSpec,
      panel,
      panelPrompts,
      judgePrompt,
      trace,
    });
    throw new FusionCouncilError(`Judge model '${judgeModelSpec.modelId}' failed after panel completion. ${message}. ${formatTraceForError(trace)}`);
  }
}

export function resolveMinSuccessfulPanels(input: CouncilRunInput, totalPanels: number): number {
  if (input.minSuccessfulPanels !== undefined) return Math.max(1, input.minSuccessfulPanels);
  if (input.requireAllPanels) return totalPanels;
  return Math.min(2, totalPanels);
}

export function buildQuorum(panel: PanelResponse[], input: CouncilRunInput, totalPanels: number): FusionTraceQuorum {
  const required = resolveMinSuccessfulPanels(input, totalPanels);
  const usable = panel.filter((response) => response.success).length;
  const failedPanels = panel
    .filter((response) => !response.success)
    .map((response) => buildFailedPanelDiagnostic(response));

  return {
    required,
    usable,
    total: totalPanels,
    degraded: usable < totalPanels && usable >= required,
    failedPanels,
  };
}

export function quorumMeetsRequirement(quorum: FusionTraceQuorum, input: CouncilRunInput): boolean {
  if (quorum.usable >= quorum.required) return true;
  if (quorum.usable === 1 && quorum.required === 1 && input.allowDegradedJudge !== false) return true;
  return false;
}

function buildFailedPanelDiagnostic(response: PanelResponse): FusionTraceQuorumFailedPanel {
  const snippet = response.content?.trim().slice(0, 500);
  return {
    modelId: response.modelId,
    errorType: response.errorType,
    elapsedMs: response.latencyMs,
    validationFailureReason: response.errorType === "validation"
      ? response.error ?? response.candidateValidationMissingItems?.join(", ")
      : response.error,
    repairAttempted: response.repairAttempted,
    repairSucceeded: response.repairAttempted ? response.success : undefined,
    outputSnippet: snippet || undefined,
  };
}

function formatQuorumFailure(entry: FusionTraceQuorumFailedPanel): string {
  return `${entry.modelId}: type=${entry.errorType ?? "unknown"}; elapsedMs=${entry.elapsedMs ?? "unknown"}; repairAttempted=${entry.repairAttempted ? "yes" : "no"}; ${entry.validationFailureReason ?? "unknown error"}`;
}

export function formatCouncilResultMarkdown(result: CouncilResult): string {
  if (result.panelMode === "candidate_build") return formatCandidateBuildMarkdown(result);
  if (result.panelMode === "advisory") return formatAdvisoryMarkdown(result);
  return [
    "# Fusion Council Result",
    "",
    `**Mode:** ${result.mode}`,
    result.decision ? `**Decision:** ${result.decision}` : undefined,
    "",
    "## Summary",
    result.summary,
    "",
    "## Consensus",
    formatList(result.consensus),
    "",
    "## Contradictions",
    formatList(result.contradictions),
    "",
    "## Unique Insights",
    formatList(result.uniqueInsights),
    "",
    "## Risks",
    formatList(result.risks),
    "",
    "## Missing Considerations",
    formatList(result.missingConsiderations),
    "",
    "## Final Recommendation",
    result.finalRecommendation,
    "",
    "## Final Output",
    result.finalOutput,
    "",
    "## Requirement Checklist",
    formatList(result.requirementChecklist),
    "",
    "## Rejected Risky Ideas",
    formatList(result.rejectedRiskyIdeas),
    "",
    "## Final Build Guidance",
    result.finalBuildGuidance || result.finalRecommendation,
    "",
    "## Must-Not-Break Constraints",
    formatList(result.mustNotBreakConstraints),
    "",
    "## Required Tests",
    formatList(result.requiredTests),
    "",
    ...formatFusionTrace(result),
    "",
    "## Panel Status",
    ...result.panel.map((entry) => `- ${entry.modelId}: ${entry.success ? "succeeded" : "failed"} (${entry.latencyMs}ms${entry.attempts ? `, attempts=${entry.attempts}` : ""})${entry.error ? ` - ${entry.error}` : ""}`),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function resolveCouncilModelSpecs(input: CouncilRunInput, config: ReturnType<typeof getDefaultFusionConfig>): {
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
} {
  if (input.panelModelSpecs) {
    return {
      panelModelSpecs: input.panelModelSpecs,
      judgeModelSpec: input.judgeModelSpec
        ?? (input.judgeModel ? { modelId: input.judgeModel } : { modelId: config.defaults.judgeModel }),
    };
  }
  return {
    panelModelSpecs: input.panelModels?.map((modelId) => ({ modelId }))
      ?? config.defaults.panelModels.map((modelId) => ({ modelId })),
    judgeModelSpec: input.judgeModelSpec
      ?? (input.judgeModel ? { modelId: input.judgeModel } : { modelId: config.defaults.judgeModel }),
  };
}

function buildTrace(input: {
  runId: string;
  timestamp: string;
  command?: string;
  mode: CouncilResult["mode"];
  panelMode?: CouncilResult["panelMode"];
  requestedModelSource: ModelSource;
  actualModelSource: FusionRunTrace["actualModelSource"];
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  panel: CouncilResult["panel"];
  quorum?: FusionTraceQuorum;
}): FusionRunTrace {
  return {
    runId: input.runId,
    timestamp: input.timestamp,
    command: input.command,
    mode: input.mode,
    panelMode: input.panelMode,
    modelSource: input.requestedModelSource,
    requestedModelSource: input.requestedModelSource,
    actualModelSource: input.actualModelSource,
    fallbackUsed: input.requestedModelSource === "auto" && input.actualModelSource === "direct",
    panelModelsRequested: input.panelModelSpecs,
    judgeModelRequested: input.judgeModelSpec,
    panel: input.panel.map((entry) => ({
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
      modelId: input.judgeModelSpec.modelId,
      success: false,
      reasoningEffort: input.judgeModelSpec.reasoningEffort,
      reasoningEffortApplied: input.judgeModelSpec.reasoningEffort ? "unsupported" : "not_configured",
      rawModelSpec: input.judgeModelSpec.raw,
    },
    quorum: input.quorum,
  };
}

function formatFusionTrace(result: CouncilResult): string[] {
  if (!result.trace) return [];
  const quorumLine = result.trace.quorum
    ? `**Quorum:** ${result.trace.quorum.usable}/${result.trace.quorum.total} usable (required ${result.trace.quorum.required})${result.trace.quorum.degraded ? " — degraded mode" : ""}`
    : undefined;
  return [
    "## Fusion Run Trace",
    `**Run ID:** ${result.trace.runId}`,
    result.trace.artifactDir ? `**Artifact path:** ${result.trace.artifactDir}` : undefined,
    quorumLine,
    "",
    "## Fusion Model Trace",
    `**Requested model source:** ${result.trace.requestedModelSource}`,
    `**Actual model source:** ${result.trace.actualModelSource}`,
    `**Fallback used:** ${result.trace.fallbackUsed ? "yes" : "no"}`,
    "",
    "## Panel Model Trace",
    ...result.trace.panelModelsRequested.map((spec, index) => `- ${formatModelSpecTraceLine(spec, `Panel ${index + 1}`, spec.reasoningEffort ? "unsupported" : "not_configured")}`),
    ...result.trace.panel.map((entry) => `  - status ${entry.modelId}: ${entry.success ? "succeeded" : "failed"}${entry.attempts ? ` attempts=${entry.attempts}` : ""}${entry.elapsedMs !== undefined ? ` elapsedMs=${entry.elapsedMs}` : ""}${entry.outputCharCount !== undefined ? ` chars=${entry.outputCharCount}` : ""}${entry.candidateValidationPassed !== undefined ? ` candidateValidation=${entry.candidateValidationPassed ? "passed" : "failed"}` : ""}${entry.candidateValidationStatus ? ` status=${entry.candidateValidationStatus}` : ""}${entry.repairAttempted ? " repairAttempted=yes" : ""}${entry.reasoningEffort ? ` configuredEffort=${entry.reasoningEffort}` : ""}${entry.reasoningEffortApplied === "unsupported" ? " appliedEffort=unsupported" : ""}${entry.errorType ? ` type=${entry.errorType}` : ""}${entry.providerID ? ` providerID=${entry.providerID}` : ""}${entry.modelID ? ` modelID=${entry.modelID}` : ""}${entry.error ? ` - ${entry.error}` : ""}`),
    "",
    "## Judge Model Trace",
    `- ${formatModelSpecTraceLine(result.trace.judgeModelRequested, "Judge", result.trace.judgeModelRequested.reasoningEffort ? "unsupported" : "not_configured")}`,
    `**Judge status:** ${result.trace.judge.success ? "succeeded" : "failed"}${result.trace.judge.elapsedMs !== undefined ? ` elapsedMs=${result.trace.judge.elapsedMs}` : ""}${result.trace.judge.error ? ` - ${result.trace.judge.error}` : ""}`,
    result.trace.artifactPaths?.trace ? `\nOpen raw artifacts under \`${result.trace.artifactDir}\` or inspect \`${result.trace.artifactPaths.trace}\`.` : undefined,
  ].filter((line): line is string => line !== undefined);
}

function formatCandidateBuildMarkdown(result: CouncilResult): string {
  const quorumWarning = result.trace?.quorum?.degraded
    ? ["## Council Quorum Status", `- Usable panels: ${result.trace.quorum.usable}/${result.trace.quorum.total}`, `- Failed panels: ${result.trace.quorum.failedPanels.map((entry) => entry.modelId).join(", ") || "none"}`, "- Confidence: reduced — verify with tests before trusting synthesis", ""]
    : [];
  return [
    "# Fusion Council Result",
    "",
    `**Mode:** ${result.mode}`,
    result.decision ? `**Decision:** ${result.decision}` : undefined,
    "",
    "## Summary",
    result.summary,
    "",
    ...quorumWarning,
    ...formatFusionTrace(result),
    "",
    "## Panel Candidate Summary",
    formatPanelAssessments(result.panelAssessments ?? []),
    "",
    ...formatCandidateAssessments(result.panelAssessments ?? []),
    "## Judge Decision",
    result.finalRecommendation,
    "",
    "## Requirement Checklist",
    formatList(result.requirementChecklist),
    "",
    "## Rejected Risky Ideas",
    formatList(result.rejectedRiskyIdeas),
    "",
    "## Final Build Guidance",
    result.finalBuildGuidance || result.finalRecommendation,
    "",
    "## Must-Not-Break Constraints",
    formatList(result.mustNotBreakConstraints),
    "",
    "## Required Tests",
    formatList(result.requiredTests),
    "",
    "## Final Compliance Checklist",
    formatList(result.finalComplianceChecklist ?? []),
    "",
    "## Known Traps",
    formatList(result.knownTraps ?? []),
    "",
    "## Implementation Plan",
    formatList(result.implementationPlan ?? []),
    "",
    "## Test Plan",
    formatList(result.testPlan ?? []),
    "",
    "## Main Agent Implementation Instructions",
    ...mainAgentImplementationInstructions(result.trace?.quorum?.degraded),
    "",
    "## Final Output",
    result.finalOutput,
    "",
    "## Panel Status",
    ...result.panel.map((entry) => `- ${entry.modelId}: ${entry.success ? "succeeded" : "failed"} (${entry.latencyMs}ms${entry.attempts ? `, attempts=${entry.attempts}` : ""}${entry.candidateValidationPassed !== undefined ? `, candidateValidation=${entry.candidateValidationPassed ? "passed" : "failed"}` : ""}${entry.candidateValidationStatus ? `, status=${entry.candidateValidationStatus}` : ""}${entry.repairAttempted ? ", repairAttempted=yes" : ""})${entry.error ? ` - ${entry.error}` : ""}`),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatAdvisoryMarkdown(result: CouncilResult): string {
  const quorumWarning = result.trace?.quorum?.degraded
    ? ["## Council Quorum Status", `- Usable panels: ${result.trace.quorum.usable}/${result.trace.quorum.total}`, `- Failed panels: ${result.trace.quorum.failedPanels.map((entry) => entry.modelId).join(", ") || "none"}`, "- Confidence: reduced — verify with tests", ""]
    : [];
  return [
    "# Fusion Council Result",
    "",
    `**Mode:** ${result.mode}`,
    result.decision ? `**Decision:** ${result.decision}` : undefined,
    "",
    "## Summary",
    result.summary,
    "",
    ...quorumWarning,
    ...formatFusionTrace(result),
    "",
    "## Panel Advisory Summary",
    formatPanelAssessments(result.panelAssessments ?? []),
    "",
    "## Judge Recommendation",
    result.finalRecommendation,
    "",
    "## Requirement Checklist",
    formatList(result.requirementChecklist),
    "",
    "## Risks",
    formatList(result.risks),
    "",
    "## Implementation Plan",
    formatList(result.implementationPlan ?? []),
    "",
    "## Test Plan",
    formatList(result.testPlan ?? []),
    "",
    "## Recommended Build Prompt",
    result.recommendedBuildPrompt || "- None",
    "",
    "## Rejected Risky Ideas",
    formatList(result.rejectedRiskyIdeas),
    "",
    "## Must-Not-Break Constraints",
    formatList(result.mustNotBreakConstraints),
    "",
    "## Main Agent Implementation Instructions",
    ...mainAgentImplementationInstructions(result.trace?.quorum?.degraded),
    "- After judge succeeds, implement the original user task automatically.",
    "- Use the original prompt as the source of truth.",
    "- Use the advisory council output as the implementation contract.",
    "- Include in final response which judge hidden-edge checks were implemented as tests.",
    "- Do not wait for a manual second message.",
    "",
    "## Final Output",
    result.finalOutput,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function mainAgentImplementationInstructions(degraded?: boolean): string[] {
  const degradedNote = degraded
    ? ["- Council ran in degraded/quorum mode with fewer than all panels — be conservative and must verify with tests."]
    : [];
  return [
    "- Implement the original user task, not the council output alone.",
    "- Treat the original prompt as source of truth; use the Requirement Ledger and judge output as implementation contract.",
    "- Preserve explicit public API, error, edge-case, determinism, and serialization contracts exactly.",
    "- Before finishing, implement the judge's Required Hidden Tests or equivalent coverage.",
    "- Do not accept visible-test-only success if hidden probes or the literal task would still fail.",
    ...degradedNote,
    "- If existing visible tests conflict with the explicit task contract, update the implementation and tests to match the original user task.",
    "- Verify contract-critical edge cases before final response.",
    "- Run npm run typecheck, npm test, and npm run build when the task requires them.",
    "- Final response must include: Fusion run ID, trace artifact path, files created, test count, verification results, hidden-edge tests added, known limitations, and design trade-offs.",
  ];
}

function formatPanelAssessments(items: CouncilResult["panelAssessments"]): string {
  const values = items ?? [];
  return values.length ? values.map((item) => `- ${item.modelId}: ${item.summary || "No summary provided."}`).join("\n") : "- None";
}

function formatCandidateAssessments(items: CouncilResult["panelAssessments"]): string[] {
  const values = items ?? [];
  return values.flatMap((item, index) => [
    `## Candidate ${index + 1} Strengths/Weaknesses`,
    `**Model:** ${item.modelId}`,
    "**Strengths**",
    formatList(item.strengths),
    "**Weaknesses**",
    formatList(item.weaknesses),
    "",
  ]);
}

function formatTraceForError(trace: FusionRunTrace): string {
  const quorumPart = trace.quorum ? `quorum=${trace.quorum.usable}/${trace.quorum.total}(required=${trace.quorum.required},degraded=${trace.quorum.degraded ? "yes" : "no"}),` : "";
  return [
    `Fusion trace: runId=${trace.runId}`,
    trace.artifactDir ? `artifactDir=${trace.artifactDir}` : undefined,
    `requested modelSource=${trace.requestedModelSource}`,
    `actual modelSource=${trace.actualModelSource}`,
    `fallbackUsed=${trace.fallbackUsed ? "yes" : "no"}`,
    quorumPart,
    `panel=${trace.panel.map((entry) => `${entry.modelId}:${entry.success ? "success" : `failed(type=${entry.errorType ?? "unknown"},providerID=${entry.providerID ?? "unknown"},modelID=${entry.modelID ?? "unknown"},attempts=${entry.attempts ?? "unknown"},elapsedMs=${entry.elapsedMs ?? "unknown"},candidateValidation=${entry.candidateValidationPassed ?? "n/a"},repairAttempted=${entry.repairAttempted ? "yes" : "no"},error=${entry.error ?? "unknown"})`}`).join(",")}`,
    `judge=${trace.judge.modelId}:${trace.judge.success ? "success" : `failed(${trace.judge.error ?? "unknown"})`}`,
  ].filter(Boolean).join("; ");
}

function formatPanelFailure(response: CouncilResult["panel"][number]): string {
  return `${response.modelId}: type=${response.errorType ?? "unknown"}; providerID=${response.providerID ?? "unknown"}; modelID=${response.modelID ?? "unknown"}; attempts=${response.attempts ?? 1}; elapsedMs=${response.latencyMs}; candidateValidation=${response.candidateValidationPassed ?? "n/a"}; repairAttempted=${response.repairAttempted ? "yes" : "no"}; ${response.error ?? "unknown error"}`;
}

function formatArtifactHint(trace: FusionRunTrace): string {
  return trace.artifactDir ? ` Artifact path: ${trace.artifactDir}` : "";
}

function mergeTraceOptions(input?: FusionTraceOptions, options?: FusionTraceOptions): {
  saveRunArtifacts: boolean;
  keepPanelSessions: boolean;
  verboseTrace: boolean;
  traceDir?: string;
  command?: string;
} {
  return {
    saveRunArtifacts: input?.saveRunArtifacts ?? options?.saveRunArtifacts ?? true,
    keepPanelSessions: input?.keepPanelSessions ?? options?.keepPanelSessions ?? false,
    traceDir: input?.traceDir ?? options?.traceDir,
    verboseTrace: input?.verboseTrace ?? options?.verboseTrace ?? false,
    command: input?.command ?? options?.command,
  };
}

async function maybeWriteSuccessTrace(input: {
  traceOptions: ReturnType<typeof mergeTraceOptions>;
  cwd: string;
  runId: string;
  timestamp: string;
  input: CouncilRunInput;
  context: CouncilResult["panel"] extends infer _ ? import("../types.js").ContextBundle : never;
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  panel: CouncilResult["panel"];
  panelPrompts: string[];
  judgePrompt: string;
  judgeOutput?: string;
  finalGuidance: string;
  councilResult?: CouncilResult;
  trace: FusionRunTrace;
}) {
  if (!input.traceOptions.saveRunArtifacts) return undefined;
  return writeRunArtifacts({
    runId: input.runId,
    cwd: input.cwd,
    traceDir: input.traceOptions.traceDir,
    task: input.input.task,
    mode: input.input.mode,
    panelMode: input.input.panelMode,
    command: input.traceOptions.command,
    context: input.context,
    panelModels: input.panelModelSpecs.map((spec) => spec.modelId),
    judgeModel: input.judgeModelSpec.modelId,
    panelResponses: input.panel,
    panelPrompts: input.panelPrompts,
    judgePrompt: input.judgePrompt,
    judgeOutput: input.judgeOutput,
    finalGuidance: input.finalGuidance,
    councilResult: input.councilResult,
    trace: input.trace,
  });
}

async function maybeWriteFailedTrace(input: {
  traceOptions: ReturnType<typeof mergeTraceOptions>;
  cwd: string;
  runId: string;
  timestamp: string;
  input: CouncilRunInput;
  context: import("../types.js").ContextBundle;
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  panel: CouncilResult["panel"];
  panelPrompts: string[];
  judgePrompt?: string;
  trace: FusionRunTrace;
}) {
  if (!input.traceOptions.saveRunArtifacts) return;
  await writeRunArtifacts({
    runId: input.runId,
    cwd: input.cwd,
    traceDir: input.traceOptions.traceDir,
    task: input.input.task,
    mode: input.input.mode,
    panelMode: input.input.panelMode,
    command: input.traceOptions.command,
    context: input.context,
    panelModels: input.panelModelSpecs.map((spec) => spec.modelId),
    judgeModel: input.judgeModelSpec.modelId,
    panelResponses: input.panel,
    panelPrompts: input.panelPrompts,
    judgePrompt: input.judgePrompt,
    trace: input.trace,
  });
}

export { formatLatestTraceSummary };