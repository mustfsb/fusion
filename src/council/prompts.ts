import type { ContextBundle, ContractGate, CouncilMode, FusionTraceQuorum, PanelMode, PanelResponse, PromptVerbosity } from "../types.js";
import { extractContractGate, renderContractGate } from "./contractGate.js";

const modeInstructions: Record<CouncilMode, string> = {
  plan: "Produce a practical implementation plan with sequencing, files/components, tests, risks, and verification steps.",
  review: "Review the supplied code, diff, and context. Prioritize correctness, security, regressions, maintainability, and missing tests.",
  decision: "Compare options, tradeoffs, constraints, reversibility, cost, and risk. Make a clear recommendation when enough information exists.",
  build_prompt: "Create requirement-faithful build guidance for an agentic coding CLI. Preserve the original task semantics, include constraints, verification, and non-goals, and avoid speculative extras.",
  architecture: "Analyze system design, boundaries, risks, tradeoffs, migration strategy, and operational concerns.",
};

const TYPESCRIPT_SEMANTIC_BUG_TRAPS = [
  "package.json main/types point to missing dist files",
  "tests accidentally emitted into dist",
  "all required public symbols exported",
  "raw Error/TypeError leaks instead of typed errors",
  "public API returns live internal objects",
  "reducer/handler/validator receives mutable internal object",
  "shallow equality where semantic/deep equality is needed",
  "JSON-safety not enforced",
  "invalid regex accepted too late",
  "missing-value semantics misread",
  "default deny/default reject semantics misread",
  "can/check methods mutating state",
  "send/apply methods partially mutating before failure",
  "rollback incomplete after reducer/guard/validator errors",
  "snapshot/restore loses initial state/baseline",
  "replay after trim/maxHistory broken",
  "diff output not deterministic",
  "deterministic seed still using Date.now/random suffix",
  "clock option not consistently used",
  "functions incorrectly serialized",
  "restore after function loss does not fail clearly",
];

const STANDARD_TRAP_SUMMARY = [
  "package.json main/types vs dist output",
  "typed domain errors vs raw Error leaks",
  "public reads returning live mutable internals",
  "partial mutation before failure / incomplete rollback",
  "JSON-safety, invalid regex, missing-value semantics",
  "deterministic seed/clock, snapshot/replay/diff baseline loss",
  "tests emitted into dist or missing hidden semantic coverage",
];

const REQUIREMENT_LEDGER_AREAS = [
  "Public API requirements",
  "Error contract requirements",
  "Strategy/algorithm requirements",
  "Determinism/time requirements",
  "Serialization/snapshot requirements",
  "Immutability requirements",
  "Test/build/package requirements",
  "Ambiguities",
  "Non-negotiable acceptance tests",
];

function renderTrapChecklist(verbosity: PromptVerbosity | undefined, intro: string): string[] {
  if (verbosity === "detailed") {
    return [intro, ...TYPESCRIPT_SEMANTIC_BUG_TRAPS.map((trap) => `  - ${trap}`)];
  }
  if (verbosity === "compact") {
    return [`${intro} Cover: ${STANDARD_TRAP_SUMMARY.join("; ")}.`];
  }
  return [intro, ...STANDARD_TRAP_SUMMARY.map((trap) => `  - ${trap}`)];
}

function renderRequirementLedgerInstructions(intro: string, compact?: boolean): string[] {
  if (compact) {
    return [
      intro,
      "Cover: public API, error contract, strategy/algorithm, determinism/time, serialization/snapshot, immutability, test/build/package, ambiguities, non-negotiable acceptance tests.",
      "For each requirement: intended behavior, edge cases, hidden probes, failure conditions.",
    ];
  }
  return [
    intro,
    ...REQUIREMENT_LEDGER_AREAS.map((area) => `  - ${area}`),
    "For each explicit requirement, state: intended implementation behavior; likely edge cases; hidden tests/probes that prove it; and what would count as failure.",
  ];
}

const OUTPUT_BUDGET = "Be concise. Prefer bullet points. Do not write long prose. Focus on contract traps and executable guidance.";

function resolveContractGate(task: string, contractGate?: ContractGate): ContractGate {
  return contractGate ?? extractContractGate(task);
}

function renderDerivedContractGate(task: string, contractGate?: ContractGate): string {
  return renderContractGate(resolveContractGate(task, contractGate), "Derived Contract Gate");
}

function renderPublicSurfaceMatrixInstructions(): string[] {
  return [
    "Use this exact column set:",
    "Required symbol | Must be package-root export? | Instance method? | Inputs | Output/throw contract | Consumer test",
    "Include one row for every explicit exported operation and typed error named in the original task.",
  ];
}

export function buildPanelPrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panelMode?: PanelMode;
  promptVerbosity?: PromptVerbosity;
  contractGate?: ContractGate;
}): string {
  if (input.panelMode === "candidate_build") {
    return buildCandidateBuildPanelPrompt(input);
  }
  if (input.panelMode === "advisory") {
    return buildAdvisoryPanelPrompt(input);
  }
  return buildDefaultPanelPrompt(input);
}

function buildCandidateBuildPanelPrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  promptVerbosity?: PromptVerbosity;
  contractGate?: ContractGate;
}): string {
  const compact = input.promptVerbosity !== "detailed";
  return [
    "You are one independent expert panelist in a multi-model council (CANDIDATE BUILD mode).",
    "Produce a focused candidate implementation proposal. Do NOT create or edit any files.",
    "Your output is one competing candidate that the judge will compare against other candidates.",
    "Your candidate must be complete enough to build from as a text proposal.",
    "Do NOT provide only a high-level plan.",
    "Do NOT provide partial snippets only.",
    OUTPUT_BUDGET,
    compact ? "Prefer concise, build-ready output over a giant essay." : undefined,
    !compact ? "In detailed mode, enumerate explicit public symbols, consumer probes, and semantic edge cases separately instead of collapsing them into shorthand." : undefined,
    "",
    "Solve the task strictly according to the original user prompt. The original task is the sole source of truth.",
    "Identify the exact requirements before proposing implementation details.",
    "Do not add speculative behavior, extra features, broad refactors, compatibility layers, or semantic changes not explicitly requested.",
    "Preserve explicit API shapes, error contracts, boundary semantics, determinism requirements, serialization semantics, and test/build constraints exactly.",
    "Do not assume an instance method satisfies a task that explicitly requests a package-root export.",
    "Do not weaken explicit typed-error, export, option-name, public-state, or return/throw requirements.",
    "If the task literally says 'must throw X', do not weaken it to 'returns false' or another easier contract.",
    "Visible tests are not sufficient proof of compliance. Visible-test-only success is a failure if the original task or hidden probes would still fail.",
    "Flag ambiguities instead of inventing behavior.",
    "",
    "Use this compact Contract Gate scaffold. Correct it only when the original task clearly proves it wrong.",
    renderDerivedContractGate(input.task, input.contractGate),
    "",
    "Your candidate proposal MUST include ALL of these sections with these exact headings:",
    "",
    "## 1. Contract Gate",
    "Re-state the literal public surface, behavioral boundaries, compatibility additions, and external consumer probes in compact bullets.",
    "",
    "## 2. Public Surface Matrix",
    ...renderPublicSurfaceMatrixInstructions(),
    "",
    "## 3. External Consumer Probe Plan",
    "List consumer-facing probes for package-entry imports, export presence, field names, typed errors, whitespace normalization, and public-state hygiene.",
    "",
    "## 4. Hidden Semantic Probe Plan",
    "List task-specific hidden probes beyond visible tests. Include boundary off-by-one, determinism, mutation/rollback, restore/parse continuation, and misleading-green-test risks where relevant.",
    "",
    "## 5. Implementation Guidance",
    "- Complete file tree with exact paths",
    "- package.json setup (main, types, scripts, exports)",
    "- tsconfig/build setup (strict mode, outDir, exclude tests from dist)",
    "- public exports and instance methods (exact symbols exported from entry)",
    "- important source files as full code blocks or sufficiently complete per-file code",
    "- contract-focused tests using the project's existing framework",
    compact
      ? "- Cover common traps: package.json main/types vs dist, typed errors vs raw Error leaks, mutable internals exposed, partial mutation before failure, JSON-safety, determinism, tests emitted into dist."
      : "- Cover common traps: package.json main/types vs dist, typed errors vs raw Error leaks, mutable internals exposed, partial mutation before failure, JSON-safety, determinism, tests emitted into dist, and public-shape drift.",
    "- final verification commands",
    "",
    "## 6. Self-Audit Risks",
    "Audit your candidate against the original task for API/export drift, option/property naming drift, typed-error drift, boundary semantics, whitespace-normalization gaps, public-state leakage, and missing consumer-facing tests.",
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildAdvisoryPanelPrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  promptVerbosity?: PromptVerbosity;
  contractGate?: ContractGate;
}): string {
  const trapSection = renderTrapChecklist(
    input.promptVerbosity,
    "Infer task-specific traps. For TypeScript libraries, always consider:",
  );
  return [
    "You are one independent expert panelist in a multi-model council (ADVISORY mode).",
    "Provide implementation advice and planning. Do NOT implement. Do NOT write actual file contents.",
    "Do NOT produce concrete implementation code that could be copied directly into files.",
    "Do NOT produce a full codebase proposal or complete per-file code outputs.",
    "Do NOT produce huge source-code blocks.",
    "Short pseudocode or tiny examples are allowed only when needed to explain a specific edge case.",
    "",
    "Solve the task strictly according to the original user prompt. The original task is the sole source of truth.",
    "Do not add speculative behavior, extra features, broad refactors, or changes not explicitly requested.",
    "Preserve explicit API/error contracts and edge-case semantics exactly.",
    "Do not assume an instance method satisfies a task that explicitly requests a package-root export.",
    "Do not weaken explicit typed-error, export, option-name, or public-state requirements.",
    "Visible tests are not sufficient proof of compliance. Visible-test-only success is a failure if the original task or hidden probes would still fail.",
    "Flag ambiguities instead of inventing behavior.",
    "",
    "Use this compact Contract Gate scaffold. Correct it only when the original task clearly proves it wrong.",
    renderDerivedContractGate(input.task, input.contractGate),
    "",
    "Your advisory output MUST include ALL of these sections:",
    "",
    "## 1. Contract Gate",
    "Re-state the literal public surface, behavioral boundaries, compatibility additions, and external consumer probes in compact bullets.",
    "",
    "## 2. Public Surface Matrix",
    ...renderPublicSurfaceMatrixInstructions(),
    "",
    "## 3. External Consumer Probe Plan",
    "List package-entry checks, export checks, field-name checks, typed-error checks, whitespace-normalization checks, and public-state-hygiene checks.",
    "",
    "## 4. Hidden Semantic Probe Plan",
    "Propose concrete hidden tests/probes that catch semantic bugs beyond visible happy paths.",
    "",
    "## 5. Implementation Guidance",
    "- Proposed architecture",
    "- Internal state representation",
    "- Public API design",
    "- Validation strategy",
    "- Error strategy",
    "- Serialization/snapshot strategy if relevant",
    "- Test strategy using the project's existing framework",
    "",
    "## 6. Self-Audit Risks",
    ...trapSection,
    "Add any additional task-specific self-audit risks beyond the list above. Prefer compact bullet points over prose.",
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
  ].join("\n");
}

function buildDefaultPanelPrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
}): string {
  return [
    "You are one independent expert panelist in a multi-model council.",
    "Do not assume other panelists will catch your mistakes. Be concrete, safety-conscious, and decisive where justified.",
    "Solve the task strictly according to the original user prompt. The original task is the sole source of truth.",
    "Identify the exact requirements before proposing implementation details.",
    "Do not add speculative behavior, extra features, broad refactors, compatibility layers, or semantic changes that the user did not request.",
    "Do not change semantics unless explicitly requested by the original user prompt.",
    "Preserve explicit API/error contracts and hidden edge-case semantics exactly.",
    "Flag ambiguities instead of inventing behavior.",
    `Mode: ${input.mode}`,
    modeInstructions[input.mode],
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
    "",
    "Output these sections:",
    "- Requirement ledger",
    "- Direct answer or strict implementation guidance",
    "- Non-goals and speculative behavior to avoid",
    "- Implementation traps",
    "- Tests needed to prove compliance",
    "- Ambiguities to flag",
    "- Confidence level",
  ].join("\n");
}

export function buildJudgePrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
  panelMode?: PanelMode;
  quorum?: FusionTraceQuorum;
  contractGate?: ContractGate;
}): string {
  if (input.panelMode === "candidate_build") {
    return buildCandidateBuildJudgePrompt(input);
  }
  if (input.panelMode === "advisory") {
    return buildAdvisoryJudgePrompt(input);
  }
  return buildDefaultJudgePrompt(input);
}

function buildCandidateBuildJudgePrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
  quorum?: FusionTraceQuorum;
  contractGate?: ContractGate;
}): string {
  const quorumSection = renderQuorumSection(input.quorum, input.panel);
  return [
    "You are the strict judge/synthesizer for a multi-model council (CANDIDATE BUILD mode).",
    "Panel models have each produced a competing candidate implementation proposal.",
    "Compare usable candidates and produce a contract-first build packet for the main OpenCode agent.",
    OUTPUT_BUDGET,
    "",
    quorumSection,
    "",
    "Original user task is the sole source of truth. Reconcile every panel idea against the literal task before judging.",
    renderDerivedContractGate(input.task, input.contractGate),
    "",
    "Rules:",
    "1. Literal original task requirements override panel preferences.",
    "2. Explicit requested exports must be available from the package root; instance methods do not satisfy a literal export requirement.",
    "3. Explicit error types, API names, and option/property names cannot be weakened.",
    "4. If an API may be consumed externally, require a package-entry import/export test.",
    "5. For non-empty string requirements, require trim-based validation unless the task explicitly excludes it.",
    "6. Audit public state for token, secret, and mutable-reference leaks.",
    "7. Safe aliases are optional compatibility additions only when wording is ambiguous and the alias is cheap and non-breaking.",
    "8. Distinguish mandatory literal requirements, safe compatibility additions, and optional niceties.",
    "9. Do not elevate unsupported evaluator preferences into mandatory requirements.",
    "- Compare actual candidate outputs, not only advisory plans.",
    "- Rank candidates by requirement compliance first, not verbosity or feature count.",
    "- Downgrade ideas from panels that failed or passed with validation warnings.",
    "- Reject risky, speculative, over-engineered, poorly-supported, or contract-weakening ideas.",
    "- If visible tests pass but hidden probes fail, treat the candidate as failing.",
    input.quorum?.degraded ? "- You are operating in degraded/quorum mode — be more conservative and require must-verify-with-tests language" : undefined,
    "",
    "Your output MUST include ALL of these sections in finalOutput markdown AND populate the JSON fields:",
    "",
    "## Council Quorum Status",
    "- Usable panels:",
    "- Failed panels:",
    "- Validation warnings:",
    "- Confidence:",
    "",
    "## 1. Spec Compliance Verdict",
    "Include: mandatory literal requirements, accepted/rejected panel ideas, highest-risk semantic bugs, and consumer-facing contract warnings.",
    "",
    "## 2. Contract Gate",
    "Separate mandatory literal requirements, safe compatibility additions, and optional niceties.",
    "",
    "## 3. Public Surface Matrix",
    "Use the exact columns: Required symbol | Must be package-root export? | Instance method? | Inputs | Output/throw contract | Consumer test",
    "",
    "## 4. Candidate Summary Table",
    "For each usable candidate, assess compliance and risk.",
    "",
    "## 5. Required External Consumer Probes",
    "Focus on package-entry imports, exports, field names, typed errors, normalization, and public-state hygiene.",
    "",
    "## 6. Required Hidden Semantic Probes",
    "Focus on exact boundary, determinism, rollback, serialization, immutability, and state-leak risks.",
    "",
    "## 7. Implementation Priorities",
    "Give the main agent an ordered, compact build sequence.",
    "",
    "## 8. Rejected or Risky Panel Ideas",
    "Call out contract-weakening substitutions explicitly.",
    "",
    "## 9. Final Build Contract",
    "Include architecture, public API exports, typed-error strategy, public-state hygiene, package/build checks, and verification obligations.",
    "",
    "## 10. Package Entry Checklist",
    "Make package-root export verification explicit.",
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
    "",
    "Panel candidate proposals:",
    input.panel.map((response) => renderPanelResponse(response)).join("\n\n"),
    "",
    "Return strict JSON only with this shape:",
    JSON.stringify(
      {
        decision: "implement | do_not_implement | needs_more_info | use_caution",
        summary: "short summary of candidate comparison",
        consensus: ["requirement or approach candidates agreed on"],
        contradictions: ["where candidates disagreed and why"],
        uniqueInsights: ["which candidate contributed what unique insight"],
        risks: ["risk from any candidate proposal"],
        missingConsiderations: ["what candidates missed"],
        finalRecommendation: "decisive recommendation for the main agent",
        requirementChecklist: ["mandatory literal requirement to satisfy"],
        safeCompatibilityAdditions: ["cheap compatibility alias or non-breaking addition"],
        optionalNiceties: ["optional nice-to-have that is not mandatory"],
        publicSurfaceMatrix: ["symbol | package-root export? | instance method? | inputs | output/throw contract | consumer test"],
        requiredExternalConsumerProbes: ["package-entry import/export probe"],
        requiredHiddenSemanticProbes: ["boundary or determinism probe"],
        implementationPriorities: ["ordered contract-first build step"],
        packageEntryChecklist: ["verify package-root exports from the published entry"],
        buildReadyConsumerTestPlan: ["consumer-facing test to add using the project's existing framework"],
        rejectedRiskyIdeas: ["candidate idea rejected with reason"],
        finalBuildGuidance:
          "compact final build contract: mandatory literal requirements, safe compatibility additions, public surface matrix, consumer probes, hidden probes, package-entry checklist, and verification steps",
        mustNotBreakConstraints: ["must-not-violate constraint"],
        requiredTests: ["required consumer-facing or hidden probe the main agent must implement"],
        panelAssessments: [
          {
            modelId: "panel-model-id",
            summary: "short summary of this candidate",
            strengths: ["strong point"],
            weaknesses: ["weak point"],
          },
        ],
        implementationPlan: ["ordered build step"],
        testPlan: ["required test step"],
        recommendedBuildPrompt: "optional follow-up build prompt if needed",
        knownTraps: ["likely bug trap or semantic risk"],
        finalComplianceChecklist: ["final build compliance item including package/build, immutability, typed errors, determinism"],
        finalOutput:
          "mode-tailored final output in markdown with Council Quorum Status, Spec Compliance Verdict, Contract Gate, Public Surface Matrix, Candidate Summary Table, Required External Consumer Probes, Required Hidden Semantic Probes, Implementation Priorities, Rejected or Risky Panel Ideas, Final Build Contract, and Package Entry Checklist",
      },
      null,
      2,
    ),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildAdvisoryJudgePrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
  contractGate?: ContractGate;
}): string {
  return [
    "You are the judge/synthesizer for a multi-model council (ADVISORY mode).",
    "Three panel models have provided advice and planning for the following task.",
    "Synthesize their outputs into a build-ready contract packet for the main OpenCode agent.",
    "",
    "Do NOT implement. Do NOT instruct the agent to create or modify files directly.",
    "Do NOT produce file contents or implementation code.",
    "Do NOT produce a vague plan — produce a compact packet that a main agent can build from later.",
    "",
    "Critical rules:",
    "- The original user task is the sole source of truth; derive a Contract Gate before synthesis.",
    "- Literal original task requirements override panel preferences.",
    "- Explicit requested exports must be package-root exports.",
    "- Preserve explicit error types, API names, option/property names, and public-state hygiene.",
    "- Distinguish mandatory literal requirements, safe compatibility additions, and optional niceties.",
    "- If visible tests pass but hidden probes fail, that is a failure.",
    "- Do not elevate unsupported evaluator preferences into mandatory requirements.",
    "",
    "Your synthesis MUST include ALL of these sections in finalOutput markdown AND populate the JSON fields:",
    "",
    "## Build-Ready Contract Packet",
    "## Literal Public Surface",
    "## Required exports/types/errors",
    "## Public Surface Matrix",
    "## Required consumer probes",
    "## Compatibility recommendations",
    "## Hidden semantic tests",
    "## Implementation order",
    "## Package entry checklist",
    "## Final self-audit checklist",
    "",
    renderDerivedContractGate(input.task, input.contractGate),
    "",
    ...renderTrapChecklist("standard", "Common TypeScript library mistakes to check:"),
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
    "",
    "Panel advisory outputs:",
    input.panel.map((response) => renderPanelResponse(response)).join("\n\n"),
    "",
    "Return strict JSON only with this shape:",
    JSON.stringify(
      {
        decision: "implement | do_not_implement | needs_more_info | use_caution",
        summary: "short summary of panel advice",
        consensus: ["point all panels agreed on"],
        contradictions: ["where panels disagreed"],
        uniqueInsights: ["which panel contributed what unique insight"],
        risks: ["risk identified"],
        missingConsiderations: ["what panels missed"],
        finalRecommendation: "clear advisory recommendation and final implementation contract",
        requirementChecklist: ["mandatory literal requirement"],
        safeCompatibilityAdditions: ["cheap compatibility alias or non-breaking addition"],
        optionalNiceties: ["optional nice-to-have"],
        publicSurfaceMatrix: ["symbol | package-root export? | instance method? | inputs | output/throw contract | consumer test"],
        requiredExternalConsumerProbes: ["package-entry import/export probe"],
        requiredHiddenSemanticProbes: ["boundary or determinism probe"],
        implementationPriorities: ["ordered implementation step"],
        packageEntryChecklist: ["verify package-root exports from the published entry"],
        buildReadyConsumerTestPlan: ["consumer-facing test to add using the project's existing framework"],
        rejectedRiskyIdeas: ["panel suggestion rejected with reason"],
        finalBuildGuidance:
          "build-ready contract packet synthesized from advisory panel outputs",
        mustNotBreakConstraints: ["constraint that must not be violated"],
        requiredTests: ["required consumer-facing or hidden test to add during build"],
        panelAssessments: [
          {
            modelId: "panel-model-id",
            summary: "short summary of this advisory output",
            strengths: ["strong point"],
            weaknesses: ["weak point"],
          },
        ],
        implementationPlan: ["ordered implementation step"],
        testPlan: ["recommended test step"],
        recommendedBuildPrompt: "optional refined build prompt if needed",
        knownTraps: ["likely bug trap or hidden semantic risk"],
        finalComplianceChecklist: ["packaging/build/verification/typed-error/immutability/determinism checklist item"],
        finalOutput:
          "final advisory output in markdown with Build-Ready Contract Packet, Literal Public Surface, Required exports/types/errors, Public Surface Matrix, Required consumer probes, Compatibility recommendations, Hidden semantic tests, Implementation order, Package entry checklist, and Final self-audit checklist",
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildDefaultJudgePrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
}): string {
  return [
    "You are the judge/synthesizer for a multi-model council.",
    "Do not perform blind majority vote. Identify consensus, contradictions, partial coverage, unique insights, weak or unsafe ideas, and missing considerations.",
    "Reject unsafe or poorly supported recommendations. Be decisive when evidence is sufficient; state uncertainty when it is not.",
    "Build a requirement ledger from the original task, then compare panel outputs against it requirement-by-requirement.",
    "Reject suggestions that violate the prompt, change requested semantics, add speculative behavior, or optimize for architecture cleverness over correctness.",
    "If visible tests pass but hidden probes or literal prompt requirements would still fail, treat that as failure.",
    "Prefer correctness over architecture cleverness.",
    "Prefer simple, literal implementation over extra features.",
    "Produce a final build plan with a must-not-violate checklist and a final pre-build compliance checklist.",
    `Mode: ${input.mode}`,
    modeInstructions[input.mode],
    "",
    "User task:",
    input.task,
    "",
    renderContext(input.context),
    "",
    "Panel responses:",
    input.panel.map((response) => renderPanelResponse(response)).join("\n\n"),
    "",
    "Return strict JSON only with this shape:",
    JSON.stringify(
      {
        decision: "implement | do_not_implement | needs_more_info | use_caution",
        summary: "short summary",
        consensus: ["point"],
        contradictions: ["point"],
        uniqueInsights: ["which model noticed what"],
        risks: ["risk"],
        missingConsiderations: ["missing input"],
        finalRecommendation: "decisive recommendation",
        requirementChecklist: ["original prompt requirement to satisfy"],
        rejectedRiskyIdeas: [
          "panel suggestion rejected because it violates or speculates beyond the prompt",
        ],
        finalBuildGuidance: "simple, requirement-literal build guidance",
        mustNotBreakConstraints: ["must-not-violate constraint"],
        requiredTests: ["test/check needed to prove compliance"],
        finalOutput:
          "mode-tailored final output in markdown, including final pre-build compliance checklist",
      },
      null,
      2,
    ),
  ].join("\n");
}

export function buildPostBuildAuditPrompt(input: {
  task: string;
  contractGate?: ContractGate;
  finalGuidance: string;
  fixCyclesUsed: number;
  maxFixCycles: number;
}): string {
  return [
    "You are running a post-build contract audit for /fusion-build.",
    "Read the live repository state before deciding. Do NOT edit files.",
    OUTPUT_BUDGET,
    "",
    "Audit rules:",
    "- Literal original task requirements override panel or judge preferences.",
    "- Explicit requested exports must exist from the package root; instance methods do not satisfy a literal export requirement.",
    "- Explicit error types, API names, and option/property names cannot be weakened.",
    "- Require package-entry import/export checks for externally consumed APIs and exported errors.",
    "- Treat non-empty string requirements as trim-based unless the task explicitly says otherwise.",
    "- Audit public state for token, secret, and mutable-reference leaks.",
    "- Prefer safe compatibility aliases only when they are cheap, non-breaking, and supported by ambiguous wording in the original task.",
    "- Do not elevate evaluator-only preferences into mandatory findings.",
    "- Fail closed if package-entry tests or public-surface checks are missing.",
    "",
    `Fix cycles already used: ${input.fixCyclesUsed}/${input.maxFixCycles}`,
    "",
    renderContractGate(resolveContractGate(input.task, input.contractGate), "Contract Gate"),
    "",
    "Judge guidance to audit against:",
    input.finalGuidance,
    "",
    "Original user task:",
    input.task,
    "",
    "Inspect at minimum:",
    "- package.json and the published package entry",
    "- the actual exported symbols and exported error classes",
    "- input validation and normalization behavior",
    "- public getters, snapshots, audits, and diffs for token/secret/internal-state leakage",
    "- tests to confirm they exercise the public package entry, not only internals",
    "",
    "Return strict JSON only with this shape:",
    JSON.stringify(
      {
        status: "PASS | FIX_REQUIRED",
        summary: "short contract-audit verdict",
        findings: [
          {
            requirement: "literal requirement or contract gate item",
            observed: "what the implementation or tests currently do instead",
            requiredFix: "exact change needed before claiming compliance",
          },
        ],
        finalOutput: "compact markdown with Audit Verdict, Findings, and Required Fixes",
      },
      null,
      2,
    ),
  ].join("\n");
}

function renderContext(context: ContextBundle): string {
  const files = context.files
    .map(
      (file) =>
        `### File: ${file.path}${file.truncated ? " (truncated)" : ""}\n\n\`\`\`\n${file.content}\n\`\`\``,
    )
    .join("\n\n");
  return [
    "Context summary:",
    context.summary || "No context supplied.",
    context.diff ? `\nGit diff:\n\`\`\`diff\n${context.diff}\n\`\`\`` : "",
    files ? `\nSelected/project files:\n${files}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPanelResponse(response: PanelResponse): string {
  if (!response.success) {
    const lines = [
      `### ${response.modelId} (${response.provider}) FAILED`,
      `Error type: ${response.errorType ?? "unknown"}`,
      `Elapsed: ${response.latencyMs}ms`,
      response.repairAttempted ? `Repair attempted: yes` : undefined,
      response.candidateValidationMissingItems?.length
        ? `Validation missing: ${response.candidateValidationMissingItems.join(", ")}`
        : undefined,
      `Error: ${response.error ?? "unknown error"}`,
      response.content?.trim()
        ? `Partial output snippet:\n${response.content.trim().slice(0, 800)}`
        : "No usable output available.",
    ];
    return lines.filter(Boolean).join("\n");
  }
  const warningLine = response.candidateValidationStatus === "usable_with_warnings"
    ? `Validation: usable_with_warnings${response.candidateValidationWarnings?.length ? ` — missing: ${response.candidateValidationWarnings.join(", ")}` : ""}`
    : response.candidateValidationStatus === "passed"
      ? "Validation: passed"
      : undefined;
  return [
    `### ${response.modelId} (${response.provider}) succeeded`,
    warningLine,
    response.content ?? "",
  ].filter(Boolean).join("\n");
}

function renderQuorumSection(quorum: FusionTraceQuorum | undefined, panel: PanelResponse[]): string {
  if (!quorum) return "";
  const usablePanels = panel.filter((entry) => entry.success).map((entry) => entry.modelId);
  const warningPanels = panel
    .filter((entry) => entry.success && entry.candidateValidationStatus === "usable_with_warnings")
    .map((entry) => `${entry.modelId}: ${entry.candidateValidationWarnings?.join(", ") || "warnings present"}`);
  const failedLines = quorum.failedPanels.map((entry) => {
    const parts = [
      `- ${entry.modelId}: ${entry.errorType ?? "unknown"} (${entry.elapsedMs ?? "?"}ms)`,
      entry.validationFailureReason ? `  reason: ${entry.validationFailureReason}` : undefined,
      entry.repairAttempted ? "  repair attempted" : undefined,
      entry.outputSnippet ? `  snippet: ${entry.outputSnippet.slice(0, 200)}` : undefined,
    ];
    return parts.filter(Boolean).join("\n");
  });

  return [
    "Council quorum status:",
    `- Proceeding with quorum: ${quorum.usable}/${quorum.total} usable panels (required ${quorum.required})`,
    quorum.degraded ? "- Operating in DEGRADED mode — fewer than all panels succeeded. Be conservative." : undefined,
    `- Usable panels: ${usablePanels.join(", ") || "none"}`,
    failedLines.length ? "Failed panel diagnostics:" : undefined,
    ...failedLines,
    warningPanels.length ? `Validation warnings from usable panels: ${warningPanels.join("; ")}` : undefined,
    quorum.degraded ? "- Add must-verify-with-tests language in final guidance." : undefined,
  ].filter(Boolean).join("\n");
}
