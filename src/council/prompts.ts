import type { ContextBundle, CouncilMode, FusionTraceQuorum, PanelMode, PanelResponse, PromptVerbosity } from "../types.js";

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

export function buildPanelPrompt(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panelMode?: PanelMode;
  promptVerbosity?: PromptVerbosity;
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
}): string {
  const verbose = input.promptVerbosity === "detailed";
  const compact = input.promptVerbosity !== "detailed";
  const selfReview = compact
    ? ["Audit against the original task for API/error drift, boundary semantics, determinism, and hidden-probe gaps."]
    : verbose
      ? [
        "Audit your candidate against the original task honestly for:",
        "- explicit API/error contract drift (for example must-throw vs returns false)",
        "- hidden state exposure (public reads returning live internal objects)",
        "- raw Error/TypeError leaks instead of typed domain errors",
        "- wrong package.json main/types entries or missing public exports",
        "- shallow equality where deep/semantic equality is needed",
        "- exact-boundary off-by-one behavior",
        "- JSON-safety failures",
        "- rollback failures (partial mutation before failure)",
        "- replay/snapshot baseline loss or deterministic clock rebinding bugs",
        "- diff/public-shape drift after restore/serialize",
        "- missing invalid-input validation",
        "- tests that pass visibly but do not catch semantic bugs",
      ]
      : [
        "Audit your candidate against the original task for:",
        "- explicit API/error contract drift, hidden state exposure, and raw Error leaks",
        "- package.json main/types, exports, dist/test layout, and public-shape drift",
        "- rollback, exact-boundary semantics, determinism, restore/parse behavior, and semantic test gaps",
      ];

  const trapLine = compact
    ? "Cover common traps: package.json main/types vs dist, typed errors vs raw Error leaks, mutable internals exposed, partial mutation before failure, JSON-safety, determinism, tests emitted into dist."
    : undefined;

  return [
    "You are one independent expert panelist in a multi-model council (CANDIDATE BUILD mode).",
    "Produce a focused candidate implementation proposal. Do NOT create or edit any files.",
    "Your output is one competing candidate that the judge will compare against other candidates.",
    "Your candidate must be complete enough to build from as a text proposal.",
    "Do NOT provide only a high-level plan.",
    "Do NOT provide partial snippets only.",
    OUTPUT_BUDGET,
    compact ? "Prefer concise, build-ready output over a giant essay." : undefined,
    "",
    "Solve the task strictly according to the original user prompt. The original task is the sole source of truth.",
    "Identify the exact requirements before proposing implementation details.",
    "Do not add speculative behavior, extra features, broad refactors, compatibility layers, or semantic changes not explicitly requested.",
    "Preserve explicit API shapes, error contracts, boundary semantics, determinism requirements, serialization semantics, and test/build constraints exactly.",
    "If the task literally says 'must throw X', do not weaken it to 'returns false' or another easier contract.",
    "Visible-test-only success is a failure if the original task or hidden probes would still fail.",
    "Flag ambiguities instead of inventing behavior.",
    "",
    "Your candidate proposal MUST include ALL of these sections with these exact headings:",
    "",
    "## 1. Requirement Ledger",
    ...renderRequirementLedgerInstructions("Reconstruct the original task literally before proposing code. Cover:", compact),
    "",
    "## 2. Contract-Critical Behaviors",
    "- List behaviors that would fail a strict benchmark if even slightly wrong.",
    "- Include explicit throw/return semantics, exact boundary rules, restore/parse continuation, public API shape, and mutation/rollback constraints where relevant.",
    "",
    "## 3. Hidden Probe Test Plan",
    "- List task-specific hidden probes beyond visible tests.",
    "- Include probes for error/API contract mismatches, boundary off-by-one cases, determinism after restore/serialize, public read immutability, and misleading green tests where relevant.",
    "",
    "## 4. Edge-Case Semantics",
    "- Call out exact edge-case behavior the implementation must follow literally.",
    "",
    "## 5. Failure Modes To Avoid",
    trapLine ?? "- Name the most likely semantic drift or misleading-green-test failures.",
    "",
    "## 6. Public API / Error Contract Checklist",
    "- Enumerate every exported symbol and the exact success/failure contract for each public operation.",
    "",
    "## 7. Implementation Proposal",
    "- Complete file tree with exact paths",
    "- package.json setup (main, types, scripts, exports)",
    "- tsconfig setup (strict mode, outDir, exclude tests from dist)",
    "- test setup (vitest or equivalent)",
    "- public exports (exact symbols exported from entry)",
    "- important source files as full code blocks or sufficiently complete per-file code",
    "- tests or concrete test cases with full code blocks where practical",
    "- final verification commands",
    "",
    "## 8. Self-Review Against Original Task",
    ...selfReview,
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
    "Visible-test-only success is a failure if the original task or hidden probes would still fail.",
    "Flag ambiguities instead of inventing behavior.",
    "",
    "Your advisory output MUST include ALL of these sections:",
    "",
    "## 1. Requirement Ledger",
    ...renderRequirementLedgerInstructions("List the original task requirements literally. Cover:"),
    "",
    "## 2. Contract-Critical Behaviors",
    "- Literal API/error behavior that must not drift",
    "- Edge cases and non-negotiable hidden probes",
    "",
    "## 3. Implementation strategy",
    "- Proposed architecture",
    "- Internal state representation",
    "- Public API design",
    "- Validation strategy",
    "- Error strategy",
    "- Serialization/snapshot strategy if relevant",
    "- Test strategy",
    "",
    "## 4. Semantic bug traps",
    ...trapSection,
    "Add any additional task-specific traps beyond the list above.",
    "",
    "## 5. Hidden probe checklist",
    "Propose concrete hidden tests/probes that would catch semantic bugs.",
    "These must be task-specific probes, not generic placeholders only.",
    "",
    "## 6. Must-not-break constraints",
    "- Exact prompt semantics that must not be changed",
    "- Any ambiguous semantics that should be resolved conservatively in favor of the original prompt",
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
}): string {
  const quorumSection = renderQuorumSection(input.quorum, input.panel);
  return [
    "You are the strict judge/synthesizer for a multi-model council (CANDIDATE BUILD mode).",
    "Panel models have each produced a competing candidate implementation proposal.",
    "Compare usable candidates and produce a final build contract for the main OpenCode agent.",
    OUTPUT_BUDGET,
    "",
    quorumSection,
    "",
    "Original user task is the sole source of truth. Reconstruct a Requirement Ledger from it before judging.",
    ...renderRequirementLedgerInstructions("Use this Requirement Ledger rubric while evaluating the candidates. Cover:", true),
    "",
    "Rules:",
    "- Compare candidates requirement-by-requirement against the original task literally",
    "- Compare actual candidate code outputs, not only advisory plans",
    "- Rank candidates by requirement compliance first, not verbosity or feature count",
    "- Downgrade ideas from panels that failed or passed with validation warnings",
    "- Reject risky, speculative, over-engineered, poorly-supported, or contract-weakening ideas",
    "- Preserve the exact semantics of the original user prompt",
    "- If visible tests pass but hidden probes fail, treat the candidate as failing",
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
    "Include: must-have behaviors, panel ideas accepted/rejected, highest-risk semantic bugs, required hidden tests, implementation instructions.",
    "",
    "## 2. Candidate Summary Table",
    "For each usable candidate, assess compliance and risk.",
    "",
    "## 3. Candidate Bug Audit",
    "Identify possible hidden bugs in each usable candidate.",
    "",
    "## 4. Best Ideas To Use",
    "## 5. Ideas To Reject",
    "## 6. Final Build Contract",
    "Include: architecture, public API exports, behavior semantics, typed-error strategy, immutability, determinism, package/build, mistakes to avoid, hidden tests, verification checklist.",
    "",
    "## 7. Main-Agent Test Obligations",
    "Produce a Required Hidden Tests list. Tell the main agent to implement those tests before finishing.",
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
        requirementChecklist: ["original prompt requirement to satisfy"],
        rejectedRiskyIdeas: ["candidate idea rejected with reason"],
        finalBuildGuidance:
          "compact final build contract: architecture, must-implement requirements, candidate ideas to use/reject, packaging and verification checklist",
        mustNotBreakConstraints: ["must-not-violate constraint"],
        requiredTests: ["required hidden test the main agent must implement"],
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
          "mode-tailored final output in markdown with Council Quorum Status plus spec compliance verdict, candidate summary table, candidate bug audit, best ideas to use, ideas to reject, final build contract, main-agent test obligations",
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
}): string {
  return [
    "You are the judge/synthesizer for a multi-model council (ADVISORY mode).",
    "Three panel models have provided advice and planning for the following task.",
    "Synthesize their outputs into a final implementation contract for the main OpenCode agent.",
    "",
    "Do NOT implement. Do NOT instruct the agent to create or modify files directly.",
    "Do NOT produce file contents or implementation code.",
    "Do NOT produce a vague plan — produce a checklist the main agent can directly use before final response.",
    "",
    "Critical rules:",
    "- The original user task is the sole source of truth; build a Requirement Ledger from it before synthesis",
    "- Explicitly include any hidden edge cases mentioned by at least one panel unless you explain why they are irrelevant",
    "- Reject risky, speculative, or contract-weakening ideas",
    "- Preserve exact semantics of the original user prompt",
    "- If visible tests pass but hidden probes fail, that is a failure",
    "",
    "Your synthesis MUST include ALL of these sections in finalOutput markdown AND populate the JSON fields:",
    "",
    "## Requirement Ledger",
    "## Consensus plan",
    "## Disagreements between panels",
    "## Risky/speculative ideas rejected",
    "## Exact API checklist",
    "## Exact semantic checklist",
    "## Hidden edge probe checklist",
    "## Required test checklist",
    "## Package/build checklist",
    "## Typed error checklist",
    "## Immutability/safety checklist",
    "## Determinism checklist",
    "## Final implementation contract for the active main agent",
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
        requirementChecklist: ["original prompt requirement"],
        rejectedRiskyIdeas: ["panel suggestion rejected with reason"],
        finalBuildGuidance:
          "final implementation contract synthesized from advisory panel outputs",
        mustNotBreakConstraints: ["constraint that must not be violated"],
        requiredTests: ["required hidden test the main agent must implement"],
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
          "final advisory output in markdown with all required sections: consensus plan, disagreements, rejected ideas, exact API/semantic checklists, hidden edge probe checklist, required test checklist, package/build checklist, typed error checklist, immutability/safety checklist, determinism checklist, final implementation contract",
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
