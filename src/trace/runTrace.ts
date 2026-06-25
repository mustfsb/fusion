import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ContractGate, CouncilComparison, CouncilMode, CouncilResult, FusionRunTrace, PanelMode, PanelResponse, RequirementDecisionMatrix } from "../types.js";
import { validateCandidateOutput } from "../council/candidateValidation.js";
import { renderContractGate } from "../council/contractGate.js";
import { sanitizeText } from "../context/sanitize.js";
import { buildJudgePrompt, buildPanelPrompt } from "../council/prompts.js";
import { formatModelSpecTraceLine } from "../modelSpec.js";
import type { ContextBundle } from "../types.js";

export const DEFAULT_TRACE_DIR = ".opencode/fusion-runs";
export const LATEST_TRACE_POINTER = "latest-run.json";

export function createRunId(now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const suffix = randomBytes(3).toString("hex");
  return `fusion-${stamp}-${suffix}`;
}

export function createRecoveredRunId(now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const suffix = randomBytes(3).toString("hex");
  return `fusion-${stamp}-recovered-${suffix}`;
}

export function resolveTraceRoot(cwd: string, traceDir?: string): string {
  return path.resolve(cwd, traceDir ?? DEFAULT_TRACE_DIR);
}

export function detectGuidanceSections(text: string): {
  requirementLedger: boolean;
  contractGate: boolean;
  publicSurfaceMatrix: boolean;
  externalConsumerProbes: boolean;
  hiddenSemanticProbes: boolean;
  hiddenTests: boolean;
  packageChecklist: boolean;
  packageEntryChecklist: boolean;
  immutabilityChecklist: boolean;
  typedErrorChecklist: boolean;
  rejectedRiskyIdeas: boolean;
  mainAgentExecutionRequirements: boolean;
  selfAuditChecklist: boolean;
  finalBuildContract: boolean;
  buildReadyContractPacket: boolean;
} {
  const lower = text.toLowerCase();
  return {
    requirementLedger: /requirement ledger|non-negotiable acceptance tests/i.test(text),
    contractGate: /contract gate/i.test(text),
    publicSurfaceMatrix: /public surface matrix/i.test(text),
    externalConsumerProbes: /required external consumer probes|external consumer probe plan|build-ready external consumer test plan|required consumer probes/i.test(text),
    hiddenSemanticProbes: /required hidden semantic probes|hidden semantic probe plan|hidden semantic tests/i.test(text),
    hiddenTests: /required hidden tests?|hidden (?:edge )?probe|hidden tests? to write/i.test(text),
    packageChecklist: /package\/build checklist|packaging\/build checklist|package\.json.*main|verification checklist/i.test(lower),
    packageEntryChecklist: /package entry checklist/i.test(lower),
    immutabilityChecklist: /immutability|mutable internal|live internal|public reads return clones/i.test(lower),
    typedErrorChecklist: /typed error|typed-error|domain error|raw error.*leak/i.test(lower),
    rejectedRiskyIdeas: /ideas? to reject|rejected risky|risky\/speculative ideas rejected/i.test(lower),
    mainAgentExecutionRequirements: /main-agent execution requirements|main agent execution requirements|build-ready use notes/i.test(lower),
    selfAuditChecklist: /self-audit|pre-final self-audit/i.test(lower),
    finalBuildContract: /final build contract|final implementation contract/i.test(lower),
    buildReadyContractPacket: /build-ready contract packet/i.test(lower),
  };
}

export function detectJudgeOutputSections(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["candidate summary table", /candidate summary table/i],
    ["spec compliance verdict", /spec compliance verdict/i],
    ["contract gate", /contract gate/i],
    ["common ground", /common ground/i],
    ["key differences", /key differences/i],
    ["unique additions", /unique additions/i],
    ["partial coverage and blind spots", /partial coverage and blind spots/i],
    ["requirement decision matrix", /requirement decision matrix/i],
    ["executive decision summary", /executive decision summary/i],
    ["scope boundaries", /scope boundaries/i],
    ["public surface matrix", /public surface matrix/i],
    ["required external consumer probes", /required external consumer probes|required consumer probes|external consumer test plan/i],
    ["required hidden semantic probes", /required hidden semantic probes|hidden semantic tests|hidden semantic test plan/i],
    ["implementation priorities", /implementation priorities|implementation order/i],
    ["package entry checklist", /package entry checklist/i],
    ["build-ready contract packet", /build-ready contract packet/i],
    ["candidate bug audit", /candidate bug audit/i],
    ["best ideas to use", /best ideas to use/i],
    ["ideas to reject", /ideas to reject/i],
    ["rejected or deferred ideas", /rejected or deferred ideas/i],
    ["final build contract", /final build contract/i],
    ["spec-literal interpretation", /spec-literal interpretation/i],
    ["required hidden tests", /required hidden tests?|main-agent test obligations/i],
    ["consensus plan", /consensus plan/i],
    ["disagreements", /disagreements between panels/i],
    ["exact API checklist", /exact api checklist/i],
    ["exact semantic checklist", /exact semantic checklist/i],
    ["hidden edge probe checklist", /hidden edge probe checklist/i],
    ["typed error checklist", /typed error checklist/i],
    ["immutability checklist", /immutability\/safety checklist|immutability checklist/i],
    ["determinism checklist", /determinism checklist/i],
    ["final implementation contract", /final implementation contract/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function buildEnhancedFinalGuidance(result: CouncilResult, baseGuidance: string, trace?: FusionRunTrace): string {
  const sections = detectGuidanceSections(baseGuidance);
  const extras: string[] = [];
  const quorum = trace?.quorum ?? result.trace?.quorum;
  const externalConsumerProbes = result.requiredExternalConsumerProbes?.length
    ? result.requiredExternalConsumerProbes
    : result.buildReadyConsumerTestPlan ?? [];
  const hiddenSemanticProbes = result.requiredHiddenSemanticProbes?.length
    ? result.requiredHiddenSemanticProbes
    : result.requiredTests;
  const executionSectionTitle = result.panelMode === "advisory" ? "## Build-Ready Use Notes" : "## Main-Agent Execution Requirements";
  const comparison = result.councilComparison ?? trace?.councilComparison;
  const decisionMatrix = result.requirementDecisionMatrix;

  if (result.panelMode === "advisory" && !sections.buildReadyContractPacket) {
    extras.push("## Build-Ready Contract Packet", "- Use this packet as the build contract for a later `/fusion-build` run.");
  }
  if ((result.requirementChecklist.length || result.safeCompatibilityAdditions?.length || result.optionalNiceties?.length) && !sections.contractGate) {
    extras.push(
      "## Contract Gate",
      ...(result.requirementChecklist.length ? ["### Mandatory Literal Requirements", ...result.requirementChecklist.map((item) => `- ${item}`)] : ["### Mandatory Literal Requirements", "- None listed."]),
      ...(result.safeCompatibilityAdditions?.length ? ["### Safe Compatibility Additions", ...result.safeCompatibilityAdditions.map((item) => `- ${item}`)] : []),
      ...(result.optionalNiceties?.length ? ["### Optional Niceties", ...result.optionalNiceties.map((item) => `- ${item}`)] : []),
    );
  } else if (result.requirementChecklist.length && !sections.requirementLedger && !sections.contractGate) {
    extras.push("## Requirement Ledger", ...result.requirementChecklist.map((item) => `- ${item}`));
  }
  if (comparison && comparison.commonGround.length > 0 && !/common ground/i.test(baseGuidance)) {
    extras.push(
      "## Common Ground",
      ...comparison.commonGround.slice(0, 8).map((entry) => `- ${entry.topic} (panels ${entry.supportedBy.join(", ")}; confidence=${entry.confidence})`),
    );
  }
  if (comparison && comparison.keyDifferences.length > 0 && !/key differences/i.test(baseGuidance)) {
    extras.push(
      "## Key Differences",
      ...comparison.keyDifferences.slice(0, 8).map((entry) => `- ${entry.topic} → ${entry.requiredDecision}`),
    );
  }
  if (comparison && comparison.uniqueAdditions.length > 0 && !/unique additions/i.test(baseGuidance)) {
    extras.push(
      "## Unique Additions",
      ...comparison.uniqueAdditions.slice(0, 8).map((entry) => `- ${entry.idea} (panel ${entry.proposedBy}; ${entry.classification}; ${entry.recommendation})`),
    );
  }
  if (comparison && (comparison.partialCoverage.length > 0 || comparison.blindSpots.length > 0) && !/partial coverage|blind spots/i.test(baseGuidance)) {
    extras.push("## Partial Coverage and Blind Spots");
    for (const entry of comparison.partialCoverage.slice(0, 6)) extras.push(`- Partial: ${entry.requirement} → ${entry.requiredFollowUp}`);
    for (const entry of comparison.blindSpots.slice(0, 6)) extras.push(`- Blind spot: ${entry.risk} → ${entry.requiredTestOrAudit}`);
  }
  if (decisionMatrix && decisionMatrix.entries.length > 0 && !/requirement decision matrix/i.test(baseGuidance)) {
    extras.push(
      "## Requirement Decision Matrix",
      ...decisionMatrix.entries.slice(0, 12).map((entry) => `- ${entry.requirement} → ${entry.chosenBehavior} (${entry.classification}; test=${entry.requiredTest || "none"})`),
    );
  }
  if (result.publicSurfaceMatrix?.length && !sections.publicSurfaceMatrix) {
    extras.push("## Public Surface Matrix", ...result.publicSurfaceMatrix.map((item) => `- ${item}`));
  }
  if (externalConsumerProbes.length && !sections.externalConsumerProbes) {
    extras.push(
      result.panelMode === "advisory" ? "## Build-Ready External Consumer Test Plan" : "## Required External Consumer Probes",
      ...externalConsumerProbes.map((item) => `- ${item}`),
    );
  }
  if (hiddenSemanticProbes.length && !sections.hiddenSemanticProbes && !sections.hiddenTests) {
    extras.push(
      result.panelMode === "advisory" ? "## Hidden Semantic Tests" : "## Required Hidden Semantic Probes",
      ...hiddenSemanticProbes.map((item) => `- ${item}`),
    );
  }
  if (result.packageEntryChecklist?.length && !sections.packageEntryChecklist) {
    extras.push("## Package Entry Checklist", ...result.packageEntryChecklist.map((item) => `- ${item}`));
  }
  if (result.rejectedRiskyIdeas.length && !sections.rejectedRiskyIdeas) {
    extras.push("## Rejected Risky Ideas", ...result.rejectedRiskyIdeas.map((item) => `- ${item}`));
  }
  if (result.requiredTests.length && !sections.hiddenTests && sections.hiddenSemanticProbes) {
    extras.push("## Required Hidden Tests", ...result.requiredTests.map((item) => `- ${item}`));
  }
  if (result.finalComplianceChecklist?.length && !sections.packageChecklist) {
    extras.push("## Package / Build / Compliance Checklist", ...result.finalComplianceChecklist.map((item) => `- ${item}`));
  }
  if (result.knownTraps?.length) {
    extras.push("## Known Traps", ...result.knownTraps.map((item) => `- ${item}`));
  }

  if (!sections.mainAgentExecutionRequirements) {
    extras.push(
      executionSectionTitle,
      "- Treat the original user task as authoritative; if it conflicts with the packet, the original task wins.",
      "- Preserve explicit public API, error, edge-case, normalization, and serialization contracts exactly.",
      "- Verify package-root exports and published-entry consumer imports before claiming compliance.",
      "- Do not accept visible-test-only success if hidden probes or the literal task would still fail.",
      ...(result.panelMode === "advisory"
        ? ["- `/fusion-no-build` stops here. Use this packet for a later build; do not implement from this output inside the planning run."]
        : [
          "- Before finishing, implement the required external-consumer probes and hidden semantic probes or equivalent coverage.",
          "- Run npm run typecheck, npm test, and npm run build when the task requires them.",
        ]),
    );
  }

  if (quorum?.degraded) {
    extras.push(
      "## Council Quorum Warning",
      `- Judge ran with ${quorum.usable}/${quorum.total} usable panels (required ${quorum.required}).`,
      `- Failed panels: ${quorum.failedPanels.map((entry) => entry.modelId).join(", ") || "none"}.`,
      "- Be conservative. Must verify with tests before trusting synthesis.",
    );
  }

  if (!sections.selfAuditChecklist) {
    extras.push(
      "## Self-Audit Checklist",
      "- All required package-root exports and typed errors are exported from the published entry.",
      "- Instance methods were not substituted for literal package-root export requirements.",
      "- package.json main and types resolve to actual built files.",
      "- Whitespace-only values are rejected when the task requires non-empty strings.",
      "- Typed errors are used where required.",
      "- Public getters, snapshots, audits, and diffs do not leak tokens, secrets, or mutable internal state unless explicitly required.",
      ...(result.panelMode === "advisory"
        ? ["- Package-entry consumer probes are ready to implement during the later build run."]
        : ["- Hidden tests and consumer-facing probes from judge guidance are implemented where practical.", "- npm run typecheck, npm test, and npm run build are run if requested."]),
    );
  }

  const needsExtras = !sections.finalBuildContract
    || !sections.contractGate
    || !sections.publicSurfaceMatrix
    || !sections.externalConsumerProbes
    || !sections.packageEntryChecklist
    || (!sections.contractGate && !sections.requirementLedger)
    || (!sections.hiddenTests && !sections.hiddenSemanticProbes)
    || !sections.packageChecklist
    || !sections.rejectedRiskyIdeas
    || !sections.mainAgentExecutionRequirements
    || !sections.selfAuditChecklist
    || (comparison && (comparison.commonGround.length > 0 || comparison.keyDifferences.length > 0))
    || (decisionMatrix && decisionMatrix.entries.length > 0);

  if (!needsExtras && extras.length <= 1) return baseGuidance;

  const header = sections.finalBuildContract || sections.buildReadyContractPacket
    ? ""
    : result.panelMode === "advisory"
      ? `## Build-Ready Contract Packet\n${result.finalBuildGuidance || result.finalRecommendation || baseGuidance}`
      : `## Final Build Contract\n${result.finalBuildGuidance || result.finalRecommendation || baseGuidance}`;
  return [baseGuidance, header, ...extras].filter(Boolean).join("\n\n");
}

export function enrichTraceMetadata(input: {
  trace: FusionRunTrace;
  panelResponses: PanelResponse[];
  finalGuidance: string;
  judgeOutput?: string;
}): FusionRunTrace {
  const guidanceSections = detectGuidanceSections(input.finalGuidance);
  const judgeSections = detectJudgeOutputSections(input.judgeOutput ?? input.finalGuidance);

  const perPanel = input.panelResponses.map((panel) => {
    const validation = panel.content && input.trace.panelMode === "candidate_build"
      ? validateCandidateOutput(panel.content)
      : undefined;
    return {
      modelId: panel.modelId,
      passed: panel.candidateValidationPassed ?? panel.success,
      status: panel.candidateValidationStatus,
      score: validation?.score ?? panel.candidateValidationScore,
      warnings: panel.candidateValidationWarnings ?? validation?.warnings,
      missingItems: panel.candidateValidationMissingItems ?? validation?.missingSections,
      repairAttempted: panel.repairAttempted,
      repairSucceeded: panel.repairAttempted ? panel.candidateValidationPassed === true : undefined,
    };
  });

  const repairAttempted = perPanel.some((entry) => entry.repairAttempted);
  const repairSucceeded = repairAttempted ? perPanel.every((entry) => !entry.repairAttempted || entry.repairSucceeded) : undefined;
  const scores = perPanel.map((entry) => entry.score).filter((score): score is number => score !== undefined);
  const artifactFiles = input.trace.artifactPaths
    ? Object.values(input.trace.artifactPaths).filter((value): value is string => typeof value === "string")
    : undefined;

  return {
    ...input.trace,
    commandName: input.trace.command,
    candidateValidation: input.trace.panelMode === "candidate_build"
      ? { allPassed: perPanel.every((entry) => entry.passed), perPanel }
      : undefined,
    repairAttempted: input.trace.panelMode === "candidate_build" ? repairAttempted : undefined,
    repairSucceeded: input.trace.panelMode === "candidate_build" ? repairSucceeded : undefined,
    panelOutputCompletenessScore: scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : undefined,
    judgeOutputSectionsDetected: judgeSections,
    finalGuidanceContainsHiddenTests: guidanceSections.hiddenTests || guidanceSections.hiddenSemanticProbes || judgeSections.includes("required hidden tests") || judgeSections.includes("required hidden semantic probes"),
    finalGuidanceContainsPackageChecklist: guidanceSections.packageChecklist || guidanceSections.packageEntryChecklist,
    finalGuidanceContainsImmutabilityChecklist: guidanceSections.immutabilityChecklist || judgeSections.includes("immutability checklist"),
    finalGuidanceContainsTypedErrorChecklist: guidanceSections.typedErrorChecklist || judgeSections.includes("typed error checklist"),
    councilComparison: input.trace.councilComparison,
    requirementDecisionMatrixSummary: input.trace.requirementDecisionMatrixSummary,
    correctnessCoverageGate: input.trace.correctnessCoverageGate,
    artifactFiles,
  };
}

export type RunArtifactInput = {
  runId: string;
  cwd: string;
  traceDir?: string;
  task: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
  command?: string;
  contractGate?: ContractGate;
  context: ContextBundle;
  panelModels: string[];
  judgeModel: string;
  panelResponses: PanelResponse[];
  panelPrompts: string[];
  judgePrompt?: string;
  judgeOutput?: string;
  postBuildAuditPrompt?: string;
  postBuildAuditOutput?: string;
  finalGuidance?: string;
  councilResult?: CouncilResult;
  councilComparisonMarkdown?: string;
  requirementDecisionMatrix?: RequirementDecisionMatrix;
  correctnessCoverageGateMarkdown?: string;
  trace: FusionRunTrace;
};

export async function writeRunArtifacts(input: RunArtifactInput): Promise<{ artifactDir: string; paths: FusionRunTrace["artifactPaths"] }> {
  const artifactDir = path.join(resolveTraceRoot(input.cwd, input.traceDir), input.runId);
  await mkdir(artifactDir, { recursive: true });

  const finalGuidancePath = path.join(artifactDir, "final-guidance.md");
  const paths: NonNullable<FusionRunTrace["artifactPaths"]> = {
    trace: path.join(artifactDir, "trace.json"),
    originalPrompt: path.join(artifactDir, "original-prompt.md"),
    finalGuidance: finalGuidancePath,
  };

  await writeFile(paths.originalPrompt, sanitizeText(input.task), "utf8");

  if (input.contractGate) {
    paths.contractGate = path.join(artifactDir, "contract-gate.md");
    await writeFile(paths.contractGate, sanitizeText(renderContractGate(input.contractGate)), "utf8");
  }

  for (let index = 0; index < input.panelResponses.length; index += 1) {
    const panelNumber = index + 1;
    const promptPath = path.join(artifactDir, `panel-${panelNumber}-prompt.md`);
    const outputPath = path.join(artifactDir, `panel-${panelNumber}-output.md`);
    paths[`panel${panelNumber}Prompt` as keyof typeof paths] = promptPath;
    paths[`panel${panelNumber}Output` as keyof typeof paths] = outputPath;
    await writeFile(promptPath, sanitizeText(input.panelPrompts[index] ?? ""), "utf8");
    await writeFile(outputPath, sanitizeText(input.panelResponses[index]?.content ?? input.panelResponses[index]?.error ?? ""), "utf8");
  }

  if (input.judgePrompt) {
    paths.judgePrompt = path.join(artifactDir, "judge-prompt.md");
    await writeFile(paths.judgePrompt, sanitizeText(input.judgePrompt), "utf8");
  }
  if (input.judgeOutput) {
    paths.judgeOutput = path.join(artifactDir, "judge-output.md");
    await writeFile(paths.judgeOutput, sanitizeText(input.judgeOutput), "utf8");
  }
  if (input.postBuildAuditPrompt) {
    paths.postBuildAuditPrompt = path.join(artifactDir, "post-build-audit-prompt.md");
    await writeFile(paths.postBuildAuditPrompt, sanitizeText(input.postBuildAuditPrompt), "utf8");
  }
  if (input.postBuildAuditOutput) {
    paths.postBuildAuditOutput = path.join(artifactDir, "post-build-audit-output.md");
    await writeFile(paths.postBuildAuditOutput, sanitizeText(input.postBuildAuditOutput), "utf8");
  }
  if (input.councilComparisonMarkdown) {
    paths.councilComparison = path.join(artifactDir, "council-comparison.md");
    await writeFile(paths.councilComparison, sanitizeText(input.councilComparisonMarkdown), "utf8");
  }
  if (input.requirementDecisionMatrix) {
    paths.requirementDecisionMatrix = path.join(artifactDir, "requirement-decision-matrix.md");
    await writeFile(paths.requirementDecisionMatrix, sanitizeText(renderRequirementDecisionMatrixMarkdown(input.requirementDecisionMatrix)), "utf8");
  }
  if (input.correctnessCoverageGateMarkdown) {
    paths.correctnessCoverageGate = path.join(artifactDir, "correctness-coverage-gate.md");
    await writeFile(paths.correctnessCoverageGate, sanitizeText(input.correctnessCoverageGateMarkdown), "utf8");
  }

  const baseGuidance = input.finalGuidance ?? "";
  const enhancedGuidance = input.councilResult
    ? buildEnhancedFinalGuidance(input.councilResult, baseGuidance, input.trace)
    : baseGuidance;

  if (enhancedGuidance) {
    await writeFile(finalGuidancePath, sanitizeText(enhancedGuidance), "utf8");
  }

  const traceWithPaths: FusionRunTrace = {
    ...input.trace,
    artifactDir,
    artifactPaths: paths,
  };
  const enrichedTrace = enrichTraceMetadata({
    trace: traceWithPaths,
    panelResponses: input.panelResponses,
    finalGuidance: enhancedGuidance || baseGuidance,
    judgeOutput: input.judgeOutput,
  });

  await writeFile(paths.trace, `${JSON.stringify(enrichedTrace, null, 2)}\n`, "utf8");

  const latestPointer = {
    runId: input.runId,
    artifactDir,
    timestamp: input.trace.timestamp,
    command: input.trace.command,
    commandName: input.trace.command,
    panelMode: input.trace.panelMode,
  };
  await writeFile(path.join(resolveTraceRoot(input.cwd, input.traceDir), LATEST_TRACE_POINTER), `${JSON.stringify(latestPointer, null, 2)}\n`, "utf8");

  return { artifactDir, paths };
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

export async function loadLatestRunTrace(cwd: string, traceDir?: string): Promise<FusionRunTrace | null> {
  const pointerPath = path.join(resolveTraceRoot(cwd, traceDir), LATEST_TRACE_POINTER);
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { artifactDir?: string; runId?: string };
    if (!pointer.artifactDir && !pointer.runId) {
      return null;
    }
    const tracePath = pointer.artifactDir
      ? path.join(pointer.artifactDir, "trace.json")
      : path.join(resolveTraceRoot(cwd, traceDir), pointer.runId!, "trace.json");
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as FusionRunTrace;
    return trace;
  } catch {
    return null;
  }
}

export function formatLatestTraceSummary(trace: FusionRunTrace): string {
  const speculativeSection = trace.speculative ? renderSpeculativeTraceSection(trace.speculative) : [];
  return [
    "# Fusion Latest Run Trace",
    "",
    `**Run ID:** ${trace.runId}`,
    `**Timestamp:** ${trace.timestamp}`,
    trace.command ? `**Command:** ${trace.command}` : undefined,
    trace.panelMode ? `**Panel mode:** ${trace.panelMode}` : undefined,
    trace.speculative ? `**Build strategy:** ${trace.speculative.mode}` : undefined,
    `**Artifact directory:** ${trace.artifactDir ?? "unknown"}`,
    `**Model source:** ${trace.modelSource}`,
    trace.executionMode ? `**Execution mode:** ${trace.executionMode}` : undefined,
    trace.sharedPanelPromptHash ? `**Shared panel prompt hash:** ${trace.sharedPanelPromptHash}` : undefined,
    trace.sharedPanelPromptPath ? `**Shared panel prompt path:** ${trace.sharedPanelPromptPath}` : undefined,
    trace.panelPromptTransport ? `**Panel prompt transport:** ${trace.panelPromptTransport.mode} (canonical ${trace.panelPromptTransport.canonicalLineCount} lines, inline ${trace.panelPromptTransport.inlineLineCount} lines)` : undefined,
    trace.panelPromptTransport?.fullArtifactPath ? `**Panel full artifact:** ${trace.panelPromptTransport.fullArtifactPath}` : undefined,
    trace.panelPromptTransport?.briefArtifactPath ? `**Panel brief artifact:** ${trace.panelPromptTransport.briefArtifactPath}` : undefined,
    trace.judgePromptTransport ? `**Judge prompt transport:** ${trace.judgePromptTransport.mode} (canonical ${trace.judgePromptTransport.canonicalLineCount} lines, inline ${trace.judgePromptTransport.inlineLineCount} lines)` : undefined,
    trace.auditPromptTransport ? `**Audit prompt transport:** ${trace.auditPromptTransport.mode} (canonical ${trace.auditPromptTransport.canonicalLineCount} lines, inline ${trace.auditPromptTransport.inlineLineCount} lines)` : undefined,
    trace.panelExecutionPlan ? `**Panel cascade:** staggered=${trace.panelExecutionPlan.staggered ? "yes" : "no"}; startGate=${trace.panelExecutionPlan.startGateTimeoutMs}ms; inactivity=${trace.panelExecutionPlan.inactivityTimeoutMs}ms; maxAttempts=${trace.panelExecutionPlan.maxAttemptsPerPanel}` : undefined,
    trace.panelLivenessCapability ? `**Panel liveness telemetry:** streamActivity=${trace.panelLivenessCapability.streamActivityExposed ? "exposed" : "not exposed"}; tokenLevel=${trace.panelLivenessCapability.tokenLevelLiveness ? "yes" : "no"}` : undefined,
    trace.runtimeCapabilities ? `**Runtime capabilities:** visibleDispatch=${trace.runtimeCapabilities.visibleTaskDispatchVerified ? "verified" : "unverified"}; childStream=${trace.runtimeCapabilities.childSessionStreamEvents ? "yes" : "no"}; childTools=${trace.runtimeCapabilities.childToolLifecycleEvents ? "yes" : "no"}; cancellationAbort=${trace.runtimeCapabilities.cancellationAbortSupported ? "yes" : "no"}` : undefined,
    trace.panelAttempts?.length ? `**Panel attempts recorded:** ${trace.panelAttempts.length} (grouped by logical slot 1-3; retries stay under fusion-panel-1/2/3)` : undefined,
    `**Fallback used:** ${trace.fallbackUsed ? "yes" : "no"}`,
    trace.candidateValidation ? `**Candidate validation:** ${trace.candidateValidation.allPassed ? "all passed" : "failures present"}` : undefined,
    trace.quorum ? `**Quorum:** ${trace.quorum.usable}/${trace.quorum.total} usable (required ${trace.quorum.required})${trace.quorum.degraded ? " — degraded" : ""}` : undefined,
    trace.repairAttempted !== undefined ? `**Repair attempted:** ${trace.repairAttempted ? "yes" : "no"}` : undefined,
    trace.repairSucceeded !== undefined ? `**Repair succeeded:** ${trace.repairSucceeded ? "yes" : "no"}` : undefined,
    trace.panelOutputCompletenessScore !== undefined ? `**Panel completeness score:** ${trace.panelOutputCompletenessScore}` : undefined,
    trace.contractGate ? `**Contract Gate:** ${trace.contractGate.literalRequirementsDetected} literal requirements; exports=${trace.contractGate.publicExportsRequired.join(", ") || "none"}` : undefined,
    trace.postBuildAudit ? `**Post-build audit:** ${trace.postBuildAudit.status} (fixCyclesUsed=${trace.postBuildAudit.fixCyclesUsed})` : undefined,
    trace.councilComparison ? `**Council comparison:** ${trace.councilComparison.commonGround.length} common, ${trace.councilComparison.unresolvedDifferences} unresolved, ${trace.councilComparison.uniqueAdditions.length} unique (${trace.councilComparison.adoptedUniqueAdditions} adopted)${trace.councilComparison.degraded ? " — degraded" : ""}` : undefined,
    trace.requirementDecisionMatrixSummary ? `**Requirement decision matrix:** ${trace.requirementDecisionMatrixSummary.mandatoryCount} mandatory, ${trace.requirementDecisionMatrixSummary.safeCompatibilityCount} safe-compat, ${trace.requirementDecisionMatrixSummary.optionalCount} optional, ${trace.requirementDecisionMatrixSummary.rejectedCount} rejected` : undefined,
    trace.correctnessCoverageGate ? `**Correctness coverage gate:** ${trace.correctnessCoverageGate.status} (categories with fix_required=${trace.correctnessCoverageGate.categories.filter((c) => c.status === "fix_required").length})` : undefined,
    "",
    ...(trace.contractGate
      ? [
        "## Contract Gate Summary",
        `- Required package-root exports: ${trace.contractGate.publicExportsRequired.join(", ") || "none"}`,
        `- Required consumer probes: ${trace.contractGate.consumerProbesRequired.join("; ") || "none"}`,
        `- Compatibility recommendations: ${trace.contractGate.compatibilityRecommendations.join("; ") || "none"}`,
        "",
      ]
      : []),
    ...(trace.councilComparison
      ? [
        "## Council Comparison Summary",
        `- Common ground: ${trace.councilComparison.commonGround.length}`,
        `- Key differences: ${trace.councilComparison.keyDifferences.length}`,
        `- Unique additions: ${trace.councilComparison.uniqueAdditions.length} (adopted=${trace.councilComparison.adoptedUniqueAdditions}, deferred/rejected=${trace.councilComparison.deferredOrRejectedUniqueAdditions})`,
        `- Partial coverage: ${trace.councilComparison.partialCoverage.length}`,
        `- Blind spots: ${trace.councilComparison.blindSpots.length}`,
        trace.councilComparison.degraded ? `- Degraded: yes` : undefined,
        "",
      ].filter((line): line is string => line !== undefined)
      : []),
    ...(trace.correctnessCoverageGate
      ? [
        "## Correctness Coverage Gate",
        `- Status: ${trace.correctnessCoverageGate.status}`,
        trace.correctnessCoverageGate.degradedReason ? `- Degraded reason: ${trace.correctnessCoverageGate.degradedReason}` : undefined,
        ...trace.correctnessCoverageGate.categories.map((category) => `- ${category.name}: ${category.status}`),
        "",
      ].filter((line): line is string => line !== undefined)
      : []),
    "## Requested Models",
    ...trace.panelModelsRequested.map((spec, index) => `- ${formatModelSpecTraceLine(spec, `Panel ${index + 1}`, spec.reasoningEffort ? "unsupported" : "not_configured")}`),
    `- ${formatModelSpecTraceLine(trace.judgeModelRequested, "Judge", trace.judgeModelRequested.reasoningEffort ? "unsupported" : "not_configured")}`,
    ...(trace.panelSessions?.length ? formatNativePanelSessions(trace.panelSessions) : []),
    ...(trace.panelExecutionPlan ? formatPanelExecutionPlan(trace.panelExecutionPlan) : []),
    ...(trace.panelAttempts?.length ? formatPanelAttempts(trace.panelAttempts) : []),
    ...(trace.panelLivenessCapability ? formatPanelLivenessCapability(trace.panelLivenessCapability) : []),
    ...(trace.runtimeCapabilities ? formatRuntimeCapabilities(trace.runtimeCapabilities) : []),
    "",
    "## Panel Status",
    ...trace.panel.map((entry) => [
      `- ${entry.modelId}: ${entry.success ? "succeeded" : "failed"}`,
      entry.attempts !== undefined ? ` attempts=${entry.attempts}` : "",
      entry.elapsedMs !== undefined ? ` elapsedMs=${entry.elapsedMs}` : "",
      entry.outputCharCount !== undefined ? ` chars=${entry.outputCharCount}` : "",
      entry.candidateValidationPassed !== undefined ? ` candidateValidation=${entry.candidateValidationPassed ? "passed" : "failed"}` : "",
      entry.repairAttempted ? " repairAttempted=yes" : "",
      entry.reasoningEffort ? ` effort=${entry.reasoningEffort}` : "",
      entry.reasoningEffortApplied === "unsupported" ? " appliedEffort=unsupported" : "",
      entry.error ? ` - ${entry.error}` : "",
    ].join("")),
    "",
    "## Judge Status",
    `- ${trace.judge.modelId}: ${trace.judge.success ? "succeeded" : "failed"}${trace.judge.elapsedMs !== undefined ? ` elapsedMs=${trace.judge.elapsedMs}` : ""}${trace.judge.reasoningEffort ? ` effort=${trace.judge.reasoningEffort}` : ""}${trace.judge.reasoningEffortApplied === "unsupported" ? " appliedEffort=unsupported" : ""}${trace.judge.error ? ` - ${trace.judge.error}` : ""}`,
    trace.judgeOutputSectionsDetected?.length ? `\n**Judge sections detected:** ${trace.judgeOutputSectionsDetected.join(", ")}` : undefined,
    ...(trace.postBuildAudit
      ? [
        "",
        "## Post-Build Audit",
        `- enabled=${trace.postBuildAudit.enabled ? "yes" : "no"}`,
        `- status=${trace.postBuildAudit.status}`,
        `- fixCyclesUsed=${trace.postBuildAudit.fixCyclesUsed}`,
        trace.postBuildAudit.sessionId ? `- sessionId=${trace.postBuildAudit.sessionId}` : undefined,
        ...trace.postBuildAudit.findings.map((finding) => `- ${finding.requirement} -> ${finding.observed} -> ${finding.requiredFix}`),
      ].filter((line): line is string => line !== undefined)
      : []),
    "",
    "## Raw Artifacts",
    trace.artifactPaths?.originalPrompt ? `- Original prompt: ${trace.artifactPaths.originalPrompt}` : undefined,
    trace.artifactPaths?.contractGate ? `- Contract Gate: ${trace.artifactPaths.contractGate}` : undefined,
    trace.sharedPanelPromptPath ? `- Shared panel prompt: ${trace.sharedPanelPromptPath}` : undefined,
    trace.panelPromptTransport?.fullArtifactPath ? `- Panel full prompt artifact: ${trace.panelPromptTransport.fullArtifactPath}` : undefined,
    trace.panelPromptTransport?.briefArtifactPath ? `- Panel brief prompt artifact: ${trace.panelPromptTransport.briefArtifactPath}` : undefined,
    trace.judgePromptTransport?.fullArtifactPath ? `- Judge full context artifact: ${trace.judgePromptTransport.fullArtifactPath}` : undefined,
    trace.judgePromptTransport?.briefArtifactPath ? `- Judge brief context artifact: ${trace.judgePromptTransport.briefArtifactPath}` : undefined,
    trace.auditPromptTransport?.fullArtifactPath ? `- Post-build audit full context artifact: ${trace.auditPromptTransport.fullArtifactPath}` : undefined,
    trace.auditPromptTransport?.briefArtifactPath ? `- Post-build audit brief context artifact: ${trace.auditPromptTransport.briefArtifactPath}` : undefined,
    trace.artifactPaths?.councilComparison ? `- Council comparison: ${trace.artifactPaths.councilComparison}` : undefined,
    trace.artifactPaths?.requirementDecisionMatrix ? `- Requirement decision matrix: ${trace.artifactPaths.requirementDecisionMatrix}` : undefined,
    trace.artifactPaths?.panel1Output ? `- Panel 1 output: ${trace.artifactPaths.panel1Output}` : undefined,
    trace.artifactPaths?.panel2Output ? `- Panel 2 output: ${trace.artifactPaths.panel2Output}` : undefined,
    trace.artifactPaths?.panel3Output ? `- Panel 3 output: ${trace.artifactPaths.panel3Output}` : undefined,
    trace.artifactPaths?.judgeOutput ? `- Judge output: ${trace.artifactPaths.judgeOutput}` : undefined,
    trace.artifactPaths?.postBuildAuditPrompt ? `- Post-build audit prompt: ${trace.artifactPaths.postBuildAuditPrompt}` : undefined,
    trace.artifactPaths?.postBuildAuditOutput ? `- Post-build audit output: ${trace.artifactPaths.postBuildAuditOutput}` : undefined,
    trace.artifactPaths?.correctnessCoverageGate ? `- Correctness coverage gate: ${trace.artifactPaths.correctnessCoverageGate}` : undefined,
    trace.artifactPaths?.finalGuidance ? `- Final guidance: ${trace.artifactPaths.finalGuidance}` : undefined,
    trace.artifactPaths?.sourceBaselineManifest ? `- Source baseline manifest: ${trace.artifactPaths.sourceBaselineManifest}` : undefined,
    trace.artifactPaths?.mainBaselineManifest ? `- Main baseline manifest: ${trace.artifactPaths.mainBaselineManifest}` : undefined,
    trace.artifactPaths?.mainBaselinePatch ? `- Main baseline patch: ${trace.artifactPaths.mainBaselinePatch}` : undefined,
    trace.artifactPaths?.mergePatchContractFull ? `- Merge Patch Contract (full): ${trace.artifactPaths.mergePatchContractFull}` : undefined,
    trace.artifactPaths?.mergePatchContractBrief ? `- Merge Patch Contract (brief): ${trace.artifactPaths.mergePatchContractBrief}` : undefined,
    trace.artifactPaths?.trace ? `- trace.json: ${trace.artifactPaths.trace}` : undefined,
    ...speculativeSection,
  ].filter((line): line is string => line !== undefined).join("\n");
}

/**
 * Render the canonical path-resolution block. Always reports the resolver
 * version so `/fusion-trace` makes the active candidate-workspace strategy
 * unambiguous (external staging, never `<source>/.../speculative`).
 */
function renderSpeculativePathResolutionLines(
  speculative: NonNullable<FusionRunTrace["speculative"]>,
): string[] {
  const resolution = speculative.pathResolution;
  const lines: string[] = [];
  lines.push(`Speculative path resolver: ${resolution?.resolverVersion ?? "external_staging_v1"}`);
  lines.push(`Source artifact directory: ${resolution?.sourceArtifactDir ?? speculative.sourceArtifactDir}`);
  lines.push(`External candidate staging directory: ${resolution?.externalCandidateStagingDir ?? speculative.externalCandidateStagingDir}`);
  const panelPaths = resolution?.panelWorkspacePaths ?? speculative.panelCandidates.map((c) => c.workspacePath);
  panelPaths.forEach((workspacePath, index) => {
    lines.push(`Panel ${index + 1} workspace: ${workspacePath}`);
  });
  if (resolution?.runtimeModulePath) {
    lines.push(`Active module/build identity: ${resolution.runtimeModulePath}`);
  }
  lines.push("");
  return lines;
}

function renderSpeculativeTraceSection(speculative: NonNullable<FusionRunTrace["speculative"]>): string[] {
  const lines: string[] = ["", "## Speculative Parallel Build"];
  lines.push(`- mode: ${speculative.mode}`);
  lines.push(`- source workspace: ${speculative.sourceWorkspace}`);
  lines.push(`- source artifact directory: ${speculative.sourceArtifactDir}`);
  lines.push(`- external candidate staging directory: ${speculative.externalCandidateStagingDir}`);
  lines.push(`- source baseline manifest: ${speculative.sourceBaselineManifestPath}`);
  lines.push("");
  lines.push(...renderSpeculativePathResolutionLines(speculative));
  if (speculative.panelExecutionAssignments && speculative.panelExecutionAssignments.length > 0) {
    for (const assignment of speculative.panelExecutionAssignments) {
      lines.push(`Panel ${assignment.logicalPanelIndex} assignment:`);
      lines.push(`- shared task: ${assignment.sharedTaskPath}`);
      lines.push(`- execution context: ${assignment.executionContextPath}`);
      lines.push(`- candidate workspace: ${assignment.assignedCandidateWorkspace}`);
      lines.push(`- source workspace prohibited: ${assignment.prohibitedSourceWorkspace}`);
      lines.push(`- panel report: ${assignment.panelOutputPath}`);
      lines.push(`- unresolved placeholder check: ${assignment.unresolvedPlaceholderCheck}`);
      lines.push(`- runtime CWD scoped: ${assignment.nativeCwdScoped}`);
      lines.push(`- absolute-path mode: ${assignment.absolutePathModeRequired ? "required" : "not required"}`);
    }
    lines.push("");
  }
  lines.push("Parallelism:");
  lines.push(`- supported: ${speculative.parallelExecutionSupported ? "yes" : "no"}`);
  lines.push(`- overlap observed: ${speculative.overlapObserved ? "yes" : "no"}`);
  lines.push(`- overlap duration: ${speculative.overlapDurationMs ?? "n/a"} ms`);
  lines.push(`- capability limitation: ${speculative.parallelCapabilityLimitation ?? "none"}`);
  lines.push("");
  lines.push("Isolation:");
  lines.push(`- nativeCwdScoped: ${speculative.isolationCapability.nativeCwdScoped ? "yes" : "no"}`);
  lines.push(`- writeBoundaryScoped: ${speculative.isolationCapability.writeBoundaryScoped ? "yes" : "no"}`);
  lines.push(`- hardLinkSafe: ${speculative.isolationCapability.hardLinkSafe ? "yes" : "no"}`);
  lines.push(`- symlinkSafe: ${speculative.isolationCapability.symlinkSafe ? "yes" : "no"}`);
  lines.push(`- verified: ${speculative.isolationCapability.verified ? "yes" : "no"}`);
  if (speculative.isolationCapability.limitation) {
    lines.push(`- limitation: ${speculative.isolationCapability.limitation}`);
  }
  lines.push("");
  lines.push("Main baseline:");
  lines.push(`- workspace: ${speculative.mainBaseline.workspacePath}`);
  lines.push(`- launch anchor: ${speculative.launchClockAnchorMs ?? "n/a"}`);
  lines.push(`- started: ${speculative.mainBaseline.startedAt ?? "n/a"}`);
  lines.push(`- completed: ${speculative.mainBaseline.completedAt ?? "n/a"}`);
  const mv = speculative.mainBaseline.verification;
  lines.push(`- verification: ${mv ? [mv.typecheck, mv.test, mv.build].filter(Boolean).join("/") : "n/a"}`);
  lines.push(`- changed files: ${speculative.mainBaseline.changedFiles.length ? speculative.mainBaseline.changedFiles.join(", ") : "none"}`);
  lines.push("");
  lines.push("Scheduling:");
  lines.push(`- active scheduler capability: ${speculative.activeSchedulerCapability ?? "n/a"}`);
  for (const entry of speculative.panelLaunchSchedule ?? []) {
    lines.push(`- panel ${entry.panelIndex} planned / actual: ${new Date(entry.plannedDispatchAt).toISOString()} / ${entry.dispatchAt !== null ? new Date(entry.dispatchAt).toISOString() : "n/a"}`);
    lines.push(`  dispatch skew: ${entry.scheduleSkewMs ?? "n/a"}`);
    lines.push(`  launch reason: ${entry.launchReason}`);
  }
  lines.push("");
  lines.push("Candidate validation:");
  for (const candidate of speculative.panelCandidates) {
    lines.push(`- panel ${candidate.logicalPanelIndex}: model=${candidate.model}; workspace=${candidate.workspacePath}; classification=${candidate.classification}; status=${candidate.status}`);
    lines.push(`  workspace evidence: exists=${candidate.evidence.workspaceExists ? "yes" : "no"}; safe=${candidate.evidence.workspaceSafe ? "yes" : "no"}`);
    lines.push(`  changed-file evidence: meaningful=${candidate.evidence.meaningfulChangedFiles}; source=${candidate.evidence.changedSourceFiles}; test=${candidate.evidence.changedTestFiles}; config=${candidate.evidence.changedConfigFiles}`);
    lines.push(`  verification: ${formatVerification(candidate.verification)} (raw=${candidate.evidence.verification.typecheck ?? "unknown"}/${candidate.evidence.verification.test ?? "unknown"}/${candidate.evidence.verification.build ?? "unknown"})`);
    lines.push(`  reports: selected=${candidate.evidence.selectedReportPath ?? candidate.reportPath ?? "n/a"}; source=${candidate.evidence.sourceSideReportPath ?? "n/a"}; local=${candidate.evidence.candidateLocalReportPath ?? "n/a"}`);
    lines.push(`  final message format: ${candidate.evidence.finalMessageFormat}`);
    lines.push(`  warnings: ${candidate.warnings.length ? candidate.warnings.join("; ") : "none"}`);
  }
  lines.push("");
  lines.push("Judge:");
  const usableCount = speculative.panelCandidates.filter((c) => c.classification === "usable").length;
  lines.push(`- quorum: ${usableCount}/${speculative.panelCandidates.length} usable`);
  lines.push(`- eligibility: ${speculative.judgeEligibleAt ?? "n/a"}`);
  lines.push(`- dispatched: ${speculative.judgeDispatched ? "yes" : "no"}`);
  lines.push(`- judge eligible at: ${speculative.judgeEligibleAt ?? "n/a"}`);
  lines.push(`- judge dispatch at: ${speculative.judgeDispatchAt ?? "n/a"}`);
  lines.push(`- judge started at: ${speculative.judgeStartedAt ?? "n/a"}`);
  lines.push(`- judge completed at: ${speculative.judgeCompletedAt ?? "n/a"}`);
  lines.push(`- judge terminal: ${speculative.judgeTerminal ? "yes" : "no"}`);
  lines.push(`- judge manifest: ${speculative.judgeManifestPath ?? "n/a"}`);
  lines.push(`- frozen panel indexes: ${speculative.frozenPanelIndexes?.length ? speculative.frozenPanelIndexes.join(", ") : "none"}`);
  lines.push(`- late excluded panel indexes: ${speculative.lateExcludedPanelIndexes?.length ? speculative.lateExcludedPanelIndexes.join(", ") : "none"}`);
  lines.push(`- merge patch contract: ${speculative.mergePatchContractPath ?? "n/a"}`);
  lines.push(`- contract valid: ${speculative.judgeContractValid ? "yes" : "no"}`);
  lines.push(`- judge decision status: ${speculative.judgeDecisionStatus ?? "n/a"}`);
  lines.push(`- actual final decision: ${speculative.mergePatchDecision ?? "n/a"}`);
  const appliedItems = speculative.appliedPatchItems ?? [];
  lines.push(`- blockers applied: ${appliedItems.filter((i) => i.severity === "BLOCKER" && i.status === "applied").length}`);
  lines.push(`- must-fix applied: ${appliedItems.filter((i) => i.severity === "MUST_FIX" && i.status === "applied").length}`);
  lines.push(`- safe additions applied: ${appliedItems.filter((i) => i.severity === "SAFE_ADDITION" && i.status === "applied").length}`);
  lines.push("");
  lines.push("Patch phase:");
  lines.push(`- applied: ${appliedItems.filter((i) => i.status === "applied").length}`);
  lines.push(`- skipped: ${appliedItems.filter((i) => i.status === "skipped").length}`);
  lines.push(`- failed: ${appliedItems.filter((i) => i.status === "failed").length}`);
  return lines;
}

function formatVerification(
  verification: NonNullable<NonNullable<FusionRunTrace["speculative"]>["mainBaseline"]>["verification"] | undefined,
): string {
  if (!verification) return "n/a";
  return [verification.typecheck, verification.test, verification.build].filter(Boolean).join("/") || "n/a";
}

function formatNativePanelSessions(sessions: NonNullable<FusionRunTrace["panelSessions"]>): string[] {
  return [
    "",
    "## Native Panel Sessions",
    ...sessions.map((session) => [
      `- Panel ${session.panelIndex}: agent=${session.agentName}; model=${session.modelId}; nativeTask=${session.nativeTask ? "yes" : "no"}; promptHash=${session.promptHash}`,
      session.sessionId ? `  sessionId=${session.sessionId}` : undefined,
      session.taskId ? `  taskId=${session.taskId}` : undefined,
      session.success !== undefined ? `  success=${session.success ? "yes" : "no"}` : undefined,
      session.validationStatus ? `  validation=${session.validationStatus}` : undefined,
    ].filter((line): line is string => line !== undefined).join("")),
  ];
}

function formatPanelAttempts(attempts: NonNullable<FusionRunTrace["panelAttempts"]>): string[] {
  const bySlot = new Map<number, typeof attempts>();
  for (const attempt of attempts) {
    const list = bySlot.get(attempt.logicalPanelIndex) ?? [];
    list.push(attempt);
    bySlot.set(attempt.logicalPanelIndex, list);
  }
  const lines: string[] = ["", "## Native Panel Attempts (staggered cascade + same-slot retry)"];
  for (let index = 1; index <= 3; index += 1) {
    const slotAttempts = bySlot.get(index);
    if (!slotAttempts || slotAttempts.length === 0) {
      lines.push(`- fusion-panel-${index}: not dispatched`);
      continue;
    }
    for (const attempt of slotAttempts) {
      const parts = [
        `- fusion-panel-${index} attempt ${attempt.attempt}: ${attempt.status} (startReason=${attempt.startReason})`,
        attempt.model ? `  model=${attempt.model}` : undefined,
        attempt.nativeSessionId ? `  sessionId=${attempt.nativeSessionId}` : undefined,
        attempt.workspacePreparedAt ? `  workspacePreparedAt=${attempt.workspacePreparedAt}` : undefined,
        attempt.dispatchAt ? `  dispatchAt=${attempt.dispatchAt}` : undefined,
        attempt.fallbackGateAt ? `  fallbackGateAt=${attempt.fallbackGateAt}` : undefined,
        attempt.startedAt ? `  startedAt=${attempt.startedAt}` : undefined,
        attempt.firstActivityAt ? `  firstActivityAt=${attempt.firstActivityAt}` : undefined,
        attempt.firstActivitySource ? `  firstActivitySource=${attempt.firstActivitySource}` : undefined,
        attempt.lastActivityAt ? `  lastActivityAt=${attempt.lastActivityAt}` : undefined,
        attempt.lastActivitySource ? `  lastActivitySource=${attempt.lastActivitySource}` : undefined,
        attempt.suspectedStalledAt ? `  suspectedStalledAt=${attempt.suspectedStalledAt}` : undefined,
        attempt.cancellationRequestedAt ? `  cancellationRequestedAt=${attempt.cancellationRequestedAt}` : undefined,
        attempt.cancelledAt ? `  cancelledAt=${attempt.cancelledAt}` : undefined,
        attempt.retryScheduledAt ? `  retryScheduledAt=${attempt.retryScheduledAt}` : undefined,
        attempt.retryStartedAt ? `  retryStartedAt=${attempt.retryStartedAt}` : undefined,
        attempt.endedAt ? `  endedAt=${attempt.endedAt}` : undefined,
        attempt.stallReason ? `  stallReason=${attempt.stallReason}` : undefined,
        attempt.excludedAt ? `  excludedAt=${attempt.excludedAt}` : undefined,
        attempt.excludedReason ? `  excludedReason=${attempt.excludedReason}` : undefined,
      ].filter((line): line is string => line !== undefined);
      lines.push(parts.join("\n"));
    }
  }
  return lines;
}

function formatRuntimeCapabilities(capability: NonNullable<FusionRunTrace["runtimeCapabilities"]>): string[] {
  return [
    "",
    "## Runtime Capabilities",
    `- visibleTaskDispatchVerified=${capability.visibleTaskDispatchVerified ? "yes" : "no"}`,
    `- childSessionStreamEvents=${capability.childSessionStreamEvents ? "yes" : "no"}`,
    `- childReasoningDeltas=${capability.childReasoningDeltas ? "yes" : "no"}`,
    `- childToolLifecycleEvents=${capability.childToolLifecycleEvents ? "yes" : "no"}`,
    `- childSessionStatusInspection=${capability.childSessionStatusInspection ? "yes" : "no"}`,
    `- cancellationAbortSupported=${capability.cancellationAbortSupported ? "yes" : "no"}`,
    `- childTaskCwdOverride=${capability.childTaskCwdOverride ? "yes" : "no"}`,
    `- childTaskWriteScopeEnforced=${capability.childTaskWriteScopeEnforced ? "yes" : "no"}`,
    `- parentContinueWhileChildRuns=${capability.parentContinueWhileChildRuns ? "yes" : "no"}`,
    `- safeRedispatchSupported=${capability.safeRedispatchSupported ? "yes" : "no"}`,
    `- visibleJudgeSupported=${capability.visibleJudgeSupported ? "yes" : "no"}`,
    `- tracePersistenceSupported=${capability.tracePersistenceSupported ? "yes" : "no"}`,
  ];
}

function formatPanelLivenessCapability(capability: NonNullable<FusionRunTrace["panelLivenessCapability"]>): string[] {
  return [
    "",
    "## Panel Liveness Capability",
    `- streamActivityExposed=${capability.streamActivityExposed ? "yes" : "no"}`,
    `- tokenLevelLiveness=${capability.tokenLevelLiveness ? "yes" : "no"}`,
    `- startGateFallback=${capability.startGateFallback ? "yes" : "no"}`,
    `- taskTimeoutSupported=${capability.taskTimeoutSupported ? "yes" : "no"}`,
    `- pendingToolActivityInspectable=${capability.pendingToolActivityInspectable ? "yes" : "no"}`,
    capability.streamActivityExposed && capability.tokenLevelLiveness
      ? "- Watchdog: event-driven 90s inactivity timeout active."
      : "- Watchdog: token-level liveness NOT available; relying on start-gate (60s) and task timeout only. This limitation is reported honestly in trace.",
  ];
}

function formatPanelExecutionPlan(plan: NonNullable<FusionRunTrace["panelExecutionPlan"]>): string[] {
  const lines: string[] = [
    "",
    "## Panel Execution Plan",
    `- staggered=${plan.staggered ? "yes" : "no"}`,
    `- startGateTimeoutMs=${plan.startGateTimeoutMs}`,
    `- inactivityTimeoutMs=${plan.inactivityTimeoutMs}`,
    `- maxAttemptsPerPanel=${plan.maxAttemptsPerPanel}`,
  ];
  for (const stage of plan.stages) {
    lines.push(`- Panel ${stage.panelIndex}: agent=${stage.agentName}; model=${stage.modelId}; startsAfter=${stage.startsAfter}; startGateTimeoutMs=${stage.startGateTimeoutMs}`);
  }
  return lines;
}

export function buildPanelPrompts(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panelMode?: PanelMode;
  panelModels: string[];
  promptVerbosity?: import("../types.js").PromptVerbosity;
  contractGate?: ContractGate;
}): string[] {
  const prompt = buildPanelPrompt({
    task: input.task,
    mode: input.mode,
    context: input.context,
    panelMode: input.panelMode,
    promptVerbosity: input.promptVerbosity,
    contractGate: input.contractGate,
  });
  return input.panelModels.map(() => prompt);
}

export function buildJudgePromptText(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
  panelMode?: PanelMode;
  quorum?: import("../types.js").FusionTraceQuorum;
  contractGate?: ContractGate;
  councilComparison?: CouncilComparison;
  councilComparisonMarkdown?: string;
}): string {
  return buildJudgePrompt(input);
}

export function panelSessionTitle(index: number, modelId: string, role: "panel" | "judge"): string {
  const shortModel = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  if (role === "judge") return `Fusion Judge - ${shortModel}`;
  return `Fusion Panel ${index + 1} - ${shortModel}`;
}
