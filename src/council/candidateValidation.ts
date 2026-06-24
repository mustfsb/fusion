export type CandidateValidationStatus = "passed" | "usable_with_warnings" | "failed";

export type CandidateValidationSignals = {
  fileTree: boolean;
  implementationApproach: boolean;
  packageBuildSetup: boolean;
  sourceStructure: boolean;
  sourceCodeBlocks: boolean;
  testsOrStrategy: boolean;
  requirementLedger: boolean;
  selfReviewAgainstOriginalTask: boolean;
  hiddenProbeTestPlan: boolean;
  errorApiContractChecklist: boolean;
  packageBuildChecklist: boolean;
  commonRequirementsNonNegotiables: boolean;
  keyDecisionPoints: boolean;
  safeCompatibilityIdeas: boolean;
  scopeRisksAvoid: boolean;
  literalVsOptionalDistinction: boolean;
};

export type CandidateValidationResult = {
  status: CandidateValidationStatus;
  /** @deprecated use status instead */
  valid: boolean;
  missingSections: string[];
  warnings: string[];
  signals: CandidateValidationSignals;
  score: number;
};

const SECTION_LABELS: Record<keyof CandidateValidationSignals, string> = {
  fileTree: "candidate file tree",
  implementationApproach: "Implementation Guidance",
  packageBuildSetup: "package/build setup",
  sourceStructure: "source structure",
  sourceCodeBlocks: "concrete source code blocks",
  testsOrStrategy: "tests or test strategy",
  requirementLedger: "Contract Gate",
  selfReviewAgainstOriginalTask: "Self-Audit Risks",
  hiddenProbeTestPlan: "External Consumer Probe Plan / Hidden Semantic Probe Plan",
  errorApiContractChecklist: "Public Surface Matrix",
  packageBuildChecklist: "package/build or package-entry checklist",
  commonRequirementsNonNegotiables: "Common Requirements and Non-Negotiables",
  keyDecisionPoints: "Key Decision Points",
  safeCompatibilityIdeas: "Safe Compatibility Ideas",
  scopeRisksAvoid: "Scope Risks / Avoid",
  literalVsOptionalDistinction: "literal vs optional distinction",
};

const CORE_SIGNAL_KEYS: Array<keyof CandidateValidationSignals> = [
  "requirementLedger",
  "hiddenProbeTestPlan",
  "errorApiContractChecklist",
  "implementationApproach",
];

const IMPLEMENTATION_SIGNAL_KEYS: Array<keyof CandidateValidationSignals> = [
  "fileTree",
  "sourceCodeBlocks",
  "sourceStructure",
  "packageBuildSetup",
  "testsOrStrategy",
];

const USEFUL_SIGNAL_KEYS: Array<keyof CandidateValidationSignals> = [
  "selfReviewAgainstOriginalTask",
  "packageBuildChecklist",
];

const COMPARISON_SIGNAL_KEYS: Array<keyof CandidateValidationSignals> = [
  "commonRequirementsNonNegotiables",
  "keyDecisionPoints",
  "safeCompatibilityIdeas",
  "scopeRisksAvoid",
  "literalVsOptionalDistinction",
];

const MIN_SUBSTANTIVE_LENGTH = 800;
const REPAIR_MIN_SCORE = 5;

function hasSection(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function countSubstantialCodeBlocks(text: string): number {
  const fences = text.match(/```[\s\S]*?```/g) ?? [];
  return fences.filter((block) => block.replace(/```/g, "").trim().length >= 80).length;
}

function detectSignals(text: string, lower: string): CandidateValidationSignals {
  return {
    fileTree: hasSection(lower, [
      /file tree/,
      /directory structure/,
      /project structure/,
      /candidate file tree/,
      /complete file tree/,
      /├──/,
      /└──/,
      /(?:^|\n)\s*[-*]\s*(?:src\/|lib\/|tests?\/|package\.json)/m,
    ]),
    implementationApproach: hasSection(lower, [
      /implementation approach/,
      /implementation plan/,
      /implementation proposal/,
      /implementation guidance/,
      /candidate implementation proposal/,
      /how (?:to|i would) implement/,
      /step[- ]by[- ]step implementation/,
      /core approach/,
      /build guidance/,
      /concrete build/,
    ]),
    packageBuildSetup: hasSection(lower, [
      /package\.json/,
      /tsconfig(?:\.json)?/,
      /vitest\.config/,
      /build setup/,
      /setup\/config files/,
      /npm run (?:build|test|typecheck)/,
    ]),
    sourceStructure: hasSection(lower, [
      /source structure/,
      /core source structure/,
      /key modules/,
      /module layout/,
      /public api/,
      /public exports?/,
      /exports? from/,
    ]),
    sourceCodeBlocks: countSubstantialCodeBlocks(text) >= 2 || hasSection(text, [
      /(?:^|\n)\s*(?:\/\/|#)\s*(?:src|lib)\/[^\n]+\n```/m,
      /```(?:typescript|ts|javascript|js)[\s\S]{120,}```/,
    ]),
    testsOrStrategy: hasSection(lower, [
      /test strategy/,
      /test plan/,
      /vitest/,
      /describe\s*\(/,
      /\bit\s*\(/,
      /test files/,
      /verification commands/,
      /concrete test cases/,
      /acceptance tests?/,
      /hidden tests?/,
      /edge case tests?/,
    ]),
    requirementLedger: hasSection(lower, [
      /requirement ledger/,
      /contract gate/,
      /requirements ledger/,
      /(?:^|\n)\s*#{1,3}\s*(?:\d+\.\s*)?requirements?\b/m,
      /spec checklist/,
      /contract checklist/,
      /non-negotiable acceptance tests?/,
    ]),
    selfReviewAgainstOriginalTask: hasSection(lower, [
      /self[- ]review against original task/,
      /self[- ]review against the original task/,
      /self[- ]review against prompt/,
      /self[- ]review\b/,
      /self-audit risks?/,
      /validation against (?:the )?task/,
      /risks against (?:the )?task/,
      /candidate review/,
    ]),
    hiddenProbeTestPlan: hasSection(lower, [
      /hidden probe test plan/,
      /external consumer probe plan/,
      /hidden semantic probe plan/,
      /hidden test plan/,
      /required hidden tests?/,
      /task-specific hidden probes?/,
      /hidden tests?/,
      /edge case tests?/,
      /acceptance tests?/,
      /hidden probes?/,
    ]),
    errorApiContractChecklist: hasSection(lower, [
      /public api\s*\/\s*error contract checklist/,
      /public surface matrix/,
      /error\/api contract checklist/,
      /api\/error contract checklist/,
      /error contract checklist/,
      /api contract checklist/,
      /typed errors?/,
      /error contract/,
      /api contract/,
    ]),
    packageBuildChecklist: hasSection(lower, [
      /package\/build checklist/,
      /package entry checklist/,
      /packaging\/build checklist/,
      /package\.json.*main/,
      /main.*types.*dist/,
      /exclude tests from dist/,
      /verification checklist/,
    ]),
    commonRequirementsNonNegotiables: hasSection(lower, [
      /common\s*requirements?\s*and\s*non[- ]?negotiables?/,
      /common\s*requirements?/,
      /non[- ]?negotiables?/,
      /non[- ]?negotiable\s*acceptance\s*tests?/,
    ]),
    keyDecisionPoints: hasSection(lower, [
      /key\s*decision\s*points?/,
      /key\s*decisions?/,
      /decision\s*points?/,
      /decisions?\s*where.*(?:differ|ambiguous)/,
    ]),
    safeCompatibilityIdeas: hasSection(lower, [
      /safe\s*compatibility\s*ideas?/,
      /safe\s*compatibility\s*additions?/,
      /safe\s*aliases?/,
      /compatibility\s*additions?/,
    ]),
    scopeRisksAvoid: hasSection(lower, [
      /scope\s*risks?\s*\/\s*avoid/,
      /scope\s*risks?/,
      /avoid\s*[:\-]/,
      /speculative\s*behavior\s*to\s*avoid/,
    ]),
    literalVsOptionalDistinction: hasSection(lower, [
      /literal\s*requirements?\s*from\s*(?:the\s+)?(?:original\s+)?task/,
      /literal\s*vs\s*optional/,
      /mark\s*each\s*as\s*literal/,
      /mandatory\s*literal\s*requirements?/,
      /non[- ]?breaking\s*compatibility\s*additions?/,
    ]),
  };
}

function countPresent(keys: Array<keyof CandidateValidationSignals>, signals: CandidateValidationSignals): number {
  return keys.filter((key) => signals[key]).length;
}

function deriveStatus(signals: CandidateValidationSignals, text: string, lower: string): {
  status: CandidateValidationStatus;
  warnings: string[];
  missingSections: string[];
} {
  const missingSections = (Object.entries(signals) as Array<[keyof CandidateValidationSignals, boolean]>)
    .filter(([, present]) => !present)
    .map(([key]) => SECTION_LABELS[key]);

  const warnings = [
    ...USEFUL_SIGNAL_KEYS.filter((key) => !signals[key]).map((key) => SECTION_LABELS[key]),
    ...COMPARISON_SIGNAL_KEYS.filter((key) => !signals[key]).map((key) => SECTION_LABELS[key]),
  ];

  const planOnly = hasSection(lower, [
    /high[- ]level plan only/,
    /(?:^|\n)\s*#{1,3}\s*plan\b/m,
  ]) && !signals.sourceCodeBlocks && !signals.fileTree;

  const tooShort = text.length < MIN_SUBSTANTIVE_LENGTH;
  const genericRefusal = hasSection(lower, [
    /i (?:cannot|can't) (?:implement|provide|build)/,
    /unable to (?:implement|provide|build)/,
    /not enough information/,
  ]);

  const coreCount = countPresent(CORE_SIGNAL_KEYS, signals);
  const implCount = countPresent(IMPLEMENTATION_SIGNAL_KEYS, signals);
  const hasContract = signals.requirementLedger
    && (signals.hiddenProbeTestPlan || signals.errorApiContractChecklist);
  const hasImplementation = implCount >= 2
    || (signals.implementationApproach && (signals.sourceCodeBlocks || signals.fileTree));

  if (tooShort || planOnly || genericRefusal || (!hasContract && !hasImplementation)) {
    return { status: "failed", warnings, missingSections };
  }

  const strongCore = coreCount >= 3 && hasContract && hasImplementation;
  const allUsefulPresent = USEFUL_SIGNAL_KEYS.every((key) => signals[key]);

  if (strongCore && allUsefulPresent) {
    return { status: "passed", warnings: [], missingSections };
  }

  if (hasContract && hasImplementation) {
    return { status: "usable_with_warnings", warnings, missingSections };
  }

  return { status: "failed", warnings, missingSections };
}

export function validateCandidateOutput(content: string): CandidateValidationResult {
  const text = content.trim();
  const lower = text.toLowerCase();
  const signals = detectSignals(text, lower);
  const score = Object.values(signals).filter(Boolean).length;
  const { status, warnings, missingSections } = deriveStatus(signals, text, lower);

  return {
    status,
    valid: status !== "failed",
    missingSections,
    warnings,
    signals,
    score,
  };
}

export function shouldAttemptCandidateRepair(content: string, validation: CandidateValidationResult): boolean {
  if (validation.status !== "failed") return false;
  const text = content.trim();
  if (text.length < 400) return false;
  if (validation.score < REPAIR_MIN_SCORE) return false;
  const hasContract = validation.signals.requirementLedger
    || validation.signals.hiddenProbeTestPlan
    || validation.signals.errorApiContractChecklist;
  const hasImplementation = countPresent(IMPLEMENTATION_SIGNAL_KEYS, validation.signals) >= 1
    || validation.signals.implementationApproach;
  return hasContract || hasImplementation;
}

export function buildCandidateRepairPrompt(input: { task: string; previousOutput: string }): string {
  const validation = validateCandidateOutput(input.previousOutput);
  return [
    "Your previous candidate output is close but not fully usable for candidate_build mode.",
    "Add the missing contract/probe/implementation sections. Be concise — bullet points preferred.",
    "Do not provide a high-level plan only.",
    "",
    "Missing or weak sections detected:",
    validation.missingSections.length ? validation.missingSections.map((item) => `- ${item}`).join("\n") : "- overall candidate completeness",
    validation.warnings.length ? ["Useful but missing:", ...validation.warnings.map((item) => `- ${item}`)].join("\n") : "",
    "",
    "Required sections (concise):",
    "## 1. Contract Gate (literal public surface + external consumer probes)",
    "## 2. Public Surface Matrix",
    "## 3. Common Requirements and Non-Negotiables (literal vs compatibility)",
    "## 4. Key Decision Points",
    "## 5. Hidden Semantic Probe Plan",
    "## 6. Safe Compatibility Ideas",
    "## 7. Scope Risks / Avoid",
    "## 8. Implementation Guidance (file tree, key code blocks, verification commands)",
    "## 9. Self-Audit Risks",
    "",
    "Original user task:",
    input.task,
    "",
    "Your previous incomplete output (for reference only — replace with a complete candidate):",
    input.previousOutput.slice(0, 4000),
  ].filter(Boolean).join("\n");
}
