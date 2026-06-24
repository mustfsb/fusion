import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PanelMode } from "../types.js";

export const INLINE_PROMPT_LINE_LIMIT = 50;
export const FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX = "FUSION_FULL_PROMPT_UNAVAILABLE:";

export type PromptTransportMode = "inline_full" | "brief_plus_file";
export type PromptTransportKind = "panel" | "judge" | "audit";

export type PromptTransportMetadata = {
  mode: PromptTransportMode;
  canonicalLineCount: number;
  inlineLineCount: number;
  canonicalSha256: string;
  inlineSha256: string;
  fullArtifactPath?: string;
  briefArtifactPath?: string;
};

export type PromptTransportBriefContext = {
  kind: PromptTransportKind;
  panelMode?: PanelMode;
  roleReminder?: string;
  outputExpectations?: string[];
};

export type PreparedPromptTransport = {
  mode: PromptTransportMode;
  canonicalPrompt: string;
  inlineTransportPrompt: string;
  metadata: PromptTransportMetadata;
};

const ARTIFACT_NAMES: Record<PromptTransportKind, { full: string; brief: string }> = {
  panel: { full: "shared-panel-prompt.full.md", brief: "shared-panel-prompt.brief.md" },
  judge: { full: "judge-context.full.md", brief: "judge-context.brief.md" },
  audit: { full: "post-build-audit-context.full.md", brief: "post-build-audit-context.brief.md" },
};

const BRIEF_HEADINGS_CAP = 6;
const BRIEF_OUTPUT_LINES_CAP = 2;

export function physicalLineCount(text: string): number {
  const trimmed = text.trimEnd();
  if (trimmed === "") return 0;
  return trimmed.split(/\r\n|\r|\n/).length;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseFullPromptUnavailable(content: string): { unavailable: true; path: string } | { unavailable: false } {
  const trimmed = content.trim();
  if (!trimmed.startsWith(FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX)) {
    return { unavailable: false };
  }
  const pathPart = trimmed.slice(FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX.length).trim();
  return { unavailable: true, path: pathPart };
}

export function isFullPromptUnavailableMarker(content: string | undefined | null): boolean {
  if (!content) return false;
  return parseFullPromptUnavailable(content).unavailable;
}

export function buildMandatoryReadProtocol(fullArtifactPath: string, canonicalSha256: string, canonicalLineCount: number): string {
  return [
    "MANDATORY BEFORE YOU BEGIN",
    "",
    "The complete canonical context is at:",
    "",
    fullArtifactPath,
    "",
    "You MUST use your file-reading tool to read the entire file before reasoning, planning, or responding.",
    "",
    "If reading is paginated, continue reading until EOF.",
    "Reading only the first chunk is not sufficient.",
    "",
    "The inline message is navigation only.",
    "It is incomplete and must never override, replace, summarize away, or weaken the full canonical context.",
    "",
    "The full file is the only source of truth for:",
    "- exact API names",
    "- validation rules",
    "- boundaries",
    "- examples",
    "- acceptance criteria",
    "- required tests",
    "",
    `Full context SHA-256: ${canonicalSha256}`,
    `Full context physical line count: ${canonicalLineCount}`,
    "",
    "If you cannot read the complete file, return exactly:",
    `${FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX} ${fullArtifactPath}`,
  ].join("\n");
}

function normalizeLines(text: string): string[] {
  const trimmed = text.trimEnd();
  if (trimmed === "") return [];
  return trimmed.split(/\r\n|\r|\n/);
}

function extractHeadings(lines: string[], maxEntries: number): string[] {
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (match) {
      headings.push(match[1].trim());
      if (headings.length >= maxEntries) break;
    }
  }
  return headings;
}

function extractTaskTitle(lines: string[]): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```")) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#+\s+/, "").trim();
      if (title) return title.slice(0, 160);
      continue;
    }
    return trimmed.slice(0, 160);
  }
  return undefined;
}

function defaultRoleReminder(kind: PromptTransportKind, panelMode?: PanelMode): string {
  if (kind === "panel") {
    if (panelMode === "candidate_build") {
      return "You are one independent expert panelist in a multi-model council (CANDIDATE BUILD mode). Produce a focused candidate implementation proposal. Do NOT create or edit files.";
    }
    if (panelMode === "advisory") {
      return "You are one independent expert panelist in a multi-model council (ADVISORY mode). Provide implementation advice and planning. Do NOT implement or write file contents.";
    }
    return "You are one independent expert panelist in a multi-model council. Be concrete, safety-conscious, and requirement-faithful.";
  }
  if (kind === "judge") {
    return "You are the judge/synthesizer for a multi-model council. The original user task is the sole source of truth. Read the full canonical context file before synthesis.";
  }
  return "You are running a post-build contract audit for /fusion-build. Read the live repository and the full audit context file before deciding. Do NOT edit files.";
}

function defaultOutputExpectations(kind: PromptTransportKind, panelMode?: PanelMode): string[] {
  if (kind === "panel") {
    if (panelMode === "candidate_build" || panelMode === "advisory") {
      return [
        "Include Contract Gate, Public Surface Matrix, Key Decision Points, Hidden Semantic Probe Plan, Implementation Guidance, and Self-Audit Risks.",
        "Treat the original task as authoritative; be concise and use bullets.",
      ];
    }
    return [
      "Output: requirement ledger, direct guidance, non-goals, implementation traps, tests needed, ambiguities, confidence level.",
    ];
  }
  if (kind === "judge") {
    return [
      "Return strict JSON with decision, summary, requirement checklist, requirement decision matrix, and finalOutput markdown.",
      "Prioritize the full context file and original task over panel consensus; reject contract-weakening substitutions.",
    ];
  }
  return [
    "Return strict JSON with status PASS | FIX_REQUIRED, summary, findings, and finalOutput markdown.",
    "Fail closed if package-entry tests or mandatory requirement tests are missing.",
  ];
}

export function buildTransportBrief(
  canonicalPrompt: string,
  fullArtifactPath: string,
  context: PromptTransportBriefContext,
): string {
  const canonicalSha256 = sha256Hex(canonicalPrompt);
  const canonicalLineCount = physicalLineCount(canonicalPrompt);
  const lines = normalizeLines(canonicalPrompt);
  const roleReminder = context.roleReminder ?? defaultRoleReminder(context.kind, context.panelMode);
  const outputExpectations = (context.outputExpectations ?? defaultOutputExpectations(context.kind, context.panelMode)).slice(0, BRIEF_OUTPUT_LINES_CAP);
  const protocol = buildMandatoryReadProtocol(fullArtifactPath, canonicalSha256, canonicalLineCount);
  const taskTitle = extractTaskTitle(lines);
  const headings = extractHeadings(lines, BRIEF_HEADINGS_CAP);

  const sections: string[] = [
    "# Fusion Prompt Transport Brief",
    "",
    roleReminder,
    "",
    "This inline brief is navigation only. The full canonical file is the only source of truth.",
    "",
    protocol,
  ];

  if (taskTitle) {
    sections.push("", "## Task", taskTitle);
  }

  if (headings.length > 0) {
    sections.push("", "## Sections in full file", ...headings.map((entry) => `- ${entry}`));
  }

  sections.push(
    "",
    "## Output expectations",
    ...outputExpectations.map((entry) => `- ${entry}`),
    "",
    "Literal requirements in the full canonical file override any wording in this brief.",
  );

  let brief = sections.join("\n");
  let briefLines = physicalLineCount(brief);

  if (briefLines > INLINE_PROMPT_LINE_LIMIT) {
    const trimmedHeadings = headings.slice(0, Math.max(0, BRIEF_HEADINGS_CAP - (briefLines - INLINE_PROMPT_LINE_LIMIT)));
    const compact: string[] = [
      "# Fusion Prompt Transport Brief",
      "",
      roleReminder,
      "",
      "This inline brief is navigation only. The full canonical file is the only source of truth.",
      "",
      protocol,
    ];
    if (taskTitle) compact.push("", "## Task", taskTitle);
    if (trimmedHeadings.length > 0) {
      compact.push("", "## Sections in full file", ...trimmedHeadings.map((entry) => `- ${entry}`));
    }
    compact.push(
      "",
      "## Output expectations",
      ...outputExpectations.slice(0, 1).map((entry) => `- ${entry}`),
      "",
      "Literal requirements in the full canonical file override this brief.",
    );
    brief = compact.join("\n");
    briefLines = physicalLineCount(brief);
  }

  if (briefLines > INLINE_PROMPT_LINE_LIMIT) {
    const minimal: string[] = [
      "# Fusion Prompt Transport Brief",
      "",
      roleReminder,
      "",
      protocol,
      "",
      "## Output expectations",
      ...outputExpectations.slice(0, 1).map((entry) => `- ${entry}`),
      "",
      "Read the full canonical file before responding. It overrides this brief.",
    ];
    brief = minimal.join("\n");
  }

  return brief;
}

async function writeArtifactAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export function artifactPathsForKind(artifactDir: string, kind: PromptTransportKind): { full: string; brief: string } {
  const names = ARTIFACT_NAMES[kind];
  return {
    full: path.resolve(artifactDir, names.full),
    brief: path.resolve(artifactDir, names.brief),
  };
}

export async function preparePromptTransport(input: {
  kind: PromptTransportKind;
  canonicalPrompt: string;
  artifactDir: string;
  briefContext?: PromptTransportBriefContext;
  writeArtifacts?: boolean;
}): Promise<PreparedPromptTransport> {
  const canonicalPrompt = input.canonicalPrompt;
  const canonicalLineCount = physicalLineCount(canonicalPrompt);
  const canonicalSha256 = sha256Hex(canonicalPrompt);
  const writeArtifacts = input.writeArtifacts !== false;

  if (canonicalLineCount <= INLINE_PROMPT_LINE_LIMIT) {
    const inlineTransportPrompt = canonicalPrompt;
    return {
      mode: "inline_full",
      canonicalPrompt,
      inlineTransportPrompt,
      metadata: {
        mode: "inline_full",
        canonicalLineCount,
        inlineLineCount: canonicalLineCount,
        canonicalSha256,
        inlineSha256: canonicalSha256,
      },
    };
  }

  const paths = artifactPathsForKind(input.artifactDir, input.kind);
  if (writeArtifacts) {
    await writeArtifactAtomic(paths.full, canonicalPrompt);
    const brief = buildTransportBrief(canonicalPrompt, paths.full, {
      kind: input.kind,
      ...input.briefContext,
    });
    await writeArtifactAtomic(paths.brief, brief);
    const inlineTransportPrompt = brief;
    const inlineLineCount = physicalLineCount(inlineTransportPrompt);
    return {
      mode: "brief_plus_file",
      canonicalPrompt,
      inlineTransportPrompt,
      metadata: {
        mode: "brief_plus_file",
        canonicalLineCount,
        inlineLineCount,
        canonicalSha256,
        inlineSha256: sha256Hex(inlineTransportPrompt),
        fullArtifactPath: paths.full,
        briefArtifactPath: paths.brief,
      },
    };
  }

  const inlineTransportPrompt = buildTransportBrief(canonicalPrompt, paths.full, {
    kind: input.kind,
    ...input.briefContext,
  });
  return {
    mode: "brief_plus_file",
    canonicalPrompt,
    inlineTransportPrompt,
    metadata: {
      mode: "brief_plus_file",
      canonicalLineCount,
      inlineLineCount: physicalLineCount(inlineTransportPrompt),
      canonicalSha256,
      inlineSha256: sha256Hex(inlineTransportPrompt),
      fullArtifactPath: paths.full,
      briefArtifactPath: paths.brief,
    },
  };
}
