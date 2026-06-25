import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { validateCandidateOutput } from "../council/candidateValidation.js";
import type {
  CandidateClassification,
  CandidateEvidence,
  CandidateEvidenceVerificationStatus,
  CandidateFinalMessageFormat,
  VerificationSummary,
} from "../types.js";
import {
  diffAgainstBaseline,
  loadBaselineManifest,
  type BaselineManifest,
} from "./candidateWorkspace.js";
import { hashSharedPanelPrompt } from "./runState.js";
import { isPathContainedWithin } from "./speculativeWorkspacePaths.js";
import { parseCandidateWorkspaceUnusable } from "./speculativeBuild.js";

type TextArtifactAssessment = {
  available: boolean;
  invalid: boolean;
  format: CandidateFinalMessageFormat;
  verification: CandidateEvidence["verification"];
  warnings: string[];
  content?: string;
};

export type CandidateClassificationInput = {
  logicalPanelIndex: number;
  sourceWorkspace: string;
  expectedSharedPromptHash: string;
  candidateWorkspacePath: string;
  candidateBaselineManifestPath?: string;
  fallbackBaselineManifest?: BaselineManifest;
  executionContextSourceWorkspacePath?: string;
  executionContextSharedTaskPath?: string;
  sourceSideReportPath?: string;
  candidateLocalReportPath?: string;
  finalMessage?: string;
  explicitVerification?: VerificationSummary;
  priorTerminalStatus?: "succeeded" | "failed" | "unknown";
};

export type CandidateClassificationResult = {
  classification: CandidateClassification;
  evidence: CandidateEvidence;
  verificationSummary: VerificationSummary;
  reportContent?: string;
  reportPath?: string;
  rerunReason?: string;
};

export async function classifyCandidateEvidence(
  input: CandidateClassificationInput,
): Promise<CandidateClassificationResult> {
  const workspacePath = path.resolve(input.candidateWorkspacePath);
  const workspaceExists = await pathExists(workspacePath);
  const workspaceSafe = workspaceExists
    && path.resolve(workspacePath) !== path.resolve(input.sourceWorkspace)
    && !isPathContainedWithin(workspacePath, input.sourceWorkspace);

  const sharedPromptHashMatches = input.executionContextSharedTaskPath
    ? await sharedPromptMatches(input.executionContextSharedTaskPath, input.expectedSharedPromptHash)
    : false;
  const executionContextMatches = path.resolve(input.executionContextSourceWorkspacePath ?? "") === path.resolve(input.sourceWorkspace);

  const baseline = input.candidateBaselineManifestPath
    ? await loadBaselineManifest(input.candidateBaselineManifestPath)
    : undefined;
  const diff = workspaceSafe && (baseline ?? input.fallbackBaselineManifest)
    ? await diffAgainstBaseline(workspacePath, (baseline ?? input.fallbackBaselineManifest)!)
    : { changedFiles: [], addedFiles: [], removedFiles: [] };
  const changedFiles = [...diff.changedFiles, ...diff.addedFiles, ...diff.removedFiles].sort();
  const changedSourceFiles = changedFiles.filter(isMeaningfulSourcePath).length;
  const changedTestFiles = changedFiles.filter(isMeaningfulTestPath).length;
  const changedConfigFiles = changedFiles.filter(isMeaningfulConfigPath).length;
  const meaningfulChangedFiles = changedSourceFiles + changedTestFiles + changedConfigFiles;

  const sourceReportText = input.sourceSideReportPath ? await readTextIfExists(input.sourceSideReportPath) : undefined;
  const localReportText = input.candidateLocalReportPath ? await readTextIfExists(input.candidateLocalReportPath) : undefined;
  const sourceReport = assessTextArtifact(sourceReportText, "report");
  const localReport = assessTextArtifact(localReportText, "report");
  const finalMessage = assessTextArtifact(input.finalMessage, "final_message");

  const verification = mergeVerification(
    input.explicitVerification,
    sourceReport.verification,
    localReport.verification,
    finalMessage.verification,
  );

  const warnings = [
    ...sourceReport.warnings,
    ...localReport.warnings,
    ...finalMessage.warnings,
  ];

  const evidence: CandidateEvidence = {
    workspaceExists,
    workspaceSafe,
    executionContextMatches,
    sharedPromptHashMatches,
    meaningfulChangedFiles,
    changedSourceFiles,
    changedTestFiles,
    changedConfigFiles,
    changedFiles,
    verification,
    candidateLocalReportPath: localReport.available ? input.candidateLocalReportPath : undefined,
    sourceSideReportPath: sourceReport.available ? input.sourceSideReportPath : undefined,
    selectedReportPath: sourceReport.available
      ? input.sourceSideReportPath
      : localReport.available
        ? input.candidateLocalReportPath
        : undefined,
    priorTerminalStatus: input.priorTerminalStatus ?? "unknown",
    finalMessageFormat: finalMessage.format,
    warnings,
  };

  const hasSupplementaryEvidence = sourceReport.available
    || localReport.available
    || finalMessage.available
    || evidence.priorTerminalStatus !== "unknown";
  const verificationPassing = isVerificationPassing(verification);
  const verificationFailed = isVerificationFailed(verification);
  const invalidArtifact = sourceReport.invalid || localReport.invalid || finalMessage.invalid;

  if (!workspaceExists) {
    return finish("missing", "candidate workspace missing");
  }
  if (!workspaceSafe) {
    return finish("invalid", "candidate workspace is unsafe or resolves inside the source workspace");
  }
  if (!executionContextMatches || !sharedPromptHashMatches) {
    return finish("invalid", "execution context or shared task hash does not match this run");
  }
  if (meaningfulChangedFiles <= 0) {
    return finish("invalid", "candidate workspace has no meaningful source, test, or config changes");
  }
  if (invalidArtifact) {
    return finish("invalid", "candidate artifacts contain refusal, placeholder, or unusable markers");
  }
  if (verificationFailed) {
    return finish("invalid", "candidate verification explicitly failed");
  }
  if (verificationPassing && hasSupplementaryEvidence) {
    const reportContent = sourceReport.content ?? localReport.content;
    return finish("usable", undefined, reportContent, evidence.selectedReportPath);
  }
  if (hasSupplementaryEvidence) {
    return finish("partial", "verification evidence is incomplete", sourceReport.content ?? localReport.content, evidence.selectedReportPath);
  }
  return finish("partial", "supplementary report/session/final-message evidence is incomplete");

  function finish(
    classification: CandidateClassification,
    rerunReason?: string,
    reportContent?: string,
    reportPath?: string,
  ): CandidateClassificationResult {
    return {
      classification,
      evidence,
      verificationSummary: {
        typecheck: toVerificationSummaryStatus(verification.typecheck),
        test: toVerificationSummaryStatus(verification.test),
        build: toVerificationSummaryStatus(verification.build),
        commandsRun: [],
        notes: rerunReason ? [rerunReason] : [],
      },
      reportContent,
      reportPath,
      rerunReason,
    };
  }
}

export function renderDeterministicCandidateReport(input: {
  logicalPanelIndex: number;
  workspacePath: string;
  evidence: CandidateEvidence;
  classification: CandidateClassification;
}): string {
  return [
    "# Candidate Status",
    `- ${input.classification}`,
    "",
    "## Verification",
    `- typecheck: ${input.evidence.verification.typecheck ?? "unknown"}`,
    `- test: ${input.evidence.verification.test ?? "unknown"}`,
    `- build: ${input.evidence.verification.build ?? "unknown"}`,
    "",
    "## Files Changed",
    ...(input.evidence.changedFiles.length ? input.evidence.changedFiles.map((file) => `- ${file}`) : ["- none recorded"]),
    "",
    "## Recovery Evidence",
    `- panel: ${input.logicalPanelIndex}`,
    `- candidate workspace: ${input.workspacePath}`,
    `- source-side report path: ${input.evidence.sourceSideReportPath ?? "missing"}`,
    `- candidate-local report path: ${input.evidence.candidateLocalReportPath ?? "missing"}`,
    `- prior terminal status: ${input.evidence.priorTerminalStatus ?? "unknown"}`,
    `- final message format: ${input.evidence.finalMessageFormat}`,
    `- shared prompt hash matched: ${input.evidence.sharedPromptHashMatches ? "yes" : "no"}`,
    `- execution context matched: ${input.evidence.executionContextMatches ? "yes" : "no"}`,
    "",
    "## Classification Rationale",
    `- meaningful changed files: ${input.evidence.meaningfulChangedFiles}`,
    `- changed source files: ${input.evidence.changedSourceFiles}`,
    `- changed test files: ${input.evidence.changedTestFiles}`,
    `- changed config files: ${input.evidence.changedConfigFiles}`,
    ...(input.evidence.warnings.length ? input.evidence.warnings.map((warning) => `- warning: ${warning}`) : ["- warnings: none"]),
  ].join("\n");
}

function assessTextArtifact(text: string | undefined, kind: "report" | "final_message"): TextArtifactAssessment {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return {
      available: false,
      invalid: false,
      format: "missing",
      verification: {},
      warnings: kind === "report" ? ["report artifact missing"] : ["final message missing"],
    };
  }

  if (parseCandidateWorkspaceUnusable(trimmed).unusable) {
    return { available: false, invalid: true, format: "invalid", verification: {}, warnings: ["candidate workspace unusable marker present"] };
  }
  if (/FUSION_FULL_PROMPT_UNAVAILABLE/i.test(trimmed)) {
    return { available: false, invalid: true, format: "invalid", verification: {}, warnings: ["full prompt unavailable marker present"] };
  }
  if (/^FUSION_(?:ADVISORY|BLOCK)/i.test(trimmed)) {
    return { available: false, invalid: true, format: "invalid", verification: {}, warnings: ["advisory or block marker present"] };
  }
  if (/<[A-Z][A-Z0-9_]*>/.test(trimmed)) {
    return { available: false, invalid: true, format: "invalid", verification: {}, warnings: ["unresolved placeholder marker present"] };
  }
  if (/^(?:I cannot|Unable to|Cannot implement|I am unable)/i.test(trimmed) && trimmed.length < 500) {
    return { available: false, invalid: true, format: "invalid", verification: {}, warnings: ["refusal-only output present"] };
  }

  const validation = validateCandidateOutput(trimmed);
  const format: CandidateFinalMessageFormat = validation.status === "passed" || validation.status === "usable_with_warnings"
    ? "structured"
    : "concise";
  const warnings = format === "concise"
    ? [kind === "final_message" ? "final message is concise; treating it as supplementary evidence" : "report is concise; structured headings absent"]
    : [...validation.warnings];

  return {
    available: true,
    invalid: false,
    format,
    verification: parseVerificationFromText(trimmed),
    warnings,
    content: trimmed,
  };
}

function parseVerificationFromText(text: string): CandidateEvidence["verification"] {
  return {
    typecheck: parseVerificationMarker(text, "typecheck"),
    test: parseVerificationMarker(text, "test"),
    build: parseVerificationMarker(text, "build"),
  };
}

function parseVerificationMarker(text: string, label: "typecheck" | "test" | "build"): CandidateEvidenceVerificationStatus | undefined {
  const match = text.match(new RegExp(`${label}\\s*[:=-]\\s*(pass(?:ed)?|fail(?:ed)?)`, "i"));
  if (!match?.[1]) return undefined;
  return /^pass/i.test(match[1]) ? "passed" : "failed";
}

function mergeVerification(
  explicit: VerificationSummary | undefined,
  ...sources: CandidateEvidence["verification"][]
): CandidateEvidence["verification"] {
  return {
    typecheck: collapseVerificationStatus(explicit?.typecheck, sources.map((source) => source.typecheck)),
    test: collapseVerificationStatus(explicit?.test, sources.map((source) => source.test)),
    build: collapseVerificationStatus(explicit?.build, sources.map((source) => source.build)),
  };
}

function collapseVerificationStatus(
  explicit: VerificationSummary["typecheck"] | undefined,
  statuses: Array<CandidateEvidenceVerificationStatus | undefined>,
): CandidateEvidenceVerificationStatus {
  const mapped = explicit ? [mapVerificationSummaryStatus(explicit), ...statuses] : statuses;
  if (mapped.includes("failed")) return "failed";
  if (mapped.includes("passed")) return "passed";
  return "unknown";
}

function mapVerificationSummaryStatus(
  status: VerificationSummary["typecheck"] | VerificationSummary["test"] | VerificationSummary["build"],
): CandidateEvidenceVerificationStatus {
  if (status === "pass") return "passed";
  if (status === "fail") return "failed";
  return "unknown";
}

function toVerificationSummaryStatus(
  status: CandidateEvidenceVerificationStatus | undefined,
): VerificationSummary["typecheck"] {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  return "not_run";
}

function isVerificationPassing(verification: CandidateEvidence["verification"]): boolean {
  const values = [verification.typecheck, verification.test, verification.build];
  return !values.includes("failed") && values.includes("passed");
}

function isVerificationFailed(verification: CandidateEvidence["verification"]): boolean {
  return [verification.typecheck, verification.test, verification.build].includes("failed");
}

function isMeaningfulTestPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(normalized) || /\.(test|spec)\.[^.]+$/i.test(normalized);
}

function isMeaningfulConfigPath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "vitest.config.js",
    "jest.config.js",
    "vite.config.ts",
    "vite.config.js",
    "deno.json",
    "deno.jsonc",
  ].includes(base);
}

function isMeaningfulSourcePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (isMeaningfulTestPath(normalized) || isMeaningfulConfigPath(normalized)) return false;
  if (/^\./.test(path.basename(normalized))) return false;
  return /(^|\/)(src|lib|app|server|client)(\/|$)/i.test(normalized) || /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss)$/i.test(normalized);
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

async function sharedPromptMatches(sharedTaskPath: string, expectedHash: string): Promise<boolean> {
  const text = await readTextIfExists(sharedTaskPath);
  if (!text) return false;
  return hashSharedPanelPrompt(text) === expectedHash;
}
