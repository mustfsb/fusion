import type { ContractGate, ContractGateTraceSummary } from "../types.js";

const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const BULLET_RE = /^\s*(?:[*-]|\d+\.)\s+/;
const FIELD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*/;
const BACKTICK_RE = /`([^`]+)`/g;

export function extractContractGate(task: string): ContractGate {
  const normalizedTask = task.replace(/\r\n/g, "\n");
  const lines = normalizedTask.split("\n");
  const packageRootExports = dedupe([
    ...extractExplicitExports(lines, (line) => /^\s*export\s*:\s*$/i.test(line)),
    ...extractExplicitExports(lines, (line) => /^\s*export\s+(?:these\s+)?(?:typed\s+)?errors\s*:\s*$/i.test(line)),
    ...extractInlineExports(lines),
  ]).map(symbolNameFromSignature);
  const requiredTypesAndErrors = dedupe([
    ...extractExplicitExports(lines, (line) => /^\s*export\s+(?:these\s+)?(?:typed\s+)?errors\s*:\s*$/i.test(line)),
    ...collectNamedErrors(lines),
  ]).map(symbolNameFromSignature);
  const requiredOptionAndFieldNames = collectExplicitFieldNames(normalizedTask);
  const requiredInstanceMethods = collectExplicitInstanceMethods(lines, packageRootExports);
  const returnAndThrowContracts = collectReturnAndThrowContracts(lines);
  const behavioralBoundaries = collectBehavioralBoundaries(lines);
  const consumerCompatibility = collectCompatibilityRecommendations(lines, requiredOptionAndFieldNames);
  const externalConsumerProbes = buildExternalConsumerProbes({
    packageRootExports,
    requiredTypesAndErrors,
    requiredOptionAndFieldNames,
    returnAndThrowContracts,
    behavioralBoundaries,
    consumerCompatibility,
  });

  const literalPublicSurface = compact([
    packageRootExports.length
      ? `Required package-root exports: ${packageRootExports.join(", ")}.`
      : undefined,
    requiredInstanceMethods.length
      ? `Explicit instance methods: ${requiredInstanceMethods.join(", ")}.`
      : undefined,
    requiredTypesAndErrors.length
      ? `Required typed errors/types: ${requiredTypesAndErrors.join(", ")}.`
      : undefined,
    requiredOptionAndFieldNames.length
      ? `Exact option/property names mentioned in the task: ${requiredOptionAndFieldNames.join(", ")}.`
      : undefined,
    ...returnAndThrowContracts,
  ]);

  return {
    literalPublicSurface,
    behavioralBoundaries: compact(behavioralBoundaries),
    consumerCompatibility: compact(consumerCompatibility),
    externalConsumerProbes: compact(externalConsumerProbes),
    packageRootExports,
    requiredInstanceMethods,
    requiredTypesAndErrors,
    requiredOptionAndFieldNames,
    returnAndThrowContracts: compact(returnAndThrowContracts),
  };
}

export function renderContractGate(contractGate: ContractGate, title = "Contract Gate"): string {
  return [
    `## ${title}`,
    "### A. Literal Public Surface",
    ...renderList(contractGate.literalPublicSurface),
    "",
    "### B. Behavioral Boundaries",
    ...renderList(contractGate.behavioralBoundaries),
    "",
    "### C. Consumer Compatibility",
    ...renderList(contractGate.consumerCompatibility),
    "",
    "### D. External Consumer Probes",
    ...renderList(contractGate.externalConsumerProbes),
  ].join("\n");
}

export function summarizeContractGate(contractGate: ContractGate): ContractGateTraceSummary {
  return {
    literalRequirementsDetected: contractGate.literalPublicSurface.length + contractGate.behavioralBoundaries.length,
    publicExportsRequired: contractGate.packageRootExports,
    consumerProbesRequired: contractGate.externalConsumerProbes,
    compatibilityRecommendations: contractGate.consumerCompatibility,
  };
}

function extractExplicitExports(lines: string[], matchesStart: (line: string) => boolean): string[] {
  for (let index = 0; index < lines.length; index += 1) {
    if (!matchesStart(lines[index])) continue;
    const symbols: string[] = [];
    let blankStreak = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (HEADING_RE.test(line) && symbols.length) break;
      if (!line.trim()) {
        blankStreak += 1;
        if (symbols.length && blankStreak >= 2) break;
        continue;
      }
      blankStreak = 0;
      if (!BULLET_RE.test(line)) {
        if (symbols.length) break;
        continue;
      }
      const backticks = extractBackticks(line);
      if (backticks.length === 0) {
        if (symbols.length) break;
        continue;
      }
      for (const value of backticks) symbols.push(value);
    }
    if (symbols.length) return dedupe(symbols);
  }
  return [];
}

function collectNamedErrors(lines: string[]): string[] {
  const values: string[] = [];
  for (const line of lines) {
    if (!/error|throw/i.test(line)) continue;
    for (const token of extractBackticks(line)) {
      if (/Error$/.test(token)) values.push(token);
    }
  }
  return dedupe(values);
}

function extractInlineExports(lines: string[]): string[] {
  const values: string[] = [];
  for (const line of lines) {
    if (!/^\s*(?:[*-]|\d+\.)\s+.*\bexport\b/i.test(line)) continue;
    for (const token of extractBackticks(line)) values.push(token);
  }
  return dedupe(values);
}

function collectExplicitFieldNames(task: string): string[] {
  const names: string[] = [];
  for (const match of task.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    const block = match[1] ?? "";
    for (const line of block.split("\n")) {
      const field = line.match(FIELD_RE)?.[1];
      if (field) names.push(field);
    }
  }
  return dedupe(names);
}

function collectExplicitInstanceMethods(lines: string[], packageRootExports: string[]): string[] {
  const packageExportSet = new Set(packageRootExports);
  const methods: string[] = [];
  for (const line of lines) {
    if (!/must expose|returned .* expose|store methods?/i.test(line)) continue;
    for (const token of extractBackticks(line)) {
      const symbol = symbolNameFromSignature(token);
      if (!packageExportSet.has(symbol)) methods.push(symbol);
    }
  }
  return dedupe(methods);
}

function collectReturnAndThrowContracts(lines: string[]): string[] {
  const contracts: string[] = [];
  let currentApi: string | undefined;
  for (const line of lines) {
    const headingMatch = line.match(/^\s*###\s+`([^`]+)`/);
    if (headingMatch) {
      currentApi = symbolNameFromSignature(headingMatch[1]);
      continue;
    }
    if (!currentApi) continue;
    if (HEADING_RE.test(line)) {
      currentApi = undefined;
      continue;
    }
    if (!line.trim()) continue;
    const normalized = normalizeSentence(line);
    if (!/(return|throw|must|non-empty|positive finite|exact count|null|defensive copy)/i.test(normalized)) continue;
    contracts.push(`${currentApi}: ${normalized}`);
  }
  return dedupe(contracts).slice(0, 12);
}

function collectBehavioralBoundaries(lines: string[]): string[] {
  const boundaries: string[] = [];
  for (const line of lines) {
    const normalized = normalizeSentence(line);
    if (!normalized) continue;
    if (/(expired when|lease is expired|exact boundary|exactly at|must not|do not expose|defensive copy|immutable|deterministic|wall-clock|public state|internal state|token only if safe|semantic changes)/i.test(normalized)) {
      boundaries.push(normalized);
    }
    if (/non-empty strings?/i.test(normalized)) {
      const names = extractBackticks(line).map(symbolNameFromSignature);
      const label = names.length ? names.join(", ") : "string inputs";
      boundaries.push(`Treat whitespace-only ${label} values as invalid when the task says non-empty string.`);
    }
  }
  return dedupe(boundaries).slice(0, 12);
}

function collectCompatibilityRecommendations(lines: string[], requiredOptionAndFieldNames: string[]): string[] {
  const recommendations: string[] = [];
  const taskText = lines.join("\n");
  const hasTimestampRange = /timestamp range/i.test(taskText);
  const names = new Set(requiredOptionAndFieldNames);
  const hasExplicitShort = names.has("from") || names.has("to");
  const hasExplicitLong = names.has("fromTimestamp") || names.has("toTimestamp");
  if (hasTimestampRange && !hasExplicitShort && !hasExplicitLong) {
    recommendations.push("If timestamp-range field names are ambiguous, keep one canonical shape and cheaply support both `fromTimestamp`/`toTimestamp` and `from`/`to` aliases.");
  }
  return recommendations;
}

function buildExternalConsumerProbes(input: {
  packageRootExports: string[];
  requiredTypesAndErrors: string[];
  requiredOptionAndFieldNames: string[];
  returnAndThrowContracts: string[];
  behavioralBoundaries: string[];
  consumerCompatibility: string[];
}): string[] {
  const probes: string[] = [];
  if (input.packageRootExports.length) {
    probes.push(`Package-root import/export checks for: ${input.packageRootExports.join(", ")}.`);
  }
  if (input.requiredTypesAndErrors.length) {
    probes.push(`Typed error export and throw-contract checks for: ${input.requiredTypesAndErrors.join(", ")}.`);
  }
  if (input.requiredOptionAndFieldNames.length) {
    probes.push(`Consumer-facing option/property names match the literal contract: ${input.requiredOptionAndFieldNames.join(", ")}.`);
  }
  if (input.returnAndThrowContracts.some((entry) => /non-empty/i.test(entry)) || input.behavioralBoundaries.some((entry) => /whitespace-only/i.test(entry))) {
    probes.push("Whitespace-only inputs fail when the task requires non-empty strings.");
  }
  if (input.behavioralBoundaries.some((entry) => /defensive copy|immutable|do not expose|public state|internal state|token/i.test(entry))) {
    probes.push("Public getters, snapshots, audits, and diffs do not leak tokens, secrets, or mutable internal state unless explicitly required.");
  }
  if (input.consumerCompatibility.length) {
    probes.push("Safe compatibility aliases are covered by consumer-facing tests without weakening canonical behavior.");
  }
  return dedupe(probes);
}

function renderList(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None explicit."];
}

function extractBackticks(line: string): string[] {
  return [...line.matchAll(BACKTICK_RE)].map((match) => match[1]).filter(Boolean);
}

function symbolNameFromSignature(value: string): string {
  const trimmed = value.trim();
  const paren = trimmed.indexOf("(");
  return paren >= 0 ? trimmed.slice(0, paren).trim() : trimmed;
}

function normalizeSentence(line: string): string {
  return line
    .replace(/^\s*(?:[*-]|\d+\.)\s*/, "")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(items: Array<string | undefined>): string[] {
  return dedupe(items.filter((item): item is string => Boolean(item)).map((item) => item.trim()).filter(Boolean));
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}
