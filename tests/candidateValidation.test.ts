import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildCandidateRepairPrompt, shouldAttemptCandidateRepair, validateCandidateOutput } from "../src/council/candidateValidation.js";
import { sanitizeText } from "../src/context/sanitize.js";
import { formatCouncilResultMarkdown, runCouncil } from "../src/council/runCouncil.js";
import {
  buildEnhancedFinalGuidance,
  detectGuidanceSections,
  enrichTraceMetadata,
  loadLatestRunTrace,
  writeRunArtifacts,
} from "../src/trace/runTrace.js";
import type { FusionCouncilConfig, ModelRunner } from "../src/types.js";

import {
  completeCandidate,
  incompleteCandidateMissingSelfReview,
  planOnlyCandidate,
  repairableIncompleteCandidate,
} from "./fixtures/candidates.js";

describe("validateCandidateOutput", () => {
  test("passes with complete candidate sections including self-review and hidden probes", () => {
    const result = validateCandidateOutput(completeCandidate);
    expect(result.status).toBe("passed");
    expect(result.valid).toBe(true);
    expect(result.signals.fileTree).toBe(true);
    expect(result.signals.sourceCodeBlocks).toBe(true);
    expect(result.signals.testsOrStrategy).toBe(true);
    expect(result.signals.requirementLedger).toBe(true);
    expect(result.signals.selfReviewAgainstOriginalTask).toBe(true);
    expect(result.signals.hiddenProbeTestPlan).toBe(true);
    expect(result.signals.errorApiContractChecklist).toBe(true);
    expect(result.signals.packageBuildChecklist).toBe(true);
  });

  test("fails on plan-only output", () => {
    const result = validateCandidateOutput(planOnlyCandidate);
    expect(result.status).toBe("failed");
    expect(result.valid).toBe(false);
    expect(result.signals.sourceCodeBlocks).toBe(false);
    expect(result.signals.selfReviewAgainstOriginalTask).toBe(false);
    expect(result.signals.hiddenProbeTestPlan).toBe(false);
  });

  test("usable_with_warnings when only self-review is missing", () => {
    const result = validateCandidateOutput(incompleteCandidateMissingSelfReview);
    expect(result.status).toBe("usable_with_warnings");
    expect(result.valid).toBe(true);
    expect(result.signals.selfReviewAgainstOriginalTask).toBe(false);
    expect(result.signals.hiddenProbeTestPlan).toBe(true);
    expect(result.warnings).toContain("Self-Review Against Original Task");
  });

  test("accepts equivalent Requirement Ledger heading", () => {
    const candidate = completeCandidate.replace("## 1. Requirement Ledger", "## 1. Requirements");
    const result = validateCandidateOutput(candidate);

    expect(result.signals.requirementLedger).toBe(true);
    expect(result.status).not.toBe("failed");
  });

  test("accepts equivalent hidden test heading", () => {
    const candidate = completeCandidate.replace("## 3. Hidden Probe Test Plan", "## 3. Hidden Tests");
    const result = validateCandidateOutput(candidate);

    expect(result.signals.hiddenProbeTestPlan).toBe(true);
    expect(result.status).not.toBe("failed");
  });

  test("usable_with_warnings when only package/build checklist heading is absent", () => {
    const candidate = completeCandidate.replace("## 8. Self-Review Against Original Task", "## 8. Self Review");
    const result = validateCandidateOutput(candidate);

    expect(result.status).not.toBe("failed");
    expect(result.signals.selfReviewAgainstOriginalTask).toBe(true);
  });

  test("usable_with_warnings when API checklist heading differs but contract content remains", () => {
    const candidate = completeCandidate.replace("## 6. Public API / Error Contract Checklist", "## 6. API Contract");
    const result = validateCandidateOutput(candidate);

    expect(result.signals.errorApiContractChecklist).toBe(true);
    expect(result.status).not.toBe("failed");
  });

  test("usable_with_warnings when self-review heading differs", () => {
    const candidate = completeCandidate.replace("## 8. Self-Review Against Original Task", "## 8. Self Review");
    const result = validateCandidateOutput(candidate);

    expect(result.signals.selfReviewAgainstOriginalTask).toBe(true);
    expect(result.status).not.toBe("failed");
  });

  test("validator result includes warnings and missing items", () => {
    const result = validateCandidateOutput(incompleteCandidateMissingSelfReview);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.missingSections.length).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0);
  });

  test("repair prompt asks for complete candidate implementation + self-review + probes", () => {
    const prompt = buildCandidateRepairPrompt({ task: "Build add(a,b)", previousOutput: repairableIncompleteCandidate });
    expect(prompt).toContain("close but not fully usable");
    expect(prompt).toContain("Requirement Ledger");
    expect(prompt).toContain("Hidden Probe Test Plan");
    expect(prompt).toContain("Public API / Error Contract Checklist");
    expect(prompt).toContain("Self-Review Against Original Task");
  });

  test("does not attempt repair for empty/generic output", () => {
    const validation = validateCandidateOutput(planOnlyCandidate);
    expect(shouldAttemptCandidateRepair(planOnlyCandidate, validation)).toBe(false);
  });

  test("attempts repair for near-valid output", () => {
    const validation = validateCandidateOutput(repairableIncompleteCandidate);
    expect(validation.status).toBe("failed");
    expect(shouldAttemptCandidateRepair(repairableIncompleteCandidate, validation)).toBe(true);
  });
});

describe("candidate_build panel validation in runCouncil", () => {
  const config: FusionCouncilConfig = {
    defaults: {
      panelModels: ["panel-a"],
      judgeModel: "judge",
      timeoutMs: 1000,
      maxPanelConcurrency: 1,
    },
    models: {},
  };

  test("attempts repair once when output is close but incomplete", async () => {
    const calls: string[] = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (_modelId, prompt) => {
        calls.push(prompt);
        if (prompt.includes("close but not fully usable")) return completeCandidate;
        return repairableIncompleteCandidate;
      },
    };

    const result = await runCouncil(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        panelModels: ["panel-a"],
        trace: { saveRunArtifacts: false },
      },
      { config, modelRunner },
    );

    expect(calls.filter((call) => call.includes("close but not fully usable")).length).toBe(1);
    expect(result.panel[0].repairAttempted).toBe(true);
    expect(result.panel[0].candidateValidationPassed).toBe(true);
  });

  test("accepts usable_with_warnings without repair", async () => {
    const calls: string[] = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (_modelId, prompt) => {
        calls.push(prompt);
        return incompleteCandidateMissingSelfReview;
      },
    };

    const result = await runCouncil(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        panelModels: ["panel-a"],
        trace: { saveRunArtifacts: false },
      },
      { config, modelRunner },
    );

    expect(calls.filter((call) => call.includes("close but not fully usable")).length).toBe(0);
    expect(result.panel[0].repairAttempted).toBe(false);
    expect(result.panel[0].candidateValidationStatus).toBe("usable_with_warnings");
    expect(result.panel[0].success).toBe(true);
  });

  test("fails closed if repair output is still incomplete", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (_modelId, prompt) => {
        if (prompt.includes("close but not fully usable")) return planOnlyCandidate;
        return repairableIncompleteCandidate;
      },
    };

    await expect(
      runCouncil(
        {
          task: "Build add(a,b)",
          mode: "build_prompt",
          panelMode: "candidate_build",
          panelModels: ["panel-a"],
          minSuccessfulPanels: 1,
          trace: { saveRunArtifacts: false },
        },
        { config, modelRunner },
      ),
    ).rejects.toThrow(/All panel models failed|Insufficient panel quorum/i);
  });
});

describe("trace artifacts", () => {
  test("writes trace metadata with candidate validation and repair fields", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "fusion-trace-test-"));
    try {
      const panel = [{
        modelId: "panel-a",
        provider: "test",
        success: true,
        content: completeCandidate,
        latencyMs: 10,
        attempts: 1,
        prompt: "panel prompt",
        candidateValidationPassed: true,
        candidateValidationStatus: "passed" as const,
        candidateValidationScore: 11,
        repairAttempted: true,
      }];
      const trace = {
        runId: "fusion-test-run",
        timestamp: new Date().toISOString(),
        command: "fusion-build",
        mode: "build_prompt" as const,
        panelMode: "candidate_build" as const,
        modelSource: "opencode" as const,
        requestedModelSource: "opencode" as const,
        actualModelSource: "test" as const,
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "panel-a" }],
        judgeModelRequested: { modelId: "judge" },
        panel: [{
          modelId: "panel-a",
          success: true,
          attempts: 1,
          elapsedMs: 10,
          outputCharCount: completeCandidate.length,
          candidateValidationPassed: true,
          candidateValidationStatus: "passed" as const,
          repairAttempted: true,
        }],
        judge: { modelId: "judge", success: true, elapsedMs: 20 },
        quorum: { required: 2, usable: 1, total: 1, degraded: false, failedPanels: [] },
      };

      const councilResult = {
        mode: "build_prompt" as const,
        panelMode: "candidate_build" as const,
        summary: "ok",
        consensus: [],
        contradictions: [],
        uniqueInsights: [],
        risks: [],
        missingConsiderations: [],
        finalRecommendation: "Build it",
        requirementChecklist: ["keep add API literal"],
        rejectedRiskyIdeas: ["risky extra API"],
        finalBuildGuidance: "Final build contract with exact architecture",
        mustNotBreakConstraints: [],
        requiredTests: ["probe immutable public reads"],
        finalOutput: "output",
        panel,
      };

      const { artifactDir } = await writeRunArtifacts({
        runId: "fusion-test-run",
        cwd,
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        context: { summary: "No context.", files: [], omitted: [] },
        panelModels: ["panel-a"],
        judgeModel: "judge",
        panelResponses: panel,
        panelPrompts: ["panel prompt"],
        judgePrompt: "judge prompt",
        judgeOutput: "## Final build contract\n## Required hidden tests\n- probe rollback",
        finalGuidance: "Final build contract",
        councilResult,
        trace,
      });

      const traceJson = JSON.parse(await readFile(path.join(artifactDir, "trace.json"), "utf8"));
      const finalGuidance = await readFile(path.join(artifactDir, "final-guidance.md"), "utf8");

      expect(traceJson.panelMode).toBe("candidate_build");
      expect(traceJson.commandName).toBe("fusion-build");
      expect(traceJson.candidateValidation.allPassed).toBe(true);
      expect(traceJson.candidateValidation.perPanel[0].status).toBe("passed");
      expect(traceJson.repairAttempted).toBe(true);
      expect(traceJson.repairSucceeded).toBe(true);
      expect(traceJson.panelOutputCompletenessScore).toBeGreaterThan(0);
      expect(traceJson.artifactFiles).toBeInstanceOf(Array);
      expect(traceJson.finalGuidanceContainsHiddenTests).toBe(true);
      expect(finalGuidance).toContain("Requirement Ledger");
      expect(finalGuidance).toContain("Rejected Risky Ideas");
      expect(finalGuidance).toContain("Required Hidden Tests");
      expect(finalGuidance).toContain("Main-Agent Execution Requirements");
      expect(finalGuidance).toContain("Self-Audit Checklist");

      const latest = await loadLatestRunTrace(cwd);
      expect(latest?.runId).toBe("fusion-test-run");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("writes trace artifacts to temp directory and redacts secrets", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "fusion-trace-test-"));
    try {
      const panel = [{
        modelId: "panel-a",
        provider: "test",
        success: true,
        content: "candidate output",
        latencyMs: 10,
        attempts: 1,
        prompt: "panel prompt",
        candidateValidationPassed: true,
      }];
      const trace = {
        runId: "fusion-test-run",
        timestamp: new Date().toISOString(),
        command: "fusion-build",
        mode: "build_prompt" as const,
        panelMode: "candidate_build" as const,
        modelSource: "opencode" as const,
        requestedModelSource: "opencode" as const,
        actualModelSource: "test" as const,
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "panel-a" }],
        judgeModelRequested: { modelId: "judge" },
        panel: [{
          modelId: "panel-a",
          success: true,
          attempts: 1,
          elapsedMs: 10,
          outputCharCount: 15,
          candidateValidationPassed: true,
        }],
        judge: { modelId: "judge", success: true, elapsedMs: 20 },
      };

      const secretTask = "Use key sk-abcdefghijklmnopqrstuvwxyz123456 for testing";
      const { artifactDir } = await writeRunArtifacts({
        runId: "fusion-test-run",
        cwd,
        task: secretTask,
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        context: { summary: "No context.", files: [], omitted: [] },
        panelModels: ["panel-a"],
        judgeModel: "judge",
        panelResponses: panel,
        panelPrompts: ["panel prompt with Authorization: Bearer abcdefghijklmnopqrst"],
        judgePrompt: "judge prompt",
        judgeOutput: "judge output",
        finalGuidance: "final guidance",
        trace,
      });

      const originalPrompt = await readFile(path.join(artifactDir, "original-prompt.md"), "utf8");
      const panelPrompt = await readFile(path.join(artifactDir, "panel-1-prompt.md"), "utf8");
      expect(originalPrompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(originalPrompt).toContain("[REDACTED]");
      expect(panelPrompt).toContain("[REDACTED]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("output markdown includes trace and artifact path", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "build_prompt",
      panelMode: "candidate_build",
      summary: "ok",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      finalRecommendation: "Build it",
      requirementChecklist: [],
      rejectedRiskyIdeas: [],
      finalBuildGuidance: "Build it",
      mustNotBreakConstraints: [],
      requiredTests: [],
      finalOutput: "output",
      panel: [{ modelId: "panel-a", provider: "test", success: true, content: "candidate", latencyMs: 1, candidateValidationPassed: true }],
      trace: {
        runId: "fusion-20260616-120000-abc123",
        timestamp: "2026-06-16T12:00:00.000Z",
        command: "fusion-build",
        mode: "build_prompt",
        panelMode: "candidate_build",
        modelSource: "opencode",
        requestedModelSource: "opencode",
        actualModelSource: "opencode",
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "panel-a" }],
        judgeModelRequested: { modelId: "judge" },
        panel: [{ modelId: "panel-a", success: true, candidateValidationPassed: true, elapsedMs: 1, outputCharCount: 9 }],
        judge: { modelId: "judge", success: true, elapsedMs: 2 },
        artifactDir: "/tmp/.opencode/fusion-runs/fusion-20260616-120000-abc123",
      },
    });

    expect(markdown).toContain("**Run ID:** fusion-20260616-120000-abc123");
    expect(markdown).toContain("**Artifact path:** /tmp/.opencode/fusion-runs/fusion-20260616-120000-abc123");
    expect(markdown).toContain("candidateValidation=passed");
  });

  test("detectGuidanceSections and enrichTraceMetadata work with heuristic detection", () => {
    const guidance = "## Final build contract\n## Required hidden tests\n- probe\n## Package/build checklist\n- main/types";
    const sections = detectGuidanceSections(guidance);
    expect(sections.hiddenTests).toBe(true);
    expect(sections.packageChecklist).toBe(true);
    expect(sections.finalBuildContract).toBe(true);

    const enriched = enrichTraceMetadata({
      trace: {
        runId: "fusion-test",
        timestamp: "2026-06-16T12:00:00.000Z",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        modelSource: "opencode",
        requestedModelSource: "opencode",
        actualModelSource: "test",
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "panel-a" }],
        judgeModelRequested: { modelId: "judge" },
        panel: [],
        judge: { modelId: "judge", success: true },
      },
      panelResponses: [{ modelId: "panel-a", provider: "test", success: true, content: completeCandidate, latencyMs: 1, candidateValidationPassed: true }],
      finalGuidance: guidance,
      judgeOutput: "## Candidate bug audit\n## Ideas to reject",
    });

    expect(enriched.commandName).toBe("fusion-build");
    expect(enriched.judgeOutputSectionsDetected).toContain("candidate bug audit");
    expect(enriched.finalGuidanceContainsHiddenTests).toBe(true);
  });

  test("buildEnhancedFinalGuidance adds rejected ideas and self-audit when missing", () => {
    const enhanced = buildEnhancedFinalGuidance({
      mode: "build_prompt",
      summary: "ok",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      finalRecommendation: "Build",
      requirementChecklist: [],
      rejectedRiskyIdeas: ["extra helper"],
      finalBuildGuidance: "guidance",
      mustNotBreakConstraints: [],
      requiredTests: ["hidden probe test"],
      finalOutput: "output",
      panel: [],
    }, "short guidance", {
      runId: "fusion-test",
      timestamp: "2026-06-16T12:00:00.000Z",
      mode: "build_prompt",
      modelSource: "opencode",
      requestedModelSource: "opencode",
      actualModelSource: "test",
      fallbackUsed: false,
      panelModelsRequested: [],
      judgeModelRequested: { modelId: "judge" },
      panel: [],
      judge: { modelId: "judge", success: true },
      quorum: { required: 2, usable: 2, total: 3, degraded: true, failedPanels: [{ modelId: "panel-c", errorType: "timeout" }] },
    });

    expect(enhanced).toContain("Rejected Risky Ideas");
    expect(enhanced).toContain("Required Hidden Tests");
    expect(enhanced).toContain("Main-Agent Execution Requirements");
    expect(enhanced).toContain("Self-Audit Checklist");
    expect(enhanced).toContain("Council Quorum Warning");
  });
});

describe("sanitizeText", () => {
  test("redacts obvious API-key-like strings", () => {
    const redacted = sanitizeText("OPENAI_API_KEY=super-secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("super-secret-value");
  });
});
