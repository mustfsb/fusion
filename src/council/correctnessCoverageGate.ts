import type {
  ContractGate,
  CorrectnessCoverageCategory,
  CorrectnessCoverageGate,
  CorrectnessCoverageGateStatus,
  CouncilComparison,
  PostBuildAuditFinding,
  RequirementDecisionMatrix,
} from "../types.js";

export type BuildCorrectnessCoverageGateInput = {
  contractGate: ContractGate;
  councilComparison?: CouncilComparison;
  requirementDecisionMatrix?: RequirementDecisionMatrix;
  auditFindings: PostBuildAuditFinding[];
  auditDegraded: boolean;
  auditAvailable: boolean;
  fixCyclesUsed: number;
  maxFixCycles: number;
};

const CATEGORY_NAMES = [
  "A. Literal API completeness",
  "B. Package-root imports/exports",
  "C. Typed errors and exact names",
  "D. Input normalization",
  "E. Boundary behavior",
  "F. Atomic mutation behavior",
  "G. Deterministic clock/restore/parse behavior",
  "H. Public-state/token/secret leakage",
  "I. Hidden test coverage for unresolved panel differences",
  "J. Optional additions did not crowd out mandatory requirements",
] as const;

const NOT_APPLICABLE_BY_DEFAULT: Array<(typeof CATEGORY_NAMES)[number]> = [
  "F. Atomic mutation behavior",
  "G. Deterministic clock/restore/parse behavior",
];

function categoryFromContractGate(name: string, gate: ContractGate): { status: "pass" | "fix_required" | "not_applicable"; findings: string[] } {
  switch (name) {
    case "A. Literal API completeness": {
      const missing = [
        ...gate.packageRootExports,
        ...gate.requiredInstanceMethods,
        ...gate.requiredTypesAndErrors,
      ];
      if (missing.length === 0) return { status: "not_applicable", findings: [] };
      return { status: "pass", findings: missing.map((symbol) => `Tracked literal symbol: ${symbol}`) };
    }
    case "B. Package-root imports/exports": {
      if (gate.packageRootExports.length === 0) return { status: "not_applicable", findings: [] };
      return {
        status: "pass",
        findings: gate.packageRootExports.map((symbol) => `Required package-root export tracked: ${symbol}`),
      };
    }
    case "C. Typed errors and exact names": {
      const items = [...gate.requiredTypesAndErrors, ...gate.requiredOptionAndFieldNames];
      if (items.length === 0) return { status: "not_applicable", findings: [] };
      return {
        status: "pass",
        findings: items.map((name) => `Required exact name tracked: ${name}`),
      };
    }
    case "D. Input normalization": {
      const hasNonEmpty = gate.behavioralBoundaries.some((entry) => /non-empty|whitespace-only/i.test(entry));
      if (!hasNonEmpty) return { status: "not_applicable", findings: [] };
      return {
        status: "pass",
        findings: ["Whitespace-only inputs must be rejected when the task requires non-empty strings."],
      };
    }
    case "E. Boundary behavior": {
      const boundaries = gate.behavioralBoundaries.filter((entry) =>
        /expired when|exact boundary|exactly at|boundary|wall-clock|deterministic|public state|internal state|defensive copy|immutable|semantic changes/i.test(entry),
      );
      if (boundaries.length === 0) return { status: "not_applicable", findings: [] };
      return { status: "pass", findings: boundaries };
    }
    case "F. Atomic mutation behavior": {
      const mutations = gate.behavioralBoundaries.filter((entry) =>
        /partial mutation|rollback|send\/apply|reducer|guard|validator|atomic|mutation/i.test(entry),
      );
      if (mutations.length === 0) return { status: "not_applicable", findings: [] };
      return { status: "pass", findings: mutations };
    }
    case "G. Deterministic clock/restore/parse behavior": {
      const det = gate.behavioralBoundaries.filter((entry) =>
        /deterministic|clock|restore|parse|replay|snapshot|seed|wall-clock/i.test(entry),
      );
      if (det.length === 0) return { status: "not_applicable", findings: [] };
      return { status: "pass", findings: det };
    }
    case "H. Public-state/token/secret leakage": {
      const leaks = gate.behavioralBoundaries.filter((entry) =>
        /token|secret|public state|internal state|defensive copy|do not expose|live internal/i.test(entry),
      );
      if (leaks.length === 0) return { status: "not_applicable", findings: [] };
      return { status: "pass", findings: leaks };
    }
    case "I. Hidden test coverage for unresolved panel differences": {
      return { status: "pass", findings: [] };
    }
    case "J. Optional additions did not crowd out mandatory requirements": {
      return { status: "pass", findings: [] };
    }
    default:
      return { status: "not_applicable", findings: [] };
  }
}

function applyComparisonToCategories(
  categories: CorrectnessCoverageCategory[],
  comparison: CouncilComparison | undefined,
): CorrectnessCoverageCategory[] {
  if (!comparison) return categories;
  return categories.map((category) => {
    if (category.name === "I. Hidden test coverage for unresolved panel differences") {
      const differences = comparison.keyDifferences;
      const blindSpots = comparison.blindSpots;
      const findings: string[] = [];
      if (differences.length > 0) {
        findings.push(`Unresolved differences requiring hidden tests: ${differences.length}`);
        for (const difference of differences.slice(0, 6)) {
          findings.push(`- ${difference.topic}: ${difference.requiredDecision}`);
        }
      }
      if (blindSpots.length > 0) {
        findings.push(`Blind spots requiring mandatory tests/audits: ${blindSpots.length}`);
        for (const blind of blindSpots.slice(0, 6)) {
          findings.push(`- ${blind.risk} → ${blind.requiredTestOrAudit}`);
        }
      }
      if (findings.length === 0) {
        return { ...category, status: "pass", findings: ["No unresolved differences or blind spots from the council comparison."] };
      }
      return { ...category, status: "fix_required", findings };
    }
    if (category.name === "J. Optional additions did not crowd out mandatory requirements") {
      const scopeRisks = comparison.uniqueAdditions.filter((entry) => entry.classification === "scope_risk");
      const deferred = comparison.uniqueAdditions.filter((entry) => entry.recommendation === "defer" || entry.recommendation === "reject");
      const findings: string[] = [];
      if (scopeRisks.length > 0) {
        findings.push(`Scope-risk extras flagged for rejection: ${scopeRisks.length}`);
        for (const risk of scopeRisks.slice(0, 4)) findings.push(`- ${risk.idea} (panel ${risk.proposedBy})`);
      }
      if (deferred.length > 0) {
        findings.push(`Deferred/rejected optional additions: ${deferred.length}`);
      }
      if (findings.length === 0) {
        return { ...category, status: "pass", findings: ["No scope-risk extras adopted."] };
      }
      return { ...category, status: "fix_required", findings };
    }
    return category;
  });
}

function applyMatrixToCategories(
  categories: CorrectnessCoverageCategory[],
  matrix: RequirementDecisionMatrix | undefined,
): CorrectnessCoverageCategory[] {
  if (!matrix) return categories;
  return categories.map((category) => {
    if (category.name === "A. Literal API completeness") {
      const mandatory = matrix.entries.filter((entry) => entry.classification === "mandatory_literal_requirement");
      if (mandatory.length === 0) return category;
      const missing = mandatory.filter((entry) => !entry.requiredTest || entry.requiredTest.toLowerCase() === "none");
      const findings = [...category.findings];
      for (const entry of mandatory.slice(0, 8)) findings.push(`Decision matrix tracks: ${entry.requirement} → ${entry.chosenBehavior}`);
      if (missing.length > 0) {
        findings.push(`Mandatory requirements lacking a required test: ${missing.length}`);
        return { ...category, status: "fix_required", findings };
      }
      return { ...category, status: "pass", findings };
    }
    return category;
  });
}

function applyAuditFindingsToCategories(
  categories: CorrectnessCoverageCategory[],
  auditFindings: PostBuildAuditFinding[],
): CorrectnessCoverageCategory[] {
  if (auditFindings.length === 0) return categories;
  const auditText = auditFindings.map((finding) => `${finding.requirement} → ${finding.observed}`).join(" | ").toLowerCase();
  return categories.map((category) => {
    const relateTo = (() => {
      switch (category.name) {
        case "A. Literal API completeness":
          return /export|api|literal|missing (?:function|class|symbol)/;
        case "B. Package-root imports/exports":
          return /package[- ]root|package entry|import.*export|export.*from|main\/types/;
        case "C. Typed errors and exact names":
          return /typed error|error class|field name|option name|exact name|throw/;
        case "D. Input normalization":
          return /whitespace|non-empty|trim|normaliz/i;
        case "E. Boundary behavior":
          return /boundary|exact|expired|wall-clock|timestamp range/i;
        case "F. Atomic mutation behavior":
          return /atomic|mutation|rollback|partial|send.*apply|reducer|guard|validator/i;
        case "G. Deterministic clock/restore/parse behavior":
          return /deterministic|clock|restore|parse|replay|snapshot|seed/i;
        case "H. Public-state/token/secret leakage":
          return /token|secret|public state|internal state|leak|live internal|defensive copy|immutab/i;
        case "I. Hidden test coverage for unresolved panel differences":
          return /hidden (?:test|probe)|unresolved panel|panel difference/i;
        case "J. Optional additions did not crowd out mandatory requirements":
          return /optional|extra|speculative|scope creep|crowd out/i;
        default:
          return /(?!.)/;
      }
    })();
    const matched = auditFindings.filter((finding) => relateTo.test(`${finding.requirement} ${finding.observed} ${finding.requiredFix}`));
    if (matched.length === 0) return category;
    if (category.status === "not_applicable") return category;
    const findings = [...category.findings, ...matched.map((finding) => `Audit finding: ${finding.requirement} → ${finding.requiredFix}`)];
    return { ...category, status: "fix_required", findings };
  });
}

export function buildCorrectnessCoverageGate(input: BuildCorrectnessCoverageGateInput): CorrectnessCoverageGate {
  const baseCategories: CorrectnessCoverageCategory[] = CATEGORY_NAMES.map((name) => {
    const base = categoryFromContractGate(name, input.contractGate);
    if (base.status === "not_applicable" && NOT_APPLICABLE_BY_DEFAULT.includes(name)) {
      return { name, status: "not_applicable", findings: [] };
    }
    return { name, status: base.status, findings: base.findings };
  });

  let categories = applyComparisonToCategories(baseCategories, input.councilComparison);
  categories = applyMatrixToCategories(categories, input.requirementDecisionMatrix);
  categories = applyAuditFindingsToCategories(categories, input.auditFindings);

  const anyFixRequired = categories.some((category) => category.status === "fix_required");
  const auditDegraded = input.auditDegraded || !input.auditAvailable;

  let status: CorrectnessCoverageGateStatus;
  if (auditDegraded && anyFixRequired) {
    status = "degraded";
  } else if (anyFixRequired) {
    status = "fix_required";
  } else {
    status = "pass";
  }

  return {
    status,
    categories,
    degradedReason: auditDegraded
      ? input.auditAvailable
        ? "Audit subagent reported degraded output; deterministic checklist applied."
        : "Audit subagent unavailable; deterministic checklist applied."
      : undefined,
    fixCyclesUsed: input.fixCyclesUsed,
    maxFixCycles: input.maxFixCycles,
  };
}

export function renderCorrectnessCoverageGateMarkdown(gate: CorrectnessCoverageGate): string {
  const lines: string[] = [];
  lines.push("# Correctness Coverage Gate", "");
  lines.push(`**Status:** ${gate.status}`);
  if (gate.degradedReason) lines.push(`**Degraded reason:** ${gate.degradedReason}`);
  lines.push(`**Fix cycles used:** ${gate.fixCyclesUsed}/${gate.maxFixCycles}`, "");
  lines.push("## Categories");
  for (const category of gate.categories) {
    lines.push(`### ${category.name}`);
    lines.push(`- Status: ${category.status}`);
    if (category.findings.length === 0) {
      lines.push("- No findings.");
    } else {
      for (const finding of category.findings) lines.push(`- ${finding}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function parseRequirementDecisionMatrixFromJudgeOutput(text: string): RequirementDecisionMatrix | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const hasMatrix = /requirement\s*decision\s*matrix|decision matrix/.test(lower);
  if (!hasMatrix) return undefined;
  const entries: RequirementDecisionMatrix["entries"][number] = {} as RequirementDecisionMatrix["entries"][number];
  const collected: RequirementDecisionMatrix["entries"][number][] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inMatrix = false;
  let current: Partial<RequirementDecisionMatrix["entries"][number]> = {};
  let hasFields = 0;

  const flush = () => {
    if (hasFields >= 3 && (current.requirement || current.chosenBehavior)) {
      collected.push({
        requirement: current.requirement ?? "",
        chosenBehavior: current.chosenBehavior ?? "",
        whyCorrect: current.whyCorrect ?? "",
        evidenceSource: current.evidenceSource ?? "",
        requiredTest: current.requiredTest ?? "",
        riskIfOmitted: current.riskIfOmitted ?? "",
        classification: current.classification ?? "mandatory_literal_requirement",
      });
    }
    current = {};
    hasFields = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+requirement\s*decision\s*matrix/i.test(line) || /^#{1,6}\s+decision\s*matrix/i.test(line)) {
      if (inMatrix) flush();
      inMatrix = true;
      continue;
    }
    if (inMatrix && /^#{1,6}\s+/.test(line) && !/^#{1,6}\s+(?:requirement\s*decision\s*matrix|decision\s*matrix)/i.test(line)) {
      flush();
      inMatrix = false;
      continue;
    }
    if (!inMatrix) continue;
    if (!line) {
      if (hasFields >= 3) flush();
      continue;
    }
    const labelMatch = line.match(/^\s*[-*]?\s*(?:\*\*)?([A-Za-z][^:*]{0,40})(?:\*\*)?\s*[:：]\s*(.+)$/);
    if (labelMatch) {
      const label = labelMatch[1].toLowerCase();
      const value = labelMatch[2].trim();
      if (/requirement/.test(label)) {
        if (hasFields >= 3) flush();
        current.requirement = value;
        hasFields += 1;
      } else if (/chosen\s*behavior|behavior/.test(label)) {
        current.chosenBehavior = value;
        hasFields += 1;
      } else if (/why|correct|justification/.test(label)) {
        current.whyCorrect = value;
        hasFields += 1;
      } else if (/evidence/.test(label)) {
        current.evidenceSource = value;
        hasFields += 1;
      } else if (/required\s*test|test/.test(label)) {
        current.requiredTest = value;
        hasFields += 1;
      } else if (/risk/.test(label)) {
        current.riskIfOmitted = value;
        hasFields += 1;
      } else if (/class|type|category/.test(label)) {
        if (/mandatory|literal/.test(value.toLowerCase())) current.classification = "mandatory_literal_requirement";
        else if (/safe\s*compat|compatibility\s*addition/.test(value.toLowerCase())) current.classification = "safe_compatibility_addition";
        else if (/optional|enhancement|nice/.test(value.toLowerCase())) current.classification = "optional_enhancement";
        else if (/reject|scope\s*expansion|deferred/.test(value.toLowerCase())) current.classification = "rejected_scope_expansion";
        hasFields += 1;
      }
    }
  }
  if (inMatrix) flush();
  if (collected.length === 0) return undefined;
  void entries;
  return {
    entries: collected,
    mandatoryCount: collected.filter((entry) => entry.classification === "mandatory_literal_requirement").length,
    safeCompatibilityCount: collected.filter((entry) => entry.classification === "safe_compatibility_addition").length,
    optionalCount: collected.filter((entry) => entry.classification === "optional_enhancement").length,
    rejectedCount: collected.filter((entry) => entry.classification === "rejected_scope_expansion").length,
  };
}
