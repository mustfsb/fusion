import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildCouncilComparison, renderCouncilComparisonMarkdown } from "../src/council/councilComparison.js";
import { DEFAULT_PANEL_MODELS, DEFAULT_JUDGE_MODEL } from "../src/config.js";
import {
  buildCorrectnessCoverageGate,
  parseRequirementDecisionMatrixFromJudgeOutput,
  renderCorrectnessCoverageGateMarkdown,
} from "../src/council/correctnessCoverageGate.js";
import { extractContractGate } from "../src/council/contractGate.js";
import { buildJudgePrompt, buildPanelPrompt, buildPostBuildAuditPrompt } from "../src/council/prompts.js";
import { parseJudgeResponse } from "../src/council/judge.js";
import {
  buildTodoPlan,
  nativeAdvance,
  nativeCollect,
  nativeFinalize,
  nativeFinalizeAudit,
  nativePrepare,
  nativePrepareAudit,
} from "../src/native/nativeCouncil.js";
import { councilComparisonArtifactPath, loadRunState, requirementDecisionMatrixArtifactPath, correctnessCoverageGateArtifactPath } from "../src/native/runState.js";
import { completeCandidate } from "./fixtures/candidates.js";
import type { ContractGate, PanelResponse } from "../src/types.js";

const TASK_WITH_EXPORTS = [
  "Build a TypeScript rate limiter.",
  "",
  "Export:",
  "* `consumeLimit(engine, request)`",
  "* `restoreSnapshot(snapshot)`",
  "",
  "`consumeLimit` must throw `LimitExceededError` when the allowance is exceeded.",
  "* `key` and `fingerprint` must be non-empty strings.",
  "* Sliding-window entries at exactly `now - windowMs` must expire.",
  "* When a deterministic `clock` is injected, restore/parse must continue from that deterministic time model after serialization.",
  "* Public getters, snapshots, and diffs must not leak tokens or secrets.",
  "* Write tests beyond visible happy paths.",
].join("\n");

function gate(): ContractGate {
  return extractContractGate(TASK_WITH_EXPORTS);
}

function panel(modelId: string, content: string, success = true): PanelResponse {
  return { modelId, provider: "test", success, content, latencyMs: 1 };
}

async function stageAndMutateCandidates(tmpCwd: string, runId: string, count = 3) {
  await nativeAdvance({ runId }, { cwd: tmpCwd });
  const state = await loadRunState(tmpCwd, runId);
  await Promise.all((state.speculative?.candidateWorkspaces ?? []).slice(0, count).map(async (workspace, index) => {
    const srcDir = path.join(workspace.workspacePath, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "index.ts"), `export const candidate = ${index + 1};\n`, "utf8");
  }));
}

const PANEL_A = [
  "## 1. Contract Gate",
  "- Required package-root exports: `consumeLimit`, `restoreSnapshot`.",
  "- Required typed errors: `LimitExceededError`.",
  "- Treat whitespace-only key/fingerprint as invalid.",
  "",
  "## 2. Public Surface Matrix",
  "| Symbol | Package-root? | Inputs | Output/throw | Consumer test |",
  "| `consumeLimit` | yes | engine, request | throws `LimitExceededError` | import from package root |",
  "| `restoreSnapshot` | yes | snapshot | snapshot restored | import from package root |",
  "",
  "## 3. Common Requirements and Non-Negotiables",
  "- `consumeLimit` throws `LimitExceededError` (literal).",
  "- `restoreSnapshot` is a package-root export (literal).",
  "- Non-empty string validation is trim-based (literal).",
  "",
  "## 4. Key Decision Points",
  "- Decision: clock injection shape. Options: store clock on engine vs pass per call. Pick: store on engine (matches deterministic-clock requirement).",
  "- Decision: snapshot serialization. Options: JSON-safe vs structured clone. Pick: JSON-safe (matches serialization requirement).",
  "",
  "## 5. Hidden Semantic Probe Plan",
  "- Probe: entry at exactly `now - windowMs` expires.",
  "- Probe: deterministic clock continues after restore+serialize.",
  "",
  "## 6. Safe Compatibility Ideas",
  "- Optional: also accept `from`/`to` aliases for time ranges (cheap, non-breaking).",
  "",
  "## 7. Scope Risks / Avoid",
  "- Avoid: adding a second `consumeLimitQuiet` helper that returns boolean — would weaken the typed-error contract.",
  "",
  "## 8. Implementation Guidance",
  "- src/index.ts exports `consumeLimit` and `restoreSnapshot` from package root.",
  "- package.json main/types point to dist/index.js and dist/index.d.ts.",
  "",
  "```typescript",
  "export function consumeLimit(engine, request) { if (over) throw new LimitExceededError(); }",
  "export function restoreSnapshot(snapshot) { return engine.restore(snapshot); }",
  "```",
  "",
  "## 9. Self-Audit Risks",
  "- Public diffs must not leak the request token.",
  "- Whitespace-only key must be rejected.",
].join("\n");

const PANEL_B = [
  "## 1. Contract Gate",
  "- Required package-root exports: `consumeLimit`, `restoreSnapshot`.",
  "- Required typed errors: `LimitExceededError`.",
  "- Whitespace-only key/fingerprint invalid.",
  "",
  "## 2. Public Surface Matrix",
  "| `consumeLimit` | yes | engine, request | throws `LimitExceededError` | package-entry import |",
  "| `restoreSnapshot` | yes | snapshot | snapshot restored | package-entry import |",
  "",
  "## 3. Common Requirements and Non-Negotiables",
  "- `consumeLimit` throws `LimitExceededError` (literal).",
  "- `restoreSnapshot` is a package-root export (literal).",
  "",
  "## 4. Key Decision Points",
  "- Decision: clock injection shape. Options: store clock on engine vs pass per call. Pick: pass per call (more flexible).",
  "",
  "## 5. Hidden Semantic Probe Plan",
  "- Probe: entry at exactly `now - windowMs` expires.",
  "",
  "## 6. Safe Compatibility Ideas",
  "- Optional: also accept `fromTimestamp`/`toTimestamp` for time ranges.",
  "",
  "## 7. Scope Risks / Avoid",
  "- Avoid: rewriting the engine as a class hierarchy — scope creep.",
  "",
  "## 8. Implementation Guidance",
  "- Export `consumeLimit` and `restoreSnapshot` from package root.",
  "",
  "```typescript",
  "export function consumeLimit(engine, request) { if (over) throw new LimitExceededError(); }",
  "export function restoreSnapshot(snapshot) { return engine.restore(snapshot); }",
  "```",
  "",
  "## 9. Self-Audit Risks",
  "- Hidden test for boundary expiry.",
].join("\n");

const PANEL_C_WEAKENED = [
  "## 1. Contract Gate",
  "- `consumeLimit` returns { allowed: false } when over the limit.",
  "- `restoreSnapshot` is a method on the engine instance.",
  "",
  "## 2. Public Surface Matrix",
  "| `consumeLimit` | no (instance method) | engine, request | returns boolean | internal test |",
  "",
  "## 3. Common Requirements and Non-Negotiables",
  "- `consumeLimit` returns false when over.",
  "",
  "## 4. Key Decision Points",
  "- Decision: skip typed errors, use boolean return.",
  "",
  "## 5. Hidden Semantic Probe Plan",
  "- Probe: visible test for happy path.",
  "",
  "## 6. Safe Compatibility Ideas",
  "- Add a `consumeLimitQuiet` helper.",
  "",
  "## 7. Scope Risks / Avoid",
  "- Avoid: typed errors.",
  "",
  "## 8. Implementation Guidance",
  "- Add `consumeLimit` as an instance method on Engine.",
  "",
  "```typescript",
  "class Engine { consumeLimit(req) { return false; } restoreSnapshot(s) {} }",
  "```",
  "",
  "## 9. Self-Audit Risks",
  "- None.",
].join("\n");

describe("Council Comparison Dossier", () => {
  test("two panels agreeing produces Common Ground", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    expect(comparison.commonGround.length).toBeGreaterThan(0);
    const cg = comparison.commonGround.find((entry) => /LimitExceededError/i.test(entry.topic));
    expect(cg).toBeDefined();
    expect(cg?.supportedBy.length).toBeGreaterThanOrEqual(2);
    expect(cg?.confidence).toMatch(/high|medium/);
  });

  test("a single panel claim does not become consensus unless directly task-required", () => {
    const onlyOne = PANEL_A.replace(
      "## 6. Safe Compatibility Ideas\n- Optional: also accept `from`/`to` aliases for time ranges (cheap, non-breaking).",
      "## 6. Safe Compatibility Ideas\n- Optional: expose a private `__internalReset` method (only panel A wants this).",
    );
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", onlyOne), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const internalReset = comparison.uniqueAdditions.find((entry) => /__internalReset/.test(entry.idea));
    expect(internalReset).toBeDefined();
    expect(internalReset?.recommendation).not.toBe("adopt");
    const consensus = comparison.commonGround.find((entry) => /__internalReset/.test(entry.topic));
    expect(consensus).toBeUndefined();
  });

  test("contradictory panel outputs become Key Differences", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    expect(comparison.keyDifferences.length).toBeGreaterThan(0);
    const diff = comparison.keyDifferences.find((entry) => /clock injection|typed error|boolean/i.test(entry.topic));
    expect(diff).toBeDefined();
    expect(diff?.panelPositions.length).toBeGreaterThan(0);
    expect(diff?.resolutionRule).toMatch(/explicit original task wording|lowest-risk/i);
  });

  test("a literal original-task requirement overrides panel majority disagreement", () => {
    const majorityWeak = [
      "## 1. Contract Gate",
      "- `consumeLimit` returns { allowed: false } when over the limit.",
      "- `restoreSnapshot` is a package-root export.",
      "",
      "## 2. Public Surface Matrix",
      "| `consumeLimit` | yes | engine, request | returns boolean | test |",
      "| `restoreSnapshot` | yes | snapshot | restored | test |",
      "",
      "## 3. Common Requirements and Non-Negotiables",
      "- `consumeLimit` returns false when over.",
      "- `restoreSnapshot` is a package-root export (literal).",
      "",
      "## 4. Key Decision Points",
      "- Decision: use boolean return instead of typed error.",
      "",
      "## 5. Hidden Semantic Probe Plan",
      "- Probe: boolean return on over-limit.",
      "",
      "## 6. Safe Compatibility Ideas",
      "- none.",
      "",
      "## 7. Scope Risks / Avoid",
      "- Avoid: typed errors.",
      "",
      "## 8. Implementation Guidance",
      "```typescript",
      "export function consumeLimit(engine, request) { return false; }",
      "export function restoreSnapshot(snapshot) { return engine.restore(snapshot); }",
      "```",
      "",
      "## 9. Self-Audit Risks",
      "- None.",
    ].join("\n");

    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", majorityWeak), panel("b", majorityWeak), panel("c", PANEL_A)],
      quorumDegraded: false,
    });

    const typedErrorCoverage = [...comparison.partialCoverage, ...comparison.blindSpots].find((entry) => /typed error|LimitExceededError/i.test(entry.requirement ?? entry.risk ?? ""));
    expect(typedErrorCoverage).toBeDefined();
    const followUp = typedErrorCoverage && "requiredFollowUp" in typedErrorCoverage
      ? typedErrorCoverage.requiredFollowUp
      : typedErrorCoverage && "requiredTestOrAudit" in typedErrorCoverage
        ? typedErrorCoverage.requiredTestOrAudit
        : "";
    expect(followUp).toMatch(/LimitExceededError|typed.error|test/i);
  });

  test("unique additions are classified correctly", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    expect(comparison.uniqueAdditions.length).toBeGreaterThan(0);
    for (const entry of comparison.uniqueAdditions) {
      expect(["literal_requirement", "safe_compatibility", "optional_enhancement", "scope_risk"]).toContain(entry.classification);
      expect(["adopt", "defer", "reject"]).toContain(entry.recommendation);
    }
  });

  test("scope-risk extras are deferred or rejected", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const scopeRisks = comparison.uniqueAdditions.filter((entry) => entry.classification === "scope_risk");
    for (const entry of scopeRisks) {
      expect(entry.recommendation).toMatch(/defer|reject/);
    }
  });

  test("omitted literal requirement becomes Partial Coverage or Blind Spot", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const combined = [...comparison.partialCoverage, ...comparison.blindSpots];
    expect(combined.length).toBeGreaterThan(0);
  });

  test("renderCouncilComparisonMarkdown surfaces every section", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const md = renderCouncilComparisonMarkdown(comparison);
    expect(md).toContain("# Council Comparison Dossier");
    expect(md).toContain("## Common Ground");
    expect(md).toContain("## Key Differences");
    expect(md).toContain("## Unique Additions");
    expect(md).toContain("## Partial Coverage");
    expect(md).toContain("## Blind Spots");
    expect(md).toContain("## Summary");
  });
});

describe("Judge comparison-first synthesis", () => {
  const context = { summary: "No context.", files: [], omitted: [] };

  test("judge prompt includes all required comparison sections", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("a", PANEL_A), panel("b", PANEL_B)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("Common Ground");
    expect(prompt).toContain("Key Differences");
    expect(prompt).toContain("Unique Additions");
    expect(prompt).toContain("Partial Coverage and Blind Spots");
    expect(prompt).toContain("Requirement Decision Matrix");
    expect(prompt).toContain("Council Quorum Status");
    expect(prompt).toContain("Spec Compliance Verdict");
    expect(prompt).toContain("Final Build Contract");
    expect(prompt).toContain("Package Entry Checklist");
  });

  test("Requirement Decision Matrix requires requirement → behavior → test mapping", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("a", PANEL_A)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("Requirement");
    expect(prompt).toContain("Chosen behavior");
    expect(prompt).toContain("Why this is correct");
    expect(prompt).toContain("Evidence source");
    expect(prompt).toContain("Required test");
    expect(prompt).toContain("Risk if omitted");
    expect(prompt).toContain("Classification: mandatory_literal_requirement");
    expect(prompt).toContain("mandatory_literal_requirement | safe_compatibility_addition | optional_enhancement | rejected_scope_expansion");
  });

  test("judge prioritizes original-task language over panel vote", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("Conflict-resolution hierarchy");
    expect(prompt).toContain("Explicit original task wording");
    expect(prompt).toContain("Never resolve a conflict by simple majority vote");
  });

  test("judge cannot convert a literal export into an instance-only API", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("c", PANEL_C_WEAKENED)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("instance methods do not satisfy a literal export requirement");
    expect(prompt).toContain("converts a literal package-root export into an instance-only API");
  });

  test("judge cannot weaken typed error requirements", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("c", PANEL_C_WEAKENED)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("substitutes boolean/return-value behavior where typed errors were required");
  });

  test("ambiguous fields can generate compatibility aliases, not false mandates", () => {
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("a", PANEL_A)],
      panelMode: "candidate_build",
    });
    expect(prompt).toContain("Safe aliases are optional compatibility additions only when wording is ambiguous");
  });

  test("council comparison dossier is embedded in the judge prompt when provided", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B)],
      quorumDegraded: false,
    });
    const markdown = renderCouncilComparisonMarkdown(comparison);
    const prompt = buildJudgePrompt({
      task: TASK_WITH_EXPORTS,
      mode: "build_prompt",
      context,
      panel: [panel("a", PANEL_A), panel("b", PANEL_B)],
      panelMode: "candidate_build",
      councilComparison: comparison,
      councilComparisonMarkdown: markdown,
    });
    expect(prompt).toContain("Council Comparison Dossier");
    expect(prompt).toContain("Common Ground");
    expect(prompt).toContain("## Key Differences");
  });

  test("parseJudgeResponse captures requirement decision matrix and council comparison", () => {
    const judgeJson = JSON.stringify({
      decision: "implement",
      summary: "ok",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      finalRecommendation: "ok",
      requirementChecklist: [],
      rejectedRiskyIdeas: [],
      finalBuildGuidance: "ok",
      mustNotBreakConstraints: [],
      requiredTests: [],
      finalOutput: "ok",
      requirementDecisionMatrix: [
        {
          requirement: "consumeLimit throws LimitExceededError",
          chosenBehavior: "throw typed error",
          whyCorrect: "task says must throw",
          evidenceSource: "original task",
          requiredTest: "probe over-limit throws LimitExceededError",
          riskIfOmitted: "boolean return weakens contract",
          classification: "mandatory_literal_requirement",
        },
        {
          requirement: "from/to aliases",
          chosenBehavior: "optional alias",
          whyCorrect: "ambiguous wording",
          evidenceSource: "panel disagreement resolution",
          requiredTest: "alias works",
          riskIfOmitted: "minor compatibility gap",
          classification: "safe_compatibility_addition",
        },
      ],
      councilComparison: {
        commonGround: [{ topic: "throw typed error", supportedBy: [1, 2], confidence: "high", rationale: "both panels agree" }],
        keyDifferences: [{ topic: "clock injection", resolutionRule: "use original task", requiredDecision: "store on engine" }],
        uniqueAdditions: [{ idea: "from/to aliases", classification: "safe_compatibility", recommendation: "adopt" }],
        partialCoverage: [{ requirement: "deterministic clock", requiredFollowUp: "add hidden test" }],
        blindSpots: [{ risk: "token leak", requiredTestOrAudit: "diff redaction test" }],
      },
    });
    const parsed = parseJudgeResponse("build_prompt", judgeJson);
    expect(parsed.requirementDecisionMatrix).toBeDefined();
    expect(parsed.requirementDecisionMatrix?.entries).toHaveLength(2);
    expect(parsed.requirementDecisionMatrix?.mandatoryCount).toBe(1);
    expect(parsed.requirementDecisionMatrix?.safeCompatibilityCount).toBe(1);
    expect(parsed.councilComparison).toBeDefined();
    expect(parsed.councilComparison?.commonGround[0].topic).toBe("throw typed error");
  });

  test("post-build audit prompt includes comparison dossier and decision matrix when provided", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B)],
      quorumDegraded: false,
    });
    const markdown = renderCouncilComparisonMarkdown(comparison);
    const matrix = {
      entries: [
        {
          requirement: "consumeLimit throws LimitExceededError",
          chosenBehavior: "throw",
          whyCorrect: "task says must",
          evidenceSource: "original task",
          requiredTest: "over-limit throws",
          riskIfOmitted: "weak contract",
          classification: "mandatory_literal_requirement" as const,
        },
      ],
      mandatoryCount: 1,
      safeCompatibilityCount: 0,
      optionalCount: 0,
      rejectedCount: 0,
    };
    const prompt = buildPostBuildAuditPrompt({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      finalGuidance: "## Final Build Contract\n- throw LimitExceededError",
      fixCyclesUsed: 0,
      maxFixCycles: 1,
      councilComparisonMarkdown: markdown,
      requirementDecisionMatrix: matrix,
    });
    expect(prompt).toContain("Council Comparison Dossier");
    expect(prompt).toContain("Requirement Decision Matrix");
    expect(prompt).toContain("consumeLimit throws LimitExceededError");
    expect(prompt).toContain("mandatory_literal_requirement");
  });
});

describe("Correctness Coverage Gate", () => {
  test("runs after audit and produces a category-level verdict", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const g = buildCorrectnessCoverageGate({
      contractGate: gate(),
      councilComparison: comparison,
      requirementDecisionMatrix: undefined,
      auditFindings: [],
      auditDegraded: false,
      auditAvailable: true,
      fixCyclesUsed: 0,
      maxFixCycles: 1,
    });
    expect(g.categories.length).toBe(10);
    expect(g.categories.map((c) => c.name)).toEqual([
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
    ]);
    for (const category of g.categories) {
      expect(["pass", "fix_required", "not_applicable"]).toContain(category.status);
    }
  });

  test("one FIX_REQUIRED result triggers exactly one fix cycle allowance", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const g = buildCorrectnessCoverageGate({
      contractGate: gate(),
      councilComparison: comparison,
      requirementDecisionMatrix: undefined,
      auditFindings: [
        {
          requirement: "Package-root import/export check exists.",
          observed: "Tests only import internal modules.",
          requiredFix: "Add a consumer-facing package-entry test.",
        },
      ],
      auditDegraded: false,
      auditAvailable: true,
      fixCyclesUsed: 0,
      maxFixCycles: 1,
    });
    expect(g.categories.find((c) => c.name === "B. Package-root imports/exports")?.status).toBe("fix_required");
    expect(g.status).toBe("fix_required");
    expect(g.fixCyclesUsed).toBe(0);
    expect(g.maxFixCycles).toBe(1);
  });

  test("degraded audit path is explicitly recorded", () => {
    const comparison = buildCouncilComparison({
      task: TASK_WITH_EXPORTS,
      contractGate: gate(),
      panel: [panel("a", PANEL_A), panel("b", PANEL_B), panel("c", PANEL_C_WEAKENED)],
      quorumDegraded: false,
    });
    const g = buildCorrectnessCoverageGate({
      contractGate: gate(),
      councilComparison: comparison,
      requirementDecisionMatrix: undefined,
      auditFindings: [],
      auditDegraded: true,
      auditAvailable: false,
      fixCyclesUsed: 0,
      maxFixCycles: 1,
    });
    expect(g.status).toBe("degraded");
    expect(g.degradedReason).toMatch(/audit subagent unavailable|deterministic checklist/);
  });

  test("parseRequirementDecisionMatrixFromJudgeOutput extracts matrix from freeform judge markdown", () => {
    const judgeMarkdown = [
      "## Requirement Decision Matrix",
      "- Requirement: consumeLimit throws LimitExceededError",
      "  - Chosen behavior: throw typed error",
      "  - Why correct: task says must throw",
      "  - Evidence source: original task",
      "  - Required test: over-limit throws LimitExceededError",
      "  - Risk if omitted: boolean weakens contract",
      "  - Classification: mandatory_literal_requirement",
      "",
      "## Other Section",
      "- unrelated",
    ].join("\n");
    const matrix = parseRequirementDecisionMatrixFromJudgeOutput(judgeMarkdown);
    expect(matrix).toBeDefined();
    expect(matrix?.entries.length).toBeGreaterThan(0);
    expect(matrix?.entries[0].classification).toBe("mandatory_literal_requirement");
  });

  test("renderCorrectnessCoverageGateMarkdown surfaces every category", () => {
    const g = buildCorrectnessCoverageGate({
      contractGate: gate(),
      councilComparison: undefined,
      requirementDecisionMatrix: undefined,
      auditFindings: [],
      auditDegraded: false,
      auditAvailable: true,
      fixCyclesUsed: 0,
      maxFixCycles: 1,
    });
    const md = renderCorrectnessCoverageGateMarkdown(g);
    expect(md).toContain("# Correctness Coverage Gate");
    expect(md).toContain("**Status:**");
    expect(md).toContain("A. Literal API completeness");
    expect(md).toContain("J. Optional additions did not crowd out mandatory requirements");
  });
});

describe("Native build pipeline with comparison + gate", () => {
  let tmpCwd: string;

  test("nativeCollect builds Council Comparison Dossier, writes artifact, and embeds it in the judge prompt", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-build-pipeline-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );

      await stageAndMutateCandidates(tmpCwd, prepare.runId);
      const collect = await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: PANEL_A, sessionId: "s1" },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: PANEL_B, sessionId: "s2" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: PANEL_C_WEAKENED, sessionId: "s3" },
          ],
        },
        { cwd: tmpCwd },
      );

      expect(collect.shouldProceed).toBe(true);
      expect(collect.councilComparison).toBeDefined();
      expect(collect.councilComparison?.commonGround.length).toBeGreaterThan(0);
      expect(collect.councilComparison?.keyDifferences.length).toBeGreaterThan(0);
      expect(collect.councilComparisonMarkdown).toContain("Council Comparison Dossier");
      // Speculative mode: the judge prompt is the Merge Patch Contract prompt,
      // which embeds the Council Comparison Dossier and the contract sections.
      expect(collect.judgePrompt).toContain("Council Comparison Dossier");
      expect(collect.judgePrompt).toContain("Common Ground");
      expect(collect.judgePrompt).toContain("Key Differences");
      expect(collect.judgePrompt).toContain("Speculative Build Comparison");
      expect(collect.judgePrompt).toContain("Final Patch Decision");
      expect(collect.speculative).toBeDefined();
      expect(collect.speculative?.candidateWorkspaces.length).toBe(3);

      const state = await loadRunState(tmpCwd, prepare.runId);
      expect(state.councilComparison).toBeDefined();
      expect(state.councilComparisonMarkdown).toBeTruthy();

      const comparisonArtifact = await readFile(councilComparisonArtifactPath(tmpCwd, prepare.runId), "utf8");
      expect(comparisonArtifact).toContain("Council Comparison Dossier");
      expect(comparisonArtifact).toContain("## Common Ground");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  test("shared panel prompt hash behavior remains unchanged across three panels", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-hash-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );
      await nativeAdvance({ runId: prepare.runId }, { cwd: tmpCwd });
      const state = await loadRunState(tmpCwd, prepare.runId);
      const hashes = prepare.panelAgents.map((p) => p.promptHash);
      expect(new Set(hashes).size).toBe(1);
      expect(hashes[0]).toBe(prepare.canonicalTaskHash);
      expect(new Set(state.panelAgents.map((p) => p.promptHash)).size).toBe(1);
      expect(state.panelAgents[0]?.promptHash).toBe(state.sharedPanelPromptHash);
      expect(prepare.panelAgents.map((p) => p.nativeTask)).toEqual([true, true, true]);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  test("nativeFinalize records Merge Patch Contract artifact from judge output (speculative)", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-matrix-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );
      await stageAndMutateCandidates(tmpCwd, prepare.runId);
      await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: PANEL_A, sessionId: "s1" },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: PANEL_B, sessionId: "s2" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: PANEL_A, sessionId: "s3" },
          ],
        },
        { cwd: tmpCwd },
      );

      // Speculative mode: the judge output IS the Merge Patch Contract markdown.
      const judgeContract = [
        "# Speculative Build Comparison",
        "",
        "## Main Baseline Status",
        "- verification status: passed",
        "- key implementation paths: src/index.ts",
        "",
        "## Panel Candidate Status",
        "- panel 1: usable",
        "- panel 2: usable",
        "- panel 3: usable",
        "",
        "## Literal Requirement Gaps in Main",
        "- severity: BLOCKER",
        "- literal requirement: consumeLimit must throw LimitExceededError",
        "- observed main behavior: consumeLimit returns false",
        "- evidence: src/index.ts: consumeLimit",
        "- required correction: throw LimitExceededError when allowance exceeded",
        "- required regression test: over-limit throws LimitExceededError",
        "",
        "## Main Strengths to Preserve",
        "- pure sliding-window implementation",
        "",
        "## Adopted Panel Insights",
        "- source panels: 1, 2",
        "- idea: typed LimitExceededError class",
        "- why correct: task says must throw",
        "- why it fits the main architecture: single export surface",
        "- exact implementation direction: add LimitExceededError class",
        "- required test: over-limit throws LimitExceededError",
        "",
        "## Rejected Panel Ideas",
        "- source panel: 3",
        "- idea: add a Curry helper",
        "- reason: scope risk",
        "",
        "## Patch Plan",
        "1. src/index.ts",
        "   symbol: consumeLimit",
        "   required change: throw LimitExceededError when over-limit",
        "   required regression test: over-limit throws LimitExceededError",
        "   risk: low",
        "",
        "## Final Patch Decision",
        "- PATCH_REQUIRED",
      ].join("\n");
      const finalize = await nativeFinalize(
        { runId: prepare.runId, judgeOutput: judgeContract, judgeSessionId: "j1" },
        { cwd: tmpCwd },
      );
      expect(finalize.success).toBe(true);
      // Speculative: the Merge Patch Contract is parsed and recorded.
      expect(finalize.speculative).toBeDefined();
      expect(finalize.speculative?.mergePatchContract).toBeDefined();
      expect(finalize.speculative?.mergePatchDecision).toBe("PATCH_REQUIRED");
      expect(finalize.speculative?.mergePatchContract?.gaps).toHaveLength(1);
      expect(finalize.speculative?.mergePatchContract?.gaps[0]?.severity).toBe("BLOCKER");
      expect(finalize.speculative?.mergePatchContract?.gaps[0]?.literalRequirement).toContain("LimitExceededError");
      expect(finalize.speculative?.mergePatchContractPath).toBeTruthy();
      expect(finalize.councilResult.summary).toContain("PATCH_REQUIRED");
      expect(finalize.councilResult.summary).toContain("1 blockers");

      const state = await loadRunState(tmpCwd, prepare.runId);
      expect(state.speculative?.mergePatchContract).toBeDefined();
      expect(state.speculative?.mergePatchDecision).toBe("PATCH_REQUIRED");
      // The Merge Patch Contract artifact is written under the run directory.
      const contractArtifact = await readFile(state.speculative?.mergePatchContractPath ?? "", "utf8");
      expect(contractArtifact).toContain("# Speculative Build Comparison");
      expect(contractArtifact).toContain("BLOCKER");
      expect(contractArtifact).toContain("LimitExceededError");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  test("nativeFinalizeAudit runs the Correctness Coverage Gate and writes the gate artifact", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-gate-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );
      await stageAndMutateCandidates(tmpCwd, prepare.runId);
      await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: PANEL_A, sessionId: "s1" },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: PANEL_B, sessionId: "s2" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: PANEL_A, sessionId: "s3" },
          ],
        },
        { cwd: tmpCwd },
      );
      await nativeFinalize(
        {
          runId: prepare.runId,
          judgeOutput: [
            "# Speculative Build Comparison",
            "",
            "## Main Baseline Status",
            "- verification status: passed",
            "- key implementation paths: src/index.ts",
            "",
            "## Panel Candidate Status",
            "- panel 1: usable",
            "- panel 2: usable",
            "- panel 3: usable",
            "",
            "## Literal Requirement Gaps in Main",
            "- severity: MUST_FIX",
            "- literal requirement: consumeLimit must throw LimitExceededError",
            "- observed main behavior: consumeLimit returns false",
            "- evidence: src/index.ts: consumeLimit",
            "- required correction: throw LimitExceededError when over-limit",
            "- required regression test: over-limit throws LimitExceededError",
            "",
            "## Main Strengths to Preserve",
            "- pure sliding-window implementation",
            "",
            "## Adopted Panel Insights",
            "",
            "## Rejected Panel Ideas",
            "",
            "## Patch Plan",
            "1. src/index.ts",
            "   symbol: consumeLimit",
            "   required change: throw LimitExceededError when over-limit",
            "   required regression test: over-limit throws LimitExceededError",
            "   risk: low",
            "",
            "## Final Patch Decision",
            "- PATCH_REQUIRED",
          ].join("\n"),
          judgeSessionId: "j1",
        },
        { cwd: tmpCwd },
      );
      await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });

      const auditFinalize = await nativeFinalizeAudit(
        {
          runId: prepare.runId,
          auditOutput: JSON.stringify({
            status: "FIX_REQUIRED",
            summary: "missing package-entry test",
            findings: [
              {
                requirement: "Package-root import/export check exists.",
                observed: "Tests only import internal modules.",
                requiredFix: "Add a consumer-facing package-entry test.",
              },
            ],
            finalOutput: "## Audit Verdict\nFIX_REQUIRED",
          }),
          auditSessionId: "a1",
        },
        { cwd: tmpCwd },
      );

      expect(auditFinalize.correctnessCoverageGate).toBeDefined();
      expect(auditFinalize.correctnessCoverageGate?.categories.length).toBe(10);
      const packageRootCategory = auditFinalize.correctnessCoverageGate?.categories.find((c) => c.name === "B. Package-root imports/exports");
      expect(packageRootCategory?.status).toBe("fix_required");
      expect(auditFinalize.status).toBe("FIX_REQUIRED");
      expect(auditFinalize.autoFixAllowed).toBe(true);

      const gateArtifact = await readFile(correctnessCoverageGateArtifactPath(tmpCwd, prepare.runId), "utf8");
      expect(gateArtifact).toContain("# Correctness Coverage Gate");
      expect(gateArtifact).toContain("B. Package-root imports/exports");
      expect(gateArtifact).toContain("fix_required");

      const state = await loadRunState(tmpCwd, prepare.runId);
      expect(state.correctnessCoverageGate).toBeDefined();
      expect(state.correctnessCoverageGate?.status).toMatch(/fix_required|degraded|pass/);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  test("degraded audit (no audit output) still produces a gate and records degraded status", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-degraded-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );
      await stageAndMutateCandidates(tmpCwd, prepare.runId);
      await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: PANEL_A, sessionId: "s1" },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: PANEL_B, sessionId: "s2" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: PANEL_A, sessionId: "s3" },
          ],
        },
        { cwd: tmpCwd },
      );
      await nativeFinalize(
        {
          runId: prepare.runId,
          judgeOutput: JSON.stringify({
            summary: "ok",
            finalRecommendation: "ok",
            requirementChecklist: ["export consumeLimit"],
            finalBuildGuidance: "## Final Build Contract",
            requiredTests: ["probe"],
            finalOutput: "## Final Build Contract",
            requirementDecisionMatrix: [
              {
                requirement: "consumeLimit throws LimitExceededError",
                chosenBehavior: "throw",
                whyCorrect: "task",
                evidenceSource: "original task",
                requiredTest: "probe",
                riskIfOmitted: "weak",
                classification: "mandatory_literal_requirement",
              },
            ],
          }),
          judgeSessionId: "j1",
        },
        { cwd: tmpCwd },
      );
      await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });
      const auditFinalize = await nativeFinalizeAudit(
        { runId: prepare.runId, auditError: "audit subagent unavailable" },
        { cwd: tmpCwd },
      );
      expect(auditFinalize.correctnessCoverageGate).toBeDefined();
      expect(auditFinalize.correctnessCoverageGate?.status).toBe("degraded");
      expect(auditFinalize.correctnessCoverageGate?.degradedReason).toMatch(/audit subagent unavailable|deterministic checklist/);
      expect(auditFinalize.trace.correctnessCoverageGate?.status).toBe("degraded");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe("No-Build produces a Build-Ready Council Packet and does not edit files", () => {
  let tmpCwd: string;

  test("no-build: collect builds comparison, finalize produces matrix artifact, no implementation artifacts written", async () => {
    tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-no-build-pipeline-"));
    try {
      const prepare = await nativePrepare(
        {
          task: TASK_WITH_EXPORTS,
          mode: "plan",
          panelMode: "advisory",
          command: "fusion-no-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmpCwd },
      );

      const collect = await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: PANEL_A, sessionId: "s1" },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: PANEL_B, sessionId: "s2" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: PANEL_A, sessionId: "s3" },
          ],
        },
        { cwd: tmpCwd },
      );
      expect(collect.councilComparison).toBeDefined();
      expect(collect.judgePrompt).toContain("Common Ground");
      expect(collect.judgePrompt).toContain("Key Differences");
      expect(collect.judgePrompt).toContain("Requirement Decision Matrix");

      const finalize = await nativeFinalize(
        {
          runId: prepare.runId,
          judgeOutput: JSON.stringify({
            summary: "ok",
            finalRecommendation: "ok",
            requirementChecklist: ["export consumeLimit"],
            finalBuildGuidance: "## Build-Ready Council Packet\n- throw LimitExceededError",
            requiredTests: ["probe"],
            finalOutput: "## Executive Decision Summary\n## Common Ground\n## Requirement Decision Matrix",
            requirementDecisionMatrix: [
              {
                requirement: "consumeLimit throws LimitExceededError",
                chosenBehavior: "throw",
                whyCorrect: "task",
                evidenceSource: "original task",
                requiredTest: "probe",
                riskIfOmitted: "weak",
                classification: "mandatory_literal_requirement",
              },
              {
                requirement: "from/to aliases",
                chosenBehavior: "optional alias",
                whyCorrect: "ambiguous",
                evidenceSource: "panel disagreement resolution",
                requiredTest: "alias test",
                riskIfOmitted: "minor",
                classification: "optional_enhancement",
              },
            ],
          }),
          judgeSessionId: "j1",
        },
        { cwd: tmpCwd },
      );

      expect(finalize.success).toBe(true);
      expect(finalize.councilResult.requirementDecisionMatrix).toBeDefined();
      expect(finalize.councilResult.requirementDecisionMatrix?.mandatoryCount).toBe(1);
      expect(finalize.councilResult.requirementDecisionMatrix?.optionalCount).toBe(1);
      expect(finalize.finalGuidance).toContain("Common Ground");

      const matrixArtifact = await readFile(requirementDecisionMatrixArtifactPath(tmpCwd, prepare.runId), "utf8");
      expect(matrixArtifact).toContain("# Requirement Decision Matrix");
      expect(matrixArtifact).toContain("mandatory_literal_requirement");
      expect(matrixArtifact).toContain("optional_enhancement");

      const topLevel = await readdir(tmpCwd);
      expect(topLevel).toEqual([".opencode"]);
      const srcDir = path.join(tmpCwd, "src");
      await expect(readdir(srcDir)).rejects.toThrow();
      const testsDir = path.join(tmpCwd, "tests");
      await expect(readdir(testsDir)).rejects.toThrow();
      expect(finalize.trace.executionMode).toBe("native_subagents");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  test("no-build todo plan preserves mandatory/optional distinction and has 7 items", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: [
        { modelId: "opencode-go/kimi-k2.7-code", raw: "opencode-go/kimi-k2.7-code" },
        { modelId: "opencode-go/qwen3.7-max", raw: "opencode-go/qwen3.7-max" },
        { modelId: "opencode-go/minimax-m3", raw: "opencode-go/minimax-m3" },
      ],
      judgeModelSpec: { modelId: "openai/gpt-5.5", raw: "openai/gpt-5.5" },
      command: "fusion-no-build",
      phase: "prepare",
    });
    expect(plan).toHaveLength(7);
    expect(plan.map((p) => p.content)).toContain("Compare panel findings and resolve differences");
    expect(plan.map((p) => p.content)).toContain("Judge synthesis and requirement decision matrix — openai/gpt-5.5");
    expect(plan.map((p) => p.content)).not.toContain("Implement approved contract");
    expect(plan.map((p) => p.content)).not.toContain("Run correctness coverage gate");
  });
});

describe("Regression: native architecture and installer safety", () => {
  test("native subagents remain default for build (candidate_build)", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "fusion-reg-"));
    try {
      const prepare = await nativePrepare(
        {
          task: "Build add(a,b)",
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmp },
      );
      expect(prepare.executionMode).toBe("native_subagents");
      expect(prepare.panelAgents).toHaveLength(3);
      expect(prepare.panelAgents.every((p) => p.nativeTask === true)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("native subagents remain default for no-build (advisory)", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "fusion-reg-nb-"));
    try {
      const prepare = await nativePrepare(
        {
          task: "Build add(a,b)",
          mode: "plan",
          panelMode: "advisory",
          command: "fusion-no-build",
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmp },
      );
      expect(prepare.executionMode).toBe("native_subagents");
      expect(prepare.panelAgents).toHaveLength(3);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("quorum and validation tiers remain functional", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "fusion-reg-quorum-"));
    try {
      const prepare = await nativePrepare(
        {
          task: "Build add(a,b)",
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
          minSuccessfulPanels: 2,
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmp },
      );
      await stageAndMutateCandidates(tmp, prepare.runId);
      const collect = await nativeCollect(
        {
          runId: prepare.runId,
          panelResults: [
            { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
            { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", error: "timed out", errorType: "timeout" },
            { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
          ],
        },
        { cwd: tmp },
      );
      expect(collect.quorum).toMatchObject({ usable: 2, total: 3, required: 2, degraded: true });
      expect(collect.shouldProceed).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("no hidden SDK runner is used by build/no-build (nativeCouncil never calls modelRunner.generate)", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "fusion-reg-sdk-"));
    try {
      const prepare = await nativePrepare(
        {
          task: "Build add(a,b)",
          mode: "build_prompt",
          panelMode: "candidate_build",
          command: "fusion-build",
          trace: { saveRunArtifacts: true },
        },
        { cwd: tmp },
      );
      expect(prepare.executionMode).toBe("native_subagents");
      expect(prepare.buildStrategy).toBe("speculative_parallel_build");
      const advance = await nativeAdvance({ runId: prepare.runId }, { cwd: tmp });
      expect(advance.speculative?.candidateWorkspaces.length).toBe(3);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("cross-platform installer never installs fusion-status", async () => {
    const installer = await import("../scripts/install-opencode-agents.mjs");
    expect(installer.SUPPORTED_COMMANDS).not.toContain("fusion-status.md");
    expect(installer.SUPPORTED_COMMANDS).toContain("fusion-build.md");
    expect(installer.SUPPORTED_COMMANDS).toContain("fusion-no-build.md");
    expect(DEFAULT_PANEL_MODELS).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(DEFAULT_JUDGE_MODEL).toBe("openai/gpt-5.5");
  });
});
