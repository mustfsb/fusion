import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FusionCouncilError } from "../utils/errors.js";
import type {
  PanelAttemptTrace,
  RecoveredPanelCandidate,
  RecoveryCandidateClassificationTrace,
  VerificationSummary,
} from "../types.js";
import {
  candidatePanelOutputPaths,
  type BaselineManifest,
} from "./candidateWorkspace.js";
import { type ParsedPanelExecutionContext } from "./speculativeBuild.js";
import {
  classifyCandidateEvidence,
  renderDeterministicCandidateReport,
} from "./candidateClassification.js";

const execFileAsync = promisify(execFile);

export const RECOVERY_CLASSIFICATION_JSON = "recovery-candidate-classification.json";
export const RECOVERY_PANEL_PLAN_MD = "recovery-panel-plan.md";

export const RECOVERY_EVIDENCE_SOURCES = [
  "execution_context",
  "candidate_workspace",
  "candidate_changes",
  "candidate_local_report",
  "source_side_report",
  "prior_succeeded_attempt",
  "verification",
] as const;

export type RecoveryEvidenceSource = (typeof RECOVERY_EVIDENCE_SOURCES)[number];

export const WEAK_RERUN_REASON_PATTERNS: RegExp[] = [
  /^old collect failed$/i,
  /^collect failed$/i,
  /^missing local report$/i,
  /^empty old run id$/i,
  /^trace unavailable$/i,
  /^missing report$/i,
  /^panel report missing$/i,
  /^candidate report missing$/i,
  /^missing candidate-local report$/i,
];

export type RecoveryAttemptContext = {
  sourceWorkspace: string;
  orphanSourceArtifactRoot: string;
  sharedPromptHash: string;
  baselineManifest: BaselineManifest;
  externalStagingDir: string;
  panelContexts: Array<ParsedPanelExecutionContext & { artifactPath: string }>;
  panelAttempts?: PanelAttemptTrace[];
};

export type ClassifyRecoveredPanelInput = {
  logicalPanelIndex: number;
  attempt: RecoveryAttemptContext;
  agentName: string;
  modelId: string;
  verificationOptions?: WorkspaceVerificationOptions;
};

export type ReportAssessment =
  | { valid: false; reason: string }
  | { valid: true; kind: "full" | "partial"; content: string; path: string };

export type WorkspaceVerificationOptions = {
  execFileImpl?: typeof execFileAsync;
};

export async function runWorkspaceVerification(
  workspacePath: string,
  options: WorkspaceVerificationOptions = {},
): Promise<VerificationSummary> {
  const exec = options.execFileImpl ?? execFileAsync;
  const packageJsonPath = path.join(workspacePath, "package.json");
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { typecheck: "not_run", test: "not_run", build: "not_run", commandsRun: [], notes: ["package.json missing or unreadable"] };
  }

  const commandsRun: string[] = [];
  const notes: string[] = [];
  const summary: VerificationSummary = { commandsRun, notes };

  async function runScript(name: "typecheck" | "test" | "build"): Promise<"pass" | "fail" | "not_run"> {
    if (!scripts[name]) return "not_run";
    const command = `npm run ${name}`;
    commandsRun.push(command);
    try {
      await exec("npm", ["run", name], { cwd: workspacePath, timeout: 120_000 });
      return "pass";
    } catch (error) {
      notes.push(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
      return "fail";
    }
  }

  summary.typecheck = await runScript("typecheck");
  summary.test = await runScript("test");
  summary.build = await runScript("build");
  return summary;
}

export function isWeakRerunReason(reason: string | undefined): boolean {
  if (!reason?.trim()) return true;
  return WEAK_RERUN_REASON_PATTERNS.some((pattern) => pattern.test(reason.trim()));
}

export function assessReportContent(text: string | undefined): ReportAssessment {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return { valid: false, reason: "absent" };
  if (/^FUSION_(?:ADVISORY|BLOCK)/i.test(trimmed)) {
    return { valid: false, reason: "advisory/block marker" };
  }
  if (/FUSION_FULL_PROMPT_UNAVAILABLE/i.test(trimmed)) {
    return { valid: false, reason: "prompt unavailable marker" };
  }
  if (/<[A-Z][A-Z0-9_]*>/.test(trimmed)) {
    return { valid: false, reason: "unresolved placeholder" };
  }
  if (/^(?:I cannot|Unable to|Cannot implement|I am unable)/i.test(trimmed) && trimmed.length < 500) {
    return { valid: false, reason: "refusal without implementation" };
  }

  return {
    valid: true,
    kind: /^#{1,6}\s+/m.test(trimmed) ? "full" : "partial",
    content: trimmed,
    path: "",
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

function hasPriorSucceededAttempt(
  logicalPanelIndex: number,
  panelAttempts: PanelAttemptTrace[] | undefined,
): boolean {
  return (panelAttempts ?? []).some(
    (attempt) => attempt.logicalPanelIndex === logicalPanelIndex && attempt.status === "succeeded",
  );
}

export async function classifyRecoveredPanelCandidate(
  input: ClassifyRecoveredPanelInput,
): Promise<RecoveredPanelCandidate> {
  const { logicalPanelIndex, attempt, agentName, modelId } = input;
  const ctx = attempt.panelContexts.find((entry) => entry.logicalPanelIndex === logicalPanelIndex);
  const evidenceSourcesChecked: RecoveryEvidenceSource[] = [];

  if (!ctx) {
    return {
      logicalPanelIndex,
      model: modelId,
      agentName,
      classification: "missing",
      evidence: {
        workspaceExists: false,
        workspaceSafe: false,
        executionContextMatches: false,
        sharedPromptHashMatches: false,
        meaningfulChangedFiles: 0,
        changedSourceFiles: 0,
        changedTestFiles: 0,
        changedConfigFiles: 0,
        changedFiles: [],
        verification: {},
        priorTerminalStatus: "unknown",
        finalMessageFormat: "missing",
        warnings: ["no panel execution context artifact found for this logical slot"],
      },
      evidenceSourcesChecked: [...RECOVERY_EVIDENCE_SOURCES],
      rerunEligible: true,
      rerunReason: "no panel execution context artifact found for this logical slot",
    };
  }

  evidenceSourcesChecked.push("prior_succeeded_attempt");
  const priorSucceededAttempt = hasPriorSucceededAttempt(logicalPanelIndex, attempt.panelAttempts);
  let verification: VerificationSummary | undefined;
  evidenceSourcesChecked.push("verification");
  verification = await runWorkspaceVerification(path.resolve(ctx.candidateWorkspacePath), input.verificationOptions);

  evidenceSourcesChecked.push("execution_context", "candidate_workspace", "candidate_changes", "source_side_report", "candidate_local_report");
  const sourceSideReportPath = path.join(attempt.orphanSourceArtifactRoot, `panel-${logicalPanelIndex}-report.md`);
  const localReportPath = candidatePanelOutputPaths(path.resolve(ctx.candidateWorkspacePath)).reportPath;
  const candidate = await classifyCandidateEvidence({
    logicalPanelIndex,
    sourceWorkspace: attempt.sourceWorkspace,
    expectedSharedPromptHash: attempt.sharedPromptHash,
    candidateWorkspacePath: ctx.candidateWorkspacePath,
    candidateBaselineManifestPath: path.join(attempt.externalStagingDir, `panel-${logicalPanelIndex}-manifest.json`),
    fallbackBaselineManifest: attempt.baselineManifest,
    executionContextSourceWorkspacePath: ctx.sourceWorkspacePath,
    executionContextSharedTaskPath: ctx.sharedTaskPath,
    sourceSideReportPath,
    candidateLocalReportPath: localReportPath,
    explicitVerification: verification,
    priorTerminalStatus: priorSucceededAttempt ? "succeeded" : "unknown",
  });

  const reportContent = candidate.reportContent
    ?? (candidate.classification === "usable" || candidate.classification === "partial"
      ? renderDeterministicCandidateReport({
        logicalPanelIndex,
        workspacePath: path.resolve(ctx.candidateWorkspacePath),
        evidence: candidate.evidence,
        classification: candidate.classification,
      })
      : undefined);
  const reportPath = candidate.reportPath;
  return finish({
    classification: candidate.classification,
    rerunReason: candidate.rerunReason,
    reportPath,
    reportContent,
    evidence: candidate.evidence,
    verification: candidate.verificationSummary,
  });

  function finish(details: {
    classification: RecoveredPanelCandidate["classification"];
    rerunReason?: string;
    reportPath?: string;
    reportContent?: string;
    evidence: RecoveredPanelCandidate["evidence"];
    verification: VerificationSummary;
  }): RecoveredPanelCandidate {
    const rerunEligible = details.classification === "missing" || details.classification === "invalid";
    return {
      logicalPanelIndex,
      model: ctx?.modelId ?? modelId,
      agentName,
      classification: details.classification,
      evidence: details.evidence,
      evidenceSourcesChecked,
      workspacePath: details.evidence.workspaceSafe ? path.resolve(ctx!.candidateWorkspacePath) : undefined,
      reportPath: details.reportPath,
      sourceSideReportPath: details.evidence.sourceSideReportPath,
      changedFileCount: details.evidence.changedFiles.length,
      verification: details.verification,
      rerunEligible,
      rerunReason: rerunEligible ? details.rerunReason : undefined,
      reportContent: details.reportContent,
    };
  }
}

export function assertPanelRedispatchIsRequired(candidate: RecoveredPanelCandidate): void {
  if (candidate.classification !== "missing" && candidate.classification !== "invalid") {
    throw new FusionCouncilError(
      `FUSION_RESUME_REDISPATCH_BLOCKED: panel ${candidate.logicalPanelIndex} is classified ${candidate.classification}, not missing/invalid`,
    );
  }
  if (!candidate.rerunEligible) {
    throw new FusionCouncilError(
      `FUSION_RESUME_REDISPATCH_BLOCKED: panel ${candidate.logicalPanelIndex} is not rerun-eligible`,
    );
  }
  if (!candidate.rerunReason || isWeakRerunReason(candidate.rerunReason)) {
    throw new FusionCouncilError(
      `FUSION_RESUME_REDISPATCH_BLOCKED: panel ${candidate.logicalPanelIndex} rerun reason is missing or weak: ${candidate.rerunReason ?? "none"}`,
    );
  }
  const unchecked = RECOVERY_EVIDENCE_SOURCES.filter(
    (source) => !candidate.evidenceSourcesChecked.includes(source),
  );
  if (unchecked.length > 0) {
    throw new FusionCouncilError(
      `FUSION_RESUME_REDISPATCH_BLOCKED: panel ${candidate.logicalPanelIndex} did not inspect all recovery evidence sources (${unchecked.join(", ")})`,
    );
  }
}

export function buildRecoveryClassificationTrace(
  recoveredCandidates: RecoveredPanelCandidate[],
): RecoveryCandidateClassificationTrace {
  return {
    recoveredCandidates: recoveredCandidates.map(stripReportContent),
    redispatchPlan: recoveredCandidates.map((entry) => ({
      logicalPanelIndex: entry.logicalPanelIndex,
      allowed: entry.rerunEligible,
      reason: entry.rerunReason,
    })),
    reusedPanelIndexes: recoveredCandidates
      .filter((entry) => entry.classification === "usable")
      .map((entry) => entry.logicalPanelIndex),
    partialPanelIndexes: recoveredCandidates
      .filter((entry) => entry.classification === "partial")
      .map((entry) => entry.logicalPanelIndex),
    rerunPanelIndexes: recoveredCandidates
      .filter((entry) => entry.rerunEligible)
      .map((entry) => entry.logicalPanelIndex),
  };
}

function stripReportContent(candidate: RecoveredPanelCandidate): RecoveredPanelCandidate {
  const { reportContent: _reportContent, ...rest } = candidate;
  return rest;
}

export function renderRecoveryPanelPlanMarkdown(
  trace: RecoveryCandidateClassificationTrace,
  judgeEligible: boolean,
): string {
  const lines: string[] = [
    "# Fusion Recovery Panel Plan",
    "",
    "## Recovered panel candidates",
  ];

  for (const candidate of trace.recoveredCandidates) {
    lines.push(`### Panel ${candidate.logicalPanelIndex}: ${candidate.classification}`);
    lines.push(`- candidate workspace: ${candidate.workspacePath ?? "n/a"}`);
    lines.push(`- source-side report: ${candidate.sourceSideReportPath ?? "n/a"}`);
    lines.push(`- local report: ${candidate.reportPath ?? "n/a"}`);
    lines.push(`- prior terminal status: ${candidate.evidence.priorTerminalStatus ?? "unknown"}`);
    lines.push(`- changed files: ${candidate.changedFileCount ?? 0}`);
    lines.push(`- verification: ${formatVerification(candidate.verification)}`);
    lines.push(`- final message format: ${candidate.evidence.finalMessageFormat}`);
    lines.push(`- warnings: ${candidate.evidence.warnings.length ? candidate.evidence.warnings.join("; ") : "none"}`);
    lines.push(`- rerun eligible: ${candidate.rerunEligible ? "yes" : "no"}`);
    lines.push(`- rerun reason: ${candidate.rerunReason ?? "n/a"}`);
    lines.push("");
  }

  lines.push("## Recovery plan");
  lines.push(`- reused panels: ${trace.reusedPanelIndexes.join(", ") || "none"}`);
  lines.push(`- partial panels: ${trace.partialPanelIndexes.join(", ") || "none"}`);
  lines.push(`- rerun panels: ${trace.rerunPanelIndexes.join(", ") || "none"}`);
  lines.push(`- judge eligible: ${judgeEligible ? "yes" : "no"}`);
  lines.push("");
  return lines.join("\n");
}

function formatVerification(verification: VerificationSummary | undefined): string {
  if (!verification) return "not run";
  return [verification.typecheck, verification.test, verification.build].filter(Boolean).join("/") || "not run";
}

export async function loadOrphanPanelAttempts(orphanRoot: string): Promise<PanelAttemptTrace[]> {
  const attemptsPath = path.join(orphanRoot, "panel-attempts.json");
  const attemptsText = await readTextIfExists(attemptsPath);
  if (attemptsText) {
    try {
      return JSON.parse(attemptsText) as PanelAttemptTrace[];
    } catch {
      // fall through
    }
  }

  const runStateFile = path.join(orphanRoot, "run-state.json");
  const runStateText = await readTextIfExists(runStateFile);
  if (runStateText) {
    try {
      const state = JSON.parse(runStateText) as { panelAttempts?: PanelAttemptTrace[] };
      return state.panelAttempts ?? [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function writeRecoveryClassificationArtifacts(
  recoveredArtifactDir: string,
  trace: RecoveryCandidateClassificationTrace,
  judgeEligible: boolean,
): Promise<{ classificationPath: string; panelPlanPath: string; summaryMarkdown: string }> {
  const classificationPath = path.join(recoveredArtifactDir, RECOVERY_CLASSIFICATION_JSON);
  const panelPlanPath = path.join(recoveredArtifactDir, RECOVERY_PANEL_PLAN_MD);
  const summaryMarkdown = renderRecoveryPanelPlanMarkdown(trace, judgeEligible);
  await writeFile(classificationPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(panelPlanPath, summaryMarkdown, "utf8");
  return { classificationPath, panelPlanPath, summaryMarkdown };
}
