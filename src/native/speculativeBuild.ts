import path from "node:path";
import type {
  CandidateWorkspaceInfo,
  ContextBundle,
  ContractGate,
  CouncilComparison,
  FusionTraceQuorum,
  MainBaselineTrace,
  MergePatchAdoptedInsight,
  MergePatchContract,
  MergePatchDecision,
  MergePatchGap,
  MergePatchPlanItem,
  MergePatchRejectedIdea,
  MergePatchSeverity,
  PanelResponse,
  SpeculativePanelCandidateTrace,
  VerificationSummary,
} from "../types.js";
import { renderContractGate } from "../council/contractGate.js";
import { renderCouncilComparisonMarkdown } from "../council/councilComparison.js";

/**
 * Speculative parallel build helpers.
 *
 * This module is intentionally free of model calls. It only:
 * - builds the speculative panel prompt (write only inside the candidate workspace);
 * - builds the Merge Patch Contract judge prompt (paths to candidate workspaces
 *   and main baseline artifacts, never full repo blobs inline);
 * - parses the judge's Merge Patch Contract markdown into a structured object;
 * - renders the speculative trace summary section.
 *
 * The visible native `fusion-judge` subagent does the actual comparison. The
 * primary/main agent does the actual patch application. This module never
 * edits implementation workspaces.
 */

export const MERGE_PATCH_CONTRACT_FULL_ARTIFACT = "merge-patch-contract.full.md";
export const MERGE_PATCH_CONTRACT_BRIEF_ARTIFACT = "merge-patch-contract.brief.md";

/** Exact marker a panel returns when its candidate workspace cannot be used. */
export const FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX = "FUSION_CANDIDATE_WORKSPACE_UNUSABLE:";

/** Relative directory for panel-owned outputs inside a candidate workspace. */
export const PANEL_OUTPUT_DIR_NAME = ".fusion-panel-output";

/**
 * Parse the candidate-workspace-unusable marker from a panel's final message.
 * A panel that returns this marker is treated as failed — never as a usable
 * candidate, and never as an advisory build report.
 */
export function parseCandidateWorkspaceUnusable(
  content: string,
): { unusable: true; path: string } | { unusable: false } {
  const trimmed = (content ?? "").trim();
  if (!trimmed.startsWith(FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX)) {
    return { unusable: false };
  }
  const pathPart = trimmed.slice(FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX.length).trim();
  return { unusable: true, path: pathPart };
}

export type ParsedPanelExecutionContext = {
  logicalPanelIndex: number;
  modelId: string;
  candidateWorkspacePath: string;
  sourceWorkspacePath: string;
  reportPath: string;
  notesPath?: string;
  sharedTaskPath: string;
  resolverVersion?: string;
};

/**
 * Parse a panel execution-context artifact produced by buildPanelExecutionContext.
 * Returns null when required fields cannot be extracted.
 */
export function parsePanelExecutionContext(text: string): ParsedPanelExecutionContext | null {
  const panelMatch = text.match(/Logical panel:\s*fusion-panel-(\d+)/i);
  const modelMatch = text.match(/Model:\s*(.+)/);
  const candidateMatch = text.match(/## Assigned Candidate Workspace\s*\n([^\n#]+)/);
  const sourceMatch = text.match(/## Prohibited Source Workspace\s*\n([^\n#]+)/);
  const reportMatch = text.match(/Report:\s*(.+)/);
  const notesMatch = text.match(/Optional notes:\s*(.+)/);
  const sharedTaskMatch = text.match(/Read the shared canonical task fully until EOF:\s*(.+)/);
  const resolverMatch = text.match(/Runtime resolver:\s*(.+)/);

  if (!panelMatch || !modelMatch || !candidateMatch || !sourceMatch || !reportMatch || !sharedTaskMatch) {
    return null;
  }

  return {
    logicalPanelIndex: Number.parseInt(panelMatch[1] ?? "0", 10),
    modelId: modelMatch[1]?.trim() ?? "",
    candidateWorkspacePath: candidateMatch[1]?.trim() ?? "",
    sourceWorkspacePath: sourceMatch[1]?.trim() ?? "",
    reportPath: reportMatch[1]?.trim() ?? "",
    notesPath: notesMatch?.[1]?.trim(),
    sharedTaskPath: sharedTaskMatch[1]?.trim() ?? "",
    resolverVersion: resolverMatch?.[1]?.trim(),
  };
}

export type SpeculativeSharedPanelPromptInput = {
  task: string;
  context: ContextBundle;
  contractGate: ContractGate;
  promptVerbosity?: import("../types.js").PromptVerbosity;
};

/**
 * Build the SHARED, workspace-agnostic canonical panel task.
 *
 * This is byte-identical for all three panels and contains ONLY the original
 * user task plus shared task-level instructions (contract gate, report format,
 * literal rules, context). It contains NO panel-specific placeholder and NO
 * concrete candidate-workspace path. The resolved per-panel execution
 * assignment (workspace paths, identity, output paths) is delivered separately
 * via each panel's execution-context file.
 */
export function buildSpeculativeSharedPanelPrompt(input: SpeculativeSharedPanelPromptInput): string {
  const compact = input.promptVerbosity !== "detailed";
  return [
    "You are one independent expert panelist in a Fusion speculative-parallel-build council.",
    "",
    "This file is the SHARED canonical task. It is byte-identical across all panels.",
    "Your per-panel execution assignment (your resolved candidate workspace, the",
    "prohibited source workspace, the absolute-path operating protocol, and your",
    "panel-owned output paths) is delivered separately in your execution-context",
    "file. Read that execution-context file FIRST, then read this shared task fully",
    "until EOF. This shared task intentionally contains no workspace paths.",
    "",
    "WRITE BOUNDARY (mandatory; concrete paths are in your execution-context file):",
    "- You may ONLY create, edit, patch, or delete files inside your assigned candidate workspace.",
    "- You MUST NOT write, edit, patch, or delete anything in the real source workspace or any other panel workspace.",
    "- The OpenCode runtime does not path-scope write permissions for subagents. Operate in absolute-path mode as your execution-context file instructs.",
    "",
    "TASK FLOW (you must actually perform all of these, not just plan them):",
    "1. Read your execution-context file, then this complete canonical task until EOF.",
    "2. Inspect ONLY your assigned candidate workspace.",
    "3. Implement a full competing solution for the user task inside your assigned candidate workspace.",
    "4. Create or update tests using the project's existing test framework.",
    "5. Run relevant typecheck/test/build commands INSIDE your candidate workspace.",
    "6. Write a concise candidate report to your panel-owned report path (use the Candidate Report Format below).",
    "7. Generate a patch/diff from your local candidate baseline.",
    "8. Return a short final visible response containing only completion state and artifact paths.",
    "",
    "Do NOT produce only a high-level plan or partial snippets. Do NOT paste complete candidate source into your final response — the candidate code lives in your candidate workspace.",
    "",
    "CANDIDATE REPORT FORMAT (write this to your panel-owned report path):",
    "# Candidate Status",
    "- completed / partial / blocked",
    "",
    "## Verification",
    "- commands run",
    "- pass/fail",
    "- known failures",
    "",
    "## Files Changed",
    "- exact paths",
    "",
    "## Literal Contract Coverage",
    "- concise requirements handled",
    "",
    "## Important Design Decisions",
    "- concise bullets",
    "",
    "## Hidden-Test Risks Addressed",
    "- concise bullets",
    "",
    "## Known Gaps / Risks",
    "- concise bullets",
    "",
    "CONTRACT GATE (correct it only when the original task clearly proves it wrong):",
    renderContractGate(input.contractGate, "Derived Contract Gate"),
    "",
    compact ? "Be concise. Prefer bullets. Cover common traps: package main/types vs dist, typed errors vs raw Error leaks, mutable internals exposed, partial mutation before failure, JSON-safety, determinism, tests emitted into dist." : "Be thorough. Enumerate explicit public symbols, consumer probes, and semantic edge cases separately instead of collapsing them into shorthand.",
    "",
    "LITERAL RULES:",
    "- Treat the original task as the source of truth. Consensus is not truth by vote count.",
    "- Do not weaken explicit exports, error types, options, field names, return behavior, or visibility requirements.",
    "- Do not assume an instance method satisfies a task that explicitly requests a package-root export.",
    "- If visible tests pass but hidden probes would still fail, your candidate is failing.",
    "- Flag ambiguities instead of inventing behavior.",
    "",
    "USER TASK:",
    input.task,
    "",
    renderContext(input.context),
  ].join("\n");
}

export type PanelExecutionContextInput = {
  logicalPanelIndex: number;
  modelId: string;
  candidateWorkspacePath: string;
  sourceWorkspacePath: string;
  reportPath: string;
  notesPath: string;
  sharedTaskPath: string;
  resolverVersion: string;
  runtimeModulePath?: string;
};

/**
 * Build a panel's resolved execution-context file. Contains ONLY concrete
 * resolved values — no placeholders. Delivered per panel; differs between
 * panels. The shared canonical task file stays identical.
 */
export function buildPanelExecutionContext(input: PanelExecutionContextInput): string {
  return [
    "# Fusion Panel Execution Assignment",
    "",
    "## Identity",
    `- Logical panel: fusion-panel-${input.logicalPanelIndex}`,
    `- Model: ${input.modelId}`,
    `- Runtime resolver: ${input.resolverVersion}`,
    ...(input.runtimeModulePath ? [`- Active module/build identity: ${input.runtimeModulePath}`] : []),
    "",
    "## Assigned Candidate Workspace",
    input.candidateWorkspacePath,
    "",
    "## Prohibited Source Workspace",
    input.sourceWorkspacePath,
    "",
    "## Write Boundary",
    "You may write only inside the Assigned Candidate Workspace.",
    "The real source workspace is prohibited for writes.",
    "",
    "## Runtime CWD Notice",
    "Your default native runtime working directory may still be the real source workspace.",
    "That does not grant write permission there.",
    "",
    "For every shell command that reads or writes project files, begin with:",
    "",
    `cd -- "${input.candidateWorkspacePath}" &&`,
    "",
    "For every direct file-read, file-write, patch, or edit tool:",
    "- use an absolute path under the Assigned Candidate Workspace;",
    "- never use a relative path;",
    "- never target the real source workspace.",
    "",
    "## Panel-Owned Output Paths",
    `- Report: ${input.reportPath}`,
    `- Optional notes: ${input.notesPath}`,
    "",
    "## Required Work",
    `- Read the shared canonical task fully until EOF: ${input.sharedTaskPath}`,
    "- Implement the complete candidate solution only in the Assigned Candidate Workspace.",
    "- Add/update tests there.",
    "- Run verification there.",
    "- Write the report to the panel-owned report path above.",
    "",
    "## Failure Marker",
    "If the assigned workspace is missing, not writable, unresolved, or cannot be safely used with available tools, return exactly:",
    "",
    `${FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX} ${input.candidateWorkspacePath}`,
    "",
  ].join("\n");
}

export type PanelInlineDispatchInput = {
  logicalPanelIndex: number;
  modelId: string;
  candidateWorkspacePath: string;
  sourceWorkspacePath: string;
  reportPath: string;
  executionContextPath: string;
  sharedTaskPath: string;
};

/**
 * Build the short (<=50 physical lines) per-panel inline dispatch prompt the
 * orchestrator sends as the panel Task `prompt`. It requires the panel to read
 * its execution-context file first, then the shared canonical task until EOF.
 * Carries the resolved candidate workspace, prohibited source workspace, and
 * absolute-path operating protocol so the panel binds correctly even though its
 * runtime CWD may still be the source workspace.
 */
export function buildPanelInlineDispatchPrompt(input: PanelInlineDispatchInput): string {
  return [
    `# Fusion Panel Dispatch — fusion-panel-${input.logicalPanelIndex} (${input.modelId})`,
    "",
    `You are fusion-panel-${input.logicalPanelIndex} in a Fusion speculative-parallel-build council.`,
    "",
    "MANDATORY READ ORDER (use your file-reading tool; read each file fully until EOF):",
    `1. Execution assignment FIRST: ${input.executionContextPath}`,
    `2. Shared canonical task SECOND (until EOF): ${input.sharedTaskPath}`,
    "",
    "The execution assignment holds your resolved candidate workspace, the prohibited",
    "source workspace, your write boundary, the absolute-path protocol, and your",
    "panel-owned output paths. The shared task holds the original user task and shared",
    "instructions and is byte-identical across all panels.",
    "",
    `Assigned candidate workspace (absolute): ${input.candidateWorkspacePath}`,
    `Prohibited source workspace (no writes): ${input.sourceWorkspacePath}`,
    `Write your candidate report to: ${input.reportPath}`,
    "",
    "ABSOLUTE-PATH MODE (mandatory):",
    "- Your default runtime working directory may be the prohibited source workspace.",
    "  That does NOT grant write permission there.",
    "- Prefix every shell command that touches project files with:",
    `  cd -- "${input.candidateWorkspacePath}" &&`,
    "- For every read/write/edit/patch tool use an absolute path under the candidate",
    "  workspace. Never use a relative path. Never write to the source workspace.",
    "",
    "Proceed when the candidate workspace is concrete, exists, and is writable. Do not",
    "refuse solely because your default CWD equals the source workspace.",
    "",
    "Then: implement a full competing solution only inside the candidate workspace,",
    "add/update tests, run verification there, and write the report to the path above.",
    "",
    "If you cannot read either full file, return exactly:",
    "FUSION_FULL_PROMPT_UNAVAILABLE: the absolute path you could not read",
    "",
    "If the candidate workspace is missing, not writable, unresolved, or unusable with",
    "your tools, return exactly:",
    `${FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX} ${input.candidateWorkspacePath}`,
    "",
    "Do not emit a long advisory essay when workspace binding fails — return the exact",
    "marker above instead. Keep your final visible message short: completion state and",
    "artifact paths only.",
  ].join("\n");
}

export type MergePatchContractPromptInput = {
  task: string;
  context: ContextBundle;
  contractGate: ContractGate;
  realWorkspacePath: string;
  mainBaseline: MainBaselineTrace;
  candidateWorkspaces: CandidateWorkspaceInfo[];
  panelCandidates: SpeculativePanelCandidateTrace[];
  panel: PanelResponse[];
  quorum: FusionTraceQuorum;
  councilComparison?: CouncilComparison;
  councilComparisonMarkdown?: string;
  sourceArtifactDir: string;
  externalCandidateStagingDir: string;
  mergePatchContractPath: string;
};

/**
 * Build the Merge Patch Contract judge prompt.
 *
 * The judge receives ABSOLUTE PATHS to every candidate artifact and workspace,
 * plus the main baseline manifest/patch paths — never full repository blobs
 * inlined into the prompt. The full context is written to a canonical file and
 * the transport brief points the judge at it (the existing 50-line
 * `brief_plus_file` transport handles this when the canonical prompt exceeds
 * 50 physical lines).
 */
export function buildMergePatchContractPrompt(input: MergePatchContractPromptInput): string {
  const comparisonBlock = input.councilComparisonMarkdown
    ? ["Council Comparison Dossier (deterministic; reconcile against the original task — consensus is not truth by vote count):", "", input.councilComparisonMarkdown, ""]
    : input.councilComparison
      ? ["Council Comparison Dossier (deterministic; reconcile against the original task — consensus is not truth by vote count):", "", renderCouncilComparisonMarkdown(input.councilComparison), ""]
      : [];

  const candidateLines = input.candidateWorkspaces.map((ws, index) => {
    const trace = input.panelCandidates[index];
    const response = input.panel[index];
    const status = trace?.status ?? "queued";
    const reportOk = trace?.reportPath ? `report=${trace.reportPath}` : "report=missing";
    const patchOk = trace?.patchPath ? `patch=${trace.patchPath}` : "patch=missing";
    const verification = trace?.verification
      ? `verification(typecheck=${trace.verification.typecheck ?? "n/a"},test=${trace.verification.test ?? "n/a"},build=${trace.verification.build ?? "n/a"})`
      : "verification=not_recorded";
    const contentChars = response?.content?.length ?? 0;
    return `- Panel ${ws.logicalPanelIndex}: status=${status}; workspace=${ws.workspacePath}; ${reportOk}; ${patchOk}; ${verification}; reportChars=${contentChars}`;
  });

  return [
    "You are the visible native fusion-judge subagent for a Fusion speculative-parallel-build run.",
    "",
    "Your job: compare the REAL main workspace implementation against the panel candidate implementations, the original task, and the verification evidence. Produce a targeted Merge Patch Contract — NOT a giant implementation essay.",
    "",
    "READ BOUNDARY (mandatory):",
    "- You are READ-ONLY against the real main workspace, every panel candidate workspace, and all source baseline artifacts.",
    "- You may write ONLY your designated analysis artifacts under the run directory (the Merge Patch Contract files).",
    "- You MUST NOT edit the real workspace, edit panel workspaces, merge panel patches directly, replace the main implementation wholesale, prefer a panel only because it has more code, or weaken literal requirements to fit visible tests.",
    "",
    "INPUTS (read the full files at these absolute paths — do not guess from this brief):",
    `- Original canonical task artifact: see the transport brief / shared-panel-prompt.full.md`,
    `- Real main workspace absolute path: ${input.realWorkspacePath}`,
    `- Main baseline manifest: ${input.mainBaseline.manifestPath ?? "(not recorded)"}`,
    `- Main baseline patch/diff: ${input.mainBaseline.patchPath ?? "(not recorded)"}`,
    `- Main baseline verification: ${formatVerification(input.mainBaseline.verification)}`,
    `- Main baseline status: ${input.mainBaseline.status}`,
    `- Main baseline changed files: ${input.mainBaseline.changedFiles.length ? input.mainBaseline.changedFiles.join(", ") : "(none recorded)"}`,
    "",
    "PANEL CANDIDATE WORKSPACES (read each candidate workspace and its report/patch as needed):",
    ...candidateLines,
    "",
    `- Source-side run artifact directory: ${input.sourceArtifactDir}`,
    `- External candidate staging directory: ${input.externalCandidateStagingDir}`,
    `- Write your Merge Patch Contract to: ${input.mergePatchContractPath}`,
    "",
    "CONTRACT GATE:",
    renderContractGate(input.contractGate, "Contract Gate"),
    "",
    "CONFLICT-RESOLUTION HIERARCHY (apply in this exact order):",
    "1. Explicit original task wording.",
    "2. Existing public API contract stated by the task.",
    "3. Exact error/type/boundary requirements.",
    "4. Security and immutability requirements.",
    "5. Determinism and serialization requirements.",
    "6. Safe compatibility behavior.",
    "7. Optional product/design ideas.",
    "Never resolve a conflict by simple majority vote if the task specifies the answer.",
    "",
    "ANTI-DRIFT RULES — reject any candidate or synthesis that:",
    "- converts a literal package-root export into an instance-only API;",
    "- substitutes boolean/return-value behavior where typed errors were required;",
    "- accepts permissive input validation when the task says non-empty strings;",
    "- leaks token/secret/internal state through public outputs;",
    "- claims success from visible-test-only behavior when hidden probes would still fail;",
    "- pushes optional feature work that displaces literal requirements;",
    "- offers vague architecture advice without executable tests.",
    "",
    ...comparisonBlock,
    "Your output MUST be a markdown file written to the Merge Patch Contract path above, with EXACTLY these sections:",
    "",
    "# Speculative Build Comparison",
    "",
    "## Main Baseline Status",
    "- verification status",
    "- key implementation paths",
    "- blockers if any",
    "",
    "## Panel Candidate Status",
    "- panel 1 / 2 / 3 status",
    "- usable / partial / failed / excluded",
    "- verification evidence",
    "",
    "## Literal Requirement Gaps in Main",
    "For each issue:",
    "- severity: BLOCKER | MUST_FIX | SAFE_ADDITION | REJECTED",
    "- literal requirement",
    "- observed main behavior",
    "- evidence: exact file path and symbol",
    "- relevant panel evidence",
    "- concrete failure scenario",
    "- required correction",
    "- required regression test",
    "",
    "## Main Strengths to Preserve",
    "- exact behavior that must not regress",
    "",
    "## Adopted Panel Insights",
    "For each item:",
    "- source panel(s)",
    "- why it is correct",
    "- why it fits the main architecture",
    "- exact implementation direction",
    "- required test",
    "",
    "## Rejected Panel Ideas",
    "For each item:",
    "- source panel",
    "- reason: speculative / incorrect / duplicate / scope risk / incompatible / task conflict",
    "",
    "## Patch Plan",
    "Ordered minimal actions:",
    "1. file path",
    "2. symbol",
    "3. required change",
    "4. required regression test",
    "5. risk",
    "",
    "## Final Patch Decision",
    "- PATCH_REQUIRED",
    "- NO_PATCH_REQUIRED",
    "- MAIN_BUILD_BLOCKED",
    "",
    "ADOPTION RULES:",
    "- Adopt a panel insight only when it is literal-contract compliant, evidence-backed, non-conflicting, compatible with the main architecture, and worth the patch risk.",
    "- Literal blockers and must-fix issues always outrank optional enhancements.",
    "- Mark the final decision as PATCH_REQUIRED only when at least one BLOCKER or MUST_FIX item exists. Use NO_PATCH_REQUIRED when the main baseline already satisfies the literal contract. Use MAIN_BUILD_BLOCKED only when the main baseline cannot reach compliance via targeted patches.",
    "",
    "USER TASK:",
    input.task,
    "",
    renderContext(input.context),
  ].join("\n");
}

function formatVerification(v?: VerificationSummary): string {
  if (!v) return "(not recorded)";
  const parts: string[] = [];
  if (v.typecheck) parts.push(`typecheck=${v.typecheck}`);
  if (v.test) parts.push(`test=${v.test}`);
  if (v.build) parts.push(`build=${v.build}`);
  if (v.commandsRun?.length) parts.push(`commands=${v.commandsRun.join("; ")}`);
  return parts.length ? parts.join(", ") : "(not recorded)";
}

function renderContext(context: ContextBundle): string {
  const files = context.files
    .map((file) => `### File: ${file.path}${file.truncated ? " (truncated)" : ""}\n\n\`\`\`\n${file.content}\n\`\`\``)
    .join("\n\n");
  return [
    "Context summary:",
    context.summary || "No context supplied.",
    context.diff ? `\nGit diff:\n\`\`\`diff\n${context.diff}\n\`\`\`` : "",
    files ? `\nSelected/project files:\n${files}` : "",
  ].filter(Boolean).join("\n");
}

const SEVERITY_VALUES: MergePatchSeverity[] = ["BLOCKER", "MUST_FIX", "SAFE_ADDITION", "REJECTED"];
const DECISION_VALUES: MergePatchDecision[] = ["PATCH_REQUIRED", "NO_PATCH_REQUIRED", "MAIN_BUILD_BLOCKED"];

/**
 * Parse a Merge Patch Contract markdown document into a structured object.
 *
 * The parser is intentionally tolerant: it scans for the required section
 * headings and extracts bullet/numbered items. It never throws — when a
 * section is missing or unparsable, it returns an empty array/undefined so the
 * caller can decide how to handle a partial contract.
 */
export function parseMergePatchContract(text: string): MergePatchContract {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections = splitSections(lines);

  const mainBaselineStatus = extractSectionBody(sections, "Main Baseline Status");
  const mainBaselineKeyPaths = extractBulletItems(sections, "Main Baseline Status");
  const mainBaselineBlockers = mainBaselineStatus
    .split("\n")
    .filter((line) => /blocker|blocked/i.test(line))
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

  const panelCandidateStatus = extractPanelCandidateStatus(sections);
  const gaps = extractGaps(sections);
  const mainStrengthsToPreserve = extractBulletItems(sections, "Main Strengths to Preserve");
  const adoptedInsights = extractAdoptedInsights(sections);
  const rejectedIdeas = extractRejectedIdeas(sections);
  const patchPlan = extractPatchPlan(sections);
  const finalDecision = extractFinalDecision(sections);

  return {
    mainBaselineStatus,
    mainBaselineKeyPaths,
    mainBaselineBlockers,
    panelCandidateStatus,
    gaps,
    mainStrengthsToPreserve,
    adoptedInsights,
    rejectedIdeas,
    patchPlan,
    finalDecision,
  };
}

type SectionMap = Map<string, string[]>;

function splitSections(lines: string[]): SectionMap {
  const sections = new Map<string, string[]>();
  let current = "__preamble__";
  let buffer: string[] = [];
  const flush = () => {
    sections.set(current, buffer);
    buffer = [];
  };
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      current = headingMatch[1].trim().toLowerCase();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function extractSectionBody(sections: SectionMap, heading: string): string {
  const body = sections.get(heading.toLowerCase()) ?? [];
  return body.join("\n").trim();
}

function extractBulletItems(sections: SectionMap, heading: string): string[] {
  const body = sections.get(heading.toLowerCase()) ?? [];
  return body
    .map((line) => line.trim())
    .filter((line) => /^(?:[*-]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^\s*(?:[*-]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

function extractPanelCandidateStatus(sections: SectionMap): MergePatchContract["panelCandidateStatus"] {
  const body = sections.get("panel candidate status") ?? [];
  const result: MergePatchContract["panelCandidateStatus"] = [];
  for (const line of body) {
    const match = line.match(/panel\s+(\d+)\s*[:\-].*(?:usable|partial|failed|excluded)/i);
    if (match) {
      const panelIndex = Number(match[1]);
      const status = /usable/i.test(line) ? "usable" : /partial/i.test(line) ? "partial" : /excluded/i.test(line) ? "excluded" : "failed";
      const verificationMatch = line.match(/verification\s*[:=]\s*([^\n;]+)/i);
      result.push({ panelIndex, status, verificationEvidence: verificationMatch?.[1]?.trim() });
    }
  }
  return result;
}

function extractGaps(sections: SectionMap): MergePatchGap[] {
  const body = sections.get("literal requirement gaps in main") ?? [];
  const gaps: MergePatchGap[] = [];
  let current: Partial<MergePatchGap> & { severity?: MergePatchSeverity } = {};
  const flush = () => {
    if (current.severity && current.literalRequirement && current.requiredCorrection) {
      gaps.push({
        severity: current.severity,
        literalRequirement: current.literalRequirement,
        observedMainBehavior: current.observedMainBehavior ?? "",
        evidence: current.evidence ?? "",
        relevantPanelEvidence: current.relevantPanelEvidence,
        failureScenario: current.failureScenario,
        requiredCorrection: current.requiredCorrection,
        requiredRegressionTest: current.requiredRegressionTest,
      });
    }
    current = {};
  };
  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const severityMatch = line.match(/severity\s*[:=]\s*(BLOCKER|MUST_FIX|SAFE_ADDITION|REJECTED)/i);
    if (severityMatch) {
      if (current.severity) flush();
      current.severity = severityMatch[1].toUpperCase() as MergePatchSeverity;
      continue;
    }
    const literalMatch = line.match(/literal\s+requirement\s*[:=]\s*(.+)/i);
    if (literalMatch) { current.literalRequirement = literalMatch[1].trim(); continue; }
    const observedMatch = line.match(/observed\s+main\s+behavior\s*[:=]\s*(.+)/i);
    if (observedMatch) { current.observedMainBehavior = observedMatch[1].trim(); continue; }
    const evidenceMatch = line.match(/evidence\s*[:=]\s*(.+)/i);
    if (evidenceMatch) { current.evidence = evidenceMatch[1].trim(); continue; }
    const panelEvidenceMatch = line.match(/(?:relevant\s+)?panel\s+evidence\s*[:=]\s*(.+)/i);
    if (panelEvidenceMatch) { current.relevantPanelEvidence = panelEvidenceMatch[1].trim(); continue; }
    const scenarioMatch = line.match(/(?:concrete\s+)?failure\s+scenario\s*[:=]\s*(.+)/i);
    if (scenarioMatch) { current.failureScenario = scenarioMatch[1].trim(); continue; }
    const correctionMatch = line.match(/required\s+correction\s*[:=]\s*(.+)/i);
    if (correctionMatch) { current.requiredCorrection = correctionMatch[1].trim(); continue; }
    const regressionMatch = line.match(/required\s+regression\s+test\s*[:=]\s*(.+)/i);
    if (regressionMatch) { current.requiredRegressionTest = regressionMatch[1].trim(); continue; }
  }
  flush();
  return gaps;
}

function extractAdoptedInsights(sections: SectionMap): MergePatchAdoptedInsight[] {
  const body = sections.get("adopted panel insights") ?? [];
  const insights: MergePatchAdoptedInsight[] = [];
  let current: Partial<MergePatchAdoptedInsight> & { sourcePanelsRaw?: string } = {};
  const flush = () => {
    if (current.idea && current.whyCorrect) {
      insights.push({
        sourcePanels: parsePanelList(current.sourcePanelsRaw),
        idea: current.idea,
        whyCorrect: current.whyCorrect,
        whyFitsMainArchitecture: current.whyFitsMainArchitecture ?? "",
        implementationDirection: current.implementationDirection ?? "",
        requiredTest: current.requiredTest,
      });
    }
    current = {};
  };
  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    const sourceMatch = line.match(/source\s+panel[s]?\s*[:=]\s*(.+)/i);
    if (sourceMatch) { if (current.idea) flush(); current.sourcePanelsRaw = sourceMatch[1].trim(); continue; }
    const ideaMatch = line.match(/idea\s*[:=]\s*(.+)/i);
    if (ideaMatch) { current.idea = ideaMatch[1].trim(); continue; }
    const whyCorrectMatch = line.match(/why\s+(?:it\s+is\s+)?correct\s*[:=]\s*(.+)/i);
    if (whyCorrectMatch) { current.whyCorrect = whyCorrectMatch[1].trim(); continue; }
    const fitsMatch = line.match(/why\s+it\s+fits\s+the\s+main\s+architecture\s*[:=]\s*(.+)/i);
    if (fitsMatch) { current.whyFitsMainArchitecture = fitsMatch[1].trim(); continue; }
    const directionMatch = line.match(/(?:exact\s+)?implementation\s+direction\s*[:=]\s*(.+)/i);
    if (directionMatch) { current.implementationDirection = directionMatch[1].trim(); continue; }
    const testMatch = line.match(/required\s+test\s*[:=]\s*(.+)/i);
    if (testMatch) { current.requiredTest = testMatch[1].trim(); continue; }
  }
  flush();
  return insights;
}

function extractRejectedIdeas(sections: SectionMap): MergePatchRejectedIdea[] {
  const body = sections.get("rejected panel ideas") ?? [];
  const ideas: MergePatchRejectedIdea[] = [];
  let current: Partial<MergePatchRejectedIdea> = {};
  const flush = () => {
    if (current.idea && current.sourcePanel != null) {
      ideas.push({
        sourcePanel: current.sourcePanel,
        idea: current.idea,
        reason: current.reason ?? "",
      });
    }
    current = {};
  };
  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    const sourceMatch = line.match(/source\s+panel\s*[:=]\s*(\d+)/i);
    if (sourceMatch) { if (current.idea) flush(); current.sourcePanel = Number(sourceMatch[1]); continue; }
    const ideaMatch = line.match(/idea\s*[:=]\s*(.+)/i);
    if (ideaMatch) { current.idea = ideaMatch[1].trim(); continue; }
    const reasonMatch = line.match(/reason\s*[:=]\s*(.+)/i);
    if (reasonMatch) { current.reason = reasonMatch[1].trim(); continue; }
  }
  flush();
  return ideas;
}

function extractPatchPlan(sections: SectionMap): MergePatchPlanItem[] {
  const body = sections.get("patch plan") ?? [];
  const items: MergePatchPlanItem[] = [];
  let current: Partial<MergePatchPlanItem> = {};
  let inNumberedItem = false;
  const flush = () => {
    if (current.filePath) {
      items.push({
        filePath: current.filePath,
        symbol: current.symbol,
        requiredChange: current.requiredChange ?? "",
        requiredRegressionTest: current.requiredRegressionTest,
        risk: current.risk,
      });
    }
    current = {};
    inNumberedItem = false;
  };
  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) {
      if (inNumberedItem) flush();
      continue;
    }
    const numberedMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      if (inNumberedItem) flush();
      inNumberedItem = true;
      // First numbered line is the file path
      current.filePath = numberedMatch[2].trim();
      continue;
    }
    if (inNumberedItem) {
      const symbolMatch = line.match(/symbol\s*[:=]\s*(.+)/i);
      if (symbolMatch) { current.symbol = symbolMatch[1].trim(); continue; }
      const changeMatch = line.match(/required\s+change\s*[:=]\s*(.+)/i);
      if (changeMatch) { current.requiredChange = changeMatch[1].trim(); continue; }
      const testMatch = line.match(/required\s+regression\s+test\s*[:=]\s*(.+)/i);
      if (testMatch) { current.requiredRegressionTest = testMatch[1].trim(); continue; }
      const riskMatch = line.match(/risk\s*[:=]\s*(.+)/i);
      if (riskMatch) { current.risk = riskMatch[1].trim(); continue; }
    }
  }
  flush();
  return items;
}

function extractFinalDecision(sections: SectionMap): MergePatchDecision {
  const body = sections.get("final patch decision") ?? [];
  const text = body.join("\n");
  for (const value of DECISION_VALUES) {
    if (new RegExp(`\\b${value}\\b`, "i").test(text)) {
      return value;
    }
  }
  // Fallback: infer from gaps
  return "NO_PATCH_REQUIRED";
}

function parsePanelList(raw?: string): number[] {
  if (!raw) return [];
  return (raw.match(/\d+/g) ?? []).map(Number);
}

/**
 * Decide which patch items the main agent should apply, given a parsed Merge
 * Patch Contract. REJECTED items are never applied. SAFE_ADDITION items are
 * applied only when explicitly marked non-breaking and low-risk by the judge.
 */
export function selectApprovedPatchItems(contract: MergePatchContract): {
  blockers: MergePatchGap[];
  mustFix: MergePatchGap[];
  safeAdditions: MergePatchGap[];
  rejected: MergePatchGap[];
  patchPlan: MergePatchPlanItem[];
} {
  const blockers = contract.gaps.filter((g) => g.severity === "BLOCKER");
  const mustFix = contract.gaps.filter((g) => g.severity === "MUST_FIX");
  const safeAdditions = contract.gaps.filter((g) => g.severity === "SAFE_ADDITION");
  const rejected = contract.gaps.filter((g) => g.severity === "REJECTED");
  return { blockers, mustFix, safeAdditions, rejected, patchPlan: contract.patchPlan };
}

/**
 * Render the speculative parallel build trace summary section. Appended to the
 * standard trace summary when `trace.speculative` is present.
 */
export function renderSpeculativeTraceSummary(speculative: NonNullable<import("../types.js").FusionRunTrace["speculative"]>): string[] {
  const lines: string[] = [];
  lines.push("", "## Speculative Parallel Build");
  lines.push(`- mode: ${speculative.mode}`);
  lines.push(`- source workspace: ${speculative.sourceWorkspace}`);
  lines.push(`- source artifact directory: ${speculative.sourceArtifactDir}`);
  lines.push(`- external candidate staging directory: ${speculative.externalCandidateStagingDir}`);
  lines.push(`- source baseline manifest: ${speculative.sourceBaselineManifestPath}`);
  lines.push("");
  {
    const resolution = speculative.pathResolution;
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
  lines.push(`- started: ${speculative.mainBaseline.startedAt ?? "n/a"}`);
  lines.push(`- completed: ${speculative.mainBaseline.completedAt ?? "n/a"}`);
  lines.push(`- verification: ${formatVerification(speculative.mainBaseline.verification)}`);
  lines.push(`- changed files: ${speculative.mainBaseline.changedFiles.length ? speculative.mainBaseline.changedFiles.join(", ") : "none"}`);
  lines.push("");
  lines.push("Panel candidates:");
  for (const candidate of speculative.panelCandidates) {
    lines.push(`- panel ${candidate.logicalPanelIndex}: model=${candidate.model}; workspace=${candidate.workspacePath}; status=${candidate.status}; report=${candidate.reportPath ?? "n/a"}; verification=${formatVerification(candidate.verification)}`);
  }
  lines.push("");
  lines.push("Judge:");
  lines.push(`- quorum: ${speculative.panelCandidates.filter((c) => c.status === "usable" || c.status === "partial").length}/${speculative.panelCandidates.length} usable+partial`);
  lines.push(`- merge patch contract: ${speculative.mergePatchContractPath ?? "n/a"}`);
  lines.push(`- final decision: ${speculative.mergePatchDecision ?? "n/a"}`);
  const blockers = speculative.appliedPatchItems?.filter((i) => i.severity === "BLOCKER") ?? [];
  const mustFix = speculative.appliedPatchItems?.filter((i) => i.severity === "MUST_FIX") ?? [];
  const safeAdds = speculative.appliedPatchItems?.filter((i) => i.severity === "SAFE_ADDITION") ?? [];
  lines.push(`- blockers: ${blockers.length}`);
  lines.push(`- must-fix: ${mustFix.length}`);
  lines.push(`- safe additions: ${safeAdds.length}`);
  lines.push("");
  lines.push("Patch phase:");
  const applied = speculative.appliedPatchItems?.filter((i) => i.status === "applied") ?? [];
  const skipped = speculative.appliedPatchItems?.filter((i) => i.status === "skipped") ?? [];
  const failed = speculative.appliedPatchItems?.filter((i) => i.status === "failed") ?? [];
  lines.push(`- applied: ${applied.length}`);
  lines.push(`- skipped: ${skipped.length}`);
  lines.push(`- failed: ${failed.length}`);
  return lines;
}

export function mergePatchArtifactPaths(speculativeDir: string): { full: string; brief: string } {
  return {
    full: path.resolve(speculativeDir, MERGE_PATCH_CONTRACT_FULL_ARTIFACT),
    brief: path.resolve(speculativeDir, MERGE_PATCH_CONTRACT_BRIEF_ARTIFACT),
  };
}

export const MERGE_PATCH_SEVERITY_VALUES = SEVERITY_VALUES;
export const MERGE_PATCH_DECISION_VALUES = DECISION_VALUES;
