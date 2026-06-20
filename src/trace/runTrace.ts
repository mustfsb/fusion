import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { CouncilMode, CouncilResult, FusionRunTrace, PanelMode, PanelResponse } from "../types.js";
import { validateCandidateOutput } from "../council/candidateValidation.js";
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

export function resolveTraceRoot(cwd: string, traceDir?: string): string {
  return path.resolve(cwd, traceDir ?? DEFAULT_TRACE_DIR);
}

export function detectGuidanceSections(text: string): {
  requirementLedger: boolean;
  hiddenTests: boolean;
  packageChecklist: boolean;
  immutabilityChecklist: boolean;
  typedErrorChecklist: boolean;
  rejectedRiskyIdeas: boolean;
  mainAgentExecutionRequirements: boolean;
  selfAuditChecklist: boolean;
  finalBuildContract: boolean;
} {
  const lower = text.toLowerCase();
  return {
    requirementLedger: /requirement ledger|non-negotiable acceptance tests/i.test(text),
    hiddenTests: /required hidden tests?|hidden (?:edge )?probe|hidden tests? to write/i.test(text),
    packageChecklist: /package\/build checklist|packaging\/build checklist|package\.json.*main|verification checklist/i.test(lower),
    immutabilityChecklist: /immutability|mutable internal|live internal|public reads return clones/i.test(lower),
    typedErrorChecklist: /typed error|typed-error|domain error|raw error.*leak/i.test(lower),
    rejectedRiskyIdeas: /ideas? to reject|rejected risky|risky\/speculative ideas rejected/i.test(lower),
    mainAgentExecutionRequirements: /main-agent execution requirements|main agent execution requirements/i.test(lower),
    selfAuditChecklist: /self-audit|pre-final self-audit/i.test(lower),
    finalBuildContract: /final build contract|final implementation contract/i.test(lower),
  };
}

export function detectJudgeOutputSections(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["candidate summary table", /candidate summary table/i],
    ["candidate bug audit", /candidate bug audit/i],
    ["best ideas to use", /best ideas to use/i],
    ["ideas to reject", /ideas to reject/i],
    ["spec compliance verdict", /spec compliance verdict/i],
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

  if (result.requirementChecklist.length && !sections.requirementLedger) {
    extras.push("## Requirement Ledger", ...result.requirementChecklist.map((item) => `- ${item}`));
  }
  if (result.rejectedRiskyIdeas.length && !sections.rejectedRiskyIdeas) {
    extras.push("## Rejected Risky Ideas", ...result.rejectedRiskyIdeas.map((item) => `- ${item}`));
  }
  if (result.requiredTests.length && !sections.hiddenTests) {
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
      "## Main-Agent Execution Requirements",
      "- Implement according to the Requirement Ledger and the original user task. If they conflict, the original user task wins.",
      "- Preserve explicit public API, error, edge-case, and serialization contracts exactly.",
      "- Before finishing, implement the judge's Required Hidden Tests or equivalent coverage.",
      "- Verify boundary, determinism, restore/parse continuation, rollback, immutability, and public-shape edge cases relevant to the task before final answer.",
      "- Do not accept visible-test-only success if hidden probes or the literal task would still fail.",
      "- Run npm run typecheck, npm test, and npm run build when the task requires them.",
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
      "- All required public API symbols are exported.",
      "- package.json main and types resolve to actual built files.",
      "- Typed errors are used where required.",
      "- Hidden tests from judge guidance are implemented where practical.",
      "- npm run typecheck, npm test, and npm run build are run if requested.",
    );
  }

  const needsExtras = !sections.finalBuildContract
    || !sections.requirementLedger
    || !sections.hiddenTests
    || !sections.packageChecklist
    || !sections.rejectedRiskyIdeas
    || !sections.mainAgentExecutionRequirements
    || !sections.selfAuditChecklist;

  if (!needsExtras && extras.length <= 1) return baseGuidance;

  const header = sections.finalBuildContract
    ? ""
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
    finalGuidanceContainsHiddenTests: guidanceSections.hiddenTests || judgeSections.includes("required hidden tests"),
    finalGuidanceContainsPackageChecklist: guidanceSections.packageChecklist,
    finalGuidanceContainsImmutabilityChecklist: guidanceSections.immutabilityChecklist || judgeSections.includes("immutability checklist"),
    finalGuidanceContainsTypedErrorChecklist: guidanceSections.typedErrorChecklist || judgeSections.includes("typed error checklist"),
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
  context: ContextBundle;
  panelModels: string[];
  judgeModel: string;
  panelResponses: PanelResponse[];
  panelPrompts: string[];
  judgePrompt?: string;
  judgeOutput?: string;
  finalGuidance?: string;
  councilResult?: CouncilResult;
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

export async function loadLatestRunTrace(cwd: string, traceDir?: string): Promise<FusionRunTrace | null> {
  const pointerPath = path.join(resolveTraceRoot(cwd, traceDir), LATEST_TRACE_POINTER);
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { artifactDir?: string; runId?: string };
    const tracePath = pointer.artifactDir
      ? path.join(pointer.artifactDir, "trace.json")
      : path.join(resolveTraceRoot(cwd, traceDir), pointer.runId ?? "", "trace.json");
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as FusionRunTrace;
    return trace;
  } catch {
    return null;
  }
}

export function formatLatestTraceSummary(trace: FusionRunTrace): string {
  return [
    "# Fusion Latest Run Trace",
    "",
    `**Run ID:** ${trace.runId}`,
    `**Timestamp:** ${trace.timestamp}`,
    trace.command ? `**Command:** ${trace.command}` : undefined,
    trace.panelMode ? `**Panel mode:** ${trace.panelMode}` : undefined,
    `**Artifact directory:** ${trace.artifactDir ?? "unknown"}`,
    `**Model source:** ${trace.modelSource}`,
    `**Fallback used:** ${trace.fallbackUsed ? "yes" : "no"}`,
    trace.candidateValidation ? `**Candidate validation:** ${trace.candidateValidation.allPassed ? "all passed" : "failures present"}` : undefined,
    trace.quorum ? `**Quorum:** ${trace.quorum.usable}/${trace.quorum.total} usable (required ${trace.quorum.required})${trace.quorum.degraded ? " — degraded" : ""}` : undefined,
    trace.repairAttempted !== undefined ? `**Repair attempted:** ${trace.repairAttempted ? "yes" : "no"}` : undefined,
    trace.repairSucceeded !== undefined ? `**Repair succeeded:** ${trace.repairSucceeded ? "yes" : "no"}` : undefined,
    trace.panelOutputCompletenessScore !== undefined ? `**Panel completeness score:** ${trace.panelOutputCompletenessScore}` : undefined,
    "",
    "## Requested Models",
    ...trace.panelModelsRequested.map((spec, index) => `- ${formatModelSpecTraceLine(spec, `Panel ${index + 1}`, spec.reasoningEffort ? "unsupported" : "not_configured")}`),
    `- ${formatModelSpecTraceLine(trace.judgeModelRequested, "Judge", trace.judgeModelRequested.reasoningEffort ? "unsupported" : "not_configured")}`,
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
    "",
    "## Raw Artifacts",
    trace.artifactPaths?.originalPrompt ? `- Original prompt: ${trace.artifactPaths.originalPrompt}` : undefined,
    trace.artifactPaths?.panel1Output ? `- Panel 1 output: ${trace.artifactPaths.panel1Output}` : undefined,
    trace.artifactPaths?.panel2Output ? `- Panel 2 output: ${trace.artifactPaths.panel2Output}` : undefined,
    trace.artifactPaths?.panel3Output ? `- Panel 3 output: ${trace.artifactPaths.panel3Output}` : undefined,
    trace.artifactPaths?.judgeOutput ? `- Judge output: ${trace.artifactPaths.judgeOutput}` : undefined,
    trace.artifactPaths?.finalGuidance ? `- Final guidance: ${trace.artifactPaths.finalGuidance}` : undefined,
    trace.artifactPaths?.trace ? `- trace.json: ${trace.artifactPaths.trace}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildPanelPrompts(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panelMode?: PanelMode;
  panelModels: string[];
  promptVerbosity?: import("../types.js").PromptVerbosity;
}): string[] {
  const prompt = buildPanelPrompt({
    task: input.task,
    mode: input.mode,
    context: input.context,
    panelMode: input.panelMode,
    promptVerbosity: input.promptVerbosity,
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
}): string {
  return buildJudgePrompt(input);
}

export function panelSessionTitle(index: number, modelId: string, role: "panel" | "judge"): string {
  const shortModel = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  if (role === "judge") return `Fusion Judge - ${shortModel}`;
  return `Fusion Panel ${index + 1} - ${shortModel}`;
}
