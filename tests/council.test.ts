import { describe, expect, test } from "vitest";
import { parseJudgeResponse } from "../src/council/judge.js";
import { buildJudgePrompt, buildPanelPrompt } from "../src/council/prompts.js";
import { formatCouncilResultMarkdown, runCouncil } from "../src/council/runCouncil.js";
import { createDirectModelRunner, resolveModelRunner } from "../src/runners/modelRunner.js";
import type { FusionCouncilConfig, ModelRunner } from "../src/types.js";
import { completeCandidate } from "./fixtures/candidates.js";
import { specTrapTask } from "./fixtures/tasks.js";

const config: FusionCouncilConfig = {
  defaults: {
      panelModels: ["good", "bad"],
      judgeModel: "judge",
      timeoutMs: 1000,
      maxPanelConcurrency: 2,
  },
  models: {
    good: { provider: "openai-compatible", model: "good-model", apiKeyEnv: "GOOD_KEY" },
    bad: { provider: "openai-compatible", model: "bad-model", apiKeyEnv: "BAD_KEY" },
    judge: { provider: "openai-compatible", model: "judge-model", apiKeyEnv: "JUDGE_KEY" },
  },
};

describe("parseJudgeResponse", () => {
  test("parses strict JSON judge output", () => {
    const result = parseJudgeResponse(
      "plan",
      JSON.stringify({
        decision: "implement",
        summary: "Build it.",
        consensus: ["Use tests"],
        contradictions: [],
        uniqueInsights: ["Keep adapters isolated"],
        risks: ["Provider failures"],
        missingConsiderations: [],
        requirementChecklist: ["Keep the original semantics"],
        rejectedRiskyIdeas: ["Add unrelated features"],
        finalBuildGuidance: "Implement only requested behavior.",
        mustNotBreakConstraints: ["Do not change public API"],
        requiredTests: ["Test requested behavior"],
        finalRecommendation: "Proceed",
        finalOutput: "1. Add tests\n2. Implement",
      }),
    );

    expect(result.summary).toBe("Build it.");
    expect(result.decision).toBe("implement");
    expect(result.consensus).toEqual(["Use tests"]);
    expect(result.requirementChecklist).toEqual(["Keep the original semantics"]);
    expect(result.rejectedRiskyIdeas).toEqual(["Add unrelated features"]);
    expect(result.finalBuildGuidance).toBe("Implement only requested behavior.");
    expect(result.mustNotBreakConstraints).toEqual(["Do not change public API"]);
    expect(result.requiredTests).toEqual(["Test requested behavior"]);
  });

  test("falls back to raw finalOutput when judge returns non-JSON text", () => {
    const result = parseJudgeResponse("review", "This is a useful but unstructured review.");

    expect(result.mode).toBe("review");
    expect(result.decision).toBe("needs_more_info");
    expect(result.summary).toBe("Judge returned non-JSON output.");
    expect(result.finalOutput).toBe("This is a useful but unstructured review.");
  });
});

describe("council prompts", () => {
  const context = { summary: "No context.", files: [], omitted: [] };

  test("panel prompt requires literal requirement compliance and avoids speculation", () => {
    const prompt = buildPanelPrompt({ task: "Add exactly one add(a,b) function", mode: "build_prompt", context });

    expect(prompt).toContain("strictly according to the original user prompt");
    expect(prompt).toContain("Identify the exact requirements");
    expect(prompt).toContain("Do not add speculative behavior");
    expect(prompt).toContain("Do not change semantics unless explicitly requested");
    expect(prompt).toContain("Implementation traps");
    expect(prompt).toContain("Tests needed to prove compliance");
    expect(prompt).toContain("Flag ambiguities instead of inventing behavior");
  });

  test("judge prompt rejects risky ideas and compares outputs requirement-by-requirement", () => {
    const prompt = buildJudgePrompt({
      task: "Add exactly one add(a,b) function",
      mode: "build_prompt",
      context,
      panel: [{ modelId: "panel", provider: "test", success: true, content: "Add extras", latencyMs: 1 }],
    });

    expect(prompt).toContain("Build a requirement ledger from the original task");
    expect(prompt).toContain("Reject suggestions that violate the prompt");
    expect(prompt).toContain("Prefer correctness over architecture cleverness");
    expect(prompt).toContain("Prefer simple, literal implementation over extra features");
    expect(prompt).toContain("must-not-violate checklist");
    expect(prompt).toContain("final pre-build compliance checklist");
    expect(prompt).toContain("rejectedRiskyIdeas");
    expect(prompt).toContain("requiredTests");
  });
});

describe("runCouncil", () => {
  test("runs judge when minSuccessfulPanels is explicitly 1 and one panel succeeds", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Good panel answer";
        if (modelId === "bad") throw new Error("provider unavailable");
        return JSON.stringify({
          decision: "implement",
          summary: "One useful panel answer succeeded.",
          consensus: ["Proceed carefully"],
          contradictions: [],
          uniqueInsights: ["Good model covered test strategy"],
          risks: ["One provider failed"],
          missingConsiderations: [],
          requirementChecklist: ["Design auth"],
          rejectedRiskyIdeas: ["Ignore failed panel"],
          finalBuildGuidance: "Use the successful answer and note the failed panel.",
          mustNotBreakConstraints: ["Do not hide provider failures"],
          requiredTests: ["Provider failure path"],
          finalRecommendation: "Use the successful answer and note the failed panel.",
          finalOutput: "Final plan",
        });
      },
    };

    const result = await runCouncil(
      { task: "Design auth", mode: "plan", minSuccessfulPanels: 1 },
      { config, modelRunner, trace: { saveRunArtifacts: false } },
    );

    expect(result.panel).toHaveLength(2);
    expect(result.panel.find((entry) => entry.modelId === "good")?.success).toBe(true);
    expect(result.panel.find((entry) => entry.modelId === "bad")?.success).toBe(false);
    expect(result.summary).toBe("One useful panel answer succeeded.");
    expect(result.trace?.quorum?.degraded).toBe(true);
    expect(result.trace?.runId).toMatch(/^fusion-/);
  });

  test("passes panel and judge timeout overrides to model calls", async () => {
    const calls: Array<{ modelId: string; timeoutMs?: number }> = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId, _prompt, options) => {
        calls.push({ modelId, timeoutMs: options.timeoutMs });
        if (modelId === "good") return "Good panel answer";
        return JSON.stringify({
          decision: "implement",
          summary: "ok",
          consensus: [],
          contradictions: [],
          uniqueInsights: [],
          risks: [],
          missingConsiderations: [],
          requirementChecklist: [],
          rejectedRiskyIdeas: [],
          finalBuildGuidance: "ok",
          mustNotBreakConstraints: [],
          requiredTests: [],
          finalRecommendation: "ok",
          finalOutput: "ok",
        });
      },
    };

    await runCouncil(
      { task: "Design auth", mode: "plan", panelModels: ["good"], panelTimeoutMs: 480_000, judgeTimeoutMs: 540_000 },
      { config, modelRunner, trace: { saveRunArtifacts: false } },
    );

    expect(calls).toEqual([
      { modelId: "good", timeoutMs: 480_000 },
      { modelId: "judge", timeoutMs: 540_000 },
    ]);
  });

  test("retries transient panel failures once and records attempts", async () => {
    let attempts = 0;
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") {
          attempts += 1;
          if (attempts === 1) throw new Error("provider unavailable");
          return "Good panel answer after retry";
        }
        return JSON.stringify({
          decision: "implement",
          summary: "retry worked",
          consensus: [],
          contradictions: [],
          uniqueInsights: [],
          risks: [],
          missingConsiderations: [],
          requirementChecklist: [],
          rejectedRiskyIdeas: [],
          finalBuildGuidance: "ok",
          mustNotBreakConstraints: [],
          requiredTests: [],
          finalRecommendation: "ok",
          finalOutput: "ok",
        });
      },
    };

    const result = await runCouncil(
      { task: "Design auth", mode: "plan", panelModels: ["good"], panelMaxAttempts: 2 },
      { config, modelRunner, trace: { saveRunArtifacts: false } },
    );

    expect(attempts).toBe(2);
    expect(result.panel[0]).toMatchObject({ success: true, attempts: 2 });
  });

  test("does not retry validation or model-not-found failures", async () => {
    let attempts = 0;
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async () => {
        attempts += 1;
        throw new Error("ProviderModelNotFoundError: model does not exist");
      },
    };

    await expect(
      runCouncil(
        { task: "Design auth", mode: "plan", panelModels: ["missing"], panelMaxAttempts: 2 },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/model_not_found/i);
    expect(attempts).toBe(1);
  });

  test("panel failures include error type, elapsed time, attempts, providerID, and modelID", async () => {
    const modelRunner: ModelRunner = {
      source: "opencode",
      generate: async () => { throw new Error("rate limit exceeded"); },
    };

    await expect(
      runCouncil(
        { task: "Design auth", mode: "plan", panelModels: ["opencode-go/qwen3.7-max"], panelMaxAttempts: 1 },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/opencode-go\/qwen3\.7-max.*type=rate_limit.*providerID=opencode-go.*modelID=qwen3\.7-max.*attempts=1.*elapsedMs=/i);
  });

  test("fails before judging when requireAllPanels is true and one panel fails", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Good panel answer";
        if (modelId === "bad") throw new Error("provider unavailable");
        throw new Error("judge should not run");
      },
    };

    await expect(
      runCouncil(
        { task: "Design auth", mode: "plan", requireAllPanels: true },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/required panel models failed/i);
  });

  test("fails deterministically when every panel model fails", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async () => { throw new Error("down"); },
    };

    await expect(
      runCouncil({ task: "Design auth", mode: "plan" }, { config, modelRunner, trace: { saveRunArtifacts: false } }),
    ).rejects.toThrow(/all panel models failed/i);
  });

  test("all-panel failure includes missing direct model details", async () => {
    const directConfig: FusionCouncilConfig = {
      defaults: {
        panelModels: ["opencode-go/kimi-k2.7-code"],
        judgeModel: "openai/gpt-5.5",
        timeoutMs: 1000,
        maxPanelConcurrency: 1,
      },
      models: {},
    };

    await expect(
      runCouncil({ task: "Design auth", mode: "plan", modelSource: "direct" }, { config: directConfig, trace: { saveRunArtifacts: false } }),
    ).rejects.toThrow(/opencode-go\/kimi-k2\.7.*not configured for direct/i);
  });

  test("runs judge with quorum when 2 of 3 panels succeed and 1 times out", async () => {
    const judgePayload = {
      decision: "implement",
      summary: "Two panels usable.",
      consensus: ["Proceed"],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      requirementChecklist: ["Design auth"],
      rejectedRiskyIdeas: [],
      finalBuildGuidance: "Build with quorum.",
      mustNotBreakConstraints: [],
      requiredTests: ["hidden probe"],
      finalRecommendation: "Proceed",
      finalOutput: "Council Quorum Status\nRequired hidden tests",
    };
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Good panel answer";
        if (modelId === "bad") throw new Error("timed out");
        return JSON.stringify(judgePayload);
      },
    };

    const threePanelConfig: FusionCouncilConfig = {
      ...config,
      defaults: { ...config.defaults, panelModels: ["good", "bad", "extra"] },
      models: { ...config.models, extra: { provider: "openai-compatible", model: "extra-model", apiKeyEnv: "EXTRA_KEY" } },
    };

    const result = await runCouncil(
      { task: "Design auth", mode: "plan", panelModels: ["good", "bad", "extra"], minSuccessfulPanels: 2 },
      { config: threePanelConfig, modelRunner, trace: { saveRunArtifacts: false } },
    );

    expect(result.summary).toBe("Two panels usable.");
    expect(result.trace?.quorum).toMatchObject({ required: 2, usable: 2, total: 3, degraded: true });
    expect(result.trace?.quorum?.failedPanels[0]?.modelId).toBe("bad");
  });

  test("does not run judge when only 1 of 3 panels is usable by default", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Good panel answer";
        throw new Error("panel down");
      },
    };

    const threePanelConfig: FusionCouncilConfig = {
      ...config,
      defaults: { ...config.defaults, panelModels: ["good", "bad", "extra"] },
      models: { ...config.models, extra: { provider: "openai-compatible", model: "extra-model", apiKeyEnv: "EXTRA_KEY" } },
    };

    await expect(
      runCouncil(
        { task: "Design auth", mode: "plan", panelModels: ["good", "bad", "extra"] },
        { config: threePanelConfig, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/Insufficient panel quorum/i);
  });

  test("does not run judge when only 1 of 2 panels is usable by default", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Good panel answer";
        if (modelId === "bad") throw new Error("provider unavailable");
        return JSON.stringify({
          decision: "implement",
          summary: "One useful panel answer succeeded.",
          consensus: ["Proceed carefully"],
          contradictions: [],
          uniqueInsights: ["Good model covered test strategy"],
          risks: ["One provider failed"],
          missingConsiderations: [],
          requirementChecklist: ["Design auth"],
          rejectedRiskyIdeas: ["Ignore failed panel"],
          finalBuildGuidance: "Use the successful answer and note the failed panel.",
          mustNotBreakConstraints: ["Do not hide provider failures"],
          requiredTests: ["Provider failure path"],
          finalRecommendation: "Use the successful answer and note the failed panel.",
          finalOutput: "Final plan",
        });
      },
    };

    await expect(
      runCouncil(
        { task: "Design auth", mode: "plan" },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/Insufficient panel quorum/i);
  });
});

describe("model source resolution", () => {
  test("auto chooses OpenCode runner when available", () => {
    const opencodeRunner: ModelRunner = { source: "opencode", generate: async () => "ok" };
    const runner = resolveModelRunner({ modelSource: "auto", config, opencodeRunner });

    expect(runner.source).toBe("opencode");
  });

  test("auto falls back to direct runner outside OpenCode", () => {
    const runner = resolveModelRunner({ modelSource: "auto", config });

    expect(runner.source).toBe("direct");
  });

  test("opencode fails clearly when OpenCode-native runner is unavailable", () => {
    expect(() => resolveModelRunner({ modelSource: "opencode", config })).toThrow(/opencode-native model runner is unavailable/i);
  });

  test("direct runner reports missing model config with the model ID", async () => {
    const runner = createDirectModelRunner({ defaults: config.defaults, models: {} });

    await expect(runner.generate("opencode-go/kimi-k2.7-code", "prompt", {})).rejects.toThrow(/opencode-go\/kimi-k2\.7-code.*not configured for direct/i);
  });
});

describe("formatCouncilResultMarkdown", () => {
  test("renders summary, recommendation, final output, and panel status", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "decision",
      decision: "use_caution",
      summary: "Use a separate API only if latency requirements demand it.",
      consensus: ["Supabase is simpler"],
      contradictions: ["One panel preferred a separate API"],
      uniqueInsights: ["Edge Functions reduce deployment surface"],
      risks: ["Vendor coupling"],
      missingConsiderations: ["Expected traffic"],
      finalRecommendation: "Start with Supabase Edge Functions.",
      requirementChecklist: ["Use a separate API only if latency requirements demand it"],
      rejectedRiskyIdeas: ["Split services without latency evidence"],
      finalBuildGuidance: "Implement the simpler Supabase path first.",
      mustNotBreakConstraints: ["Do not add unrequested service boundaries"],
      requiredTests: ["Verify latency-sensitive behavior remains unchanged"],
      finalOutput: "Decision: Supabase Edge Functions",
      panel: [
        { modelId: "good", provider: "openai-compatible", success: true, content: "ok", latencyMs: 10, attempts: 1 },
        { modelId: "bad", provider: "openai-compatible", success: false, error: "down", errorType: "provider_error", latencyMs: 11, attempts: 2, providerID: "bad-provider", modelID: "bad-model" },
      ],
      trace: {
        runId: "fusion-test",
        timestamp: "2026-06-16T12:00:00.000Z",
        mode: "decision",
        modelSource: "opencode",
        requestedModelSource: "opencode",
        actualModelSource: "opencode",
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "good" }, { modelId: "bad" }],
        judgeModelRequested: { modelId: "judge" },
        panel: [
          { modelId: "good", success: true, attempts: 1 },
          { modelId: "bad", success: false, error: "down", errorType: "provider_error", attempts: 2, providerID: "bad-provider", modelID: "bad-model" },
        ],
        judge: { modelId: "judge", success: true },
      },
    });

    expect(markdown).toContain("# Fusion Council Result");
    expect(markdown).toContain("**Mode:** decision");
    expect(markdown).toContain("Start with Supabase Edge Functions.");
    expect(markdown).toContain("Decision: Supabase Edge Functions");
    expect(markdown).toContain("good: succeeded");
    expect(markdown).toContain("bad: failed");
    expect(markdown).toContain("## Fusion Model Trace");
    expect(markdown).toContain("**Requested model source:** opencode");
    expect(markdown).toContain("**Fallback used:** no");
    expect(markdown).toContain("Panel 1: good");
    expect(markdown).toContain("Panel 2: bad");
    expect(markdown).toContain("Judge: judge");
    expect(markdown).toContain("**Judge status:** succeeded");
    expect(markdown).toContain("## Panel Model Trace");
    expect(markdown).toContain("attempts=2");
    expect(markdown).toContain("type=provider_error");
    expect(markdown).toContain("providerID=bad-provider");
    expect(markdown).toContain("modelID=bad-model");
    expect(markdown).toContain("## Judge Model Trace");
    expect(markdown).toContain("## Requirement Checklist");
    expect(markdown).toContain("## Rejected Risky Ideas");
    expect(markdown).toContain("## Final Build Guidance");
    expect(markdown).toContain("## Must-Not-Break Constraints");
    expect(markdown).toContain("## Required Tests");
    expect(markdown).toContain("Split services without latency evidence");
    expect(markdown).toContain("Implement the simpler Supabase path first.");
  });

  test("candidate_build markdown includes candidate-specific sections", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "build_prompt",
      panelMode: "candidate_build",
      decision: "implement",
      summary: "Three candidate builds were compared.",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: ["One candidate changed semantics"],
      missingConsiderations: [],
      finalRecommendation: "Use the strongest merged candidate.",
      requirementChecklist: ["Keep the package tiny"],
      rejectedRiskyIdeas: ["Do not add helper APIs"],
      finalBuildGuidance: "Implement the merged minimal candidate.",
      mustNotBreakConstraints: ["No speculative behavior"],
      requiredTests: ["add(2, 3) returns 5"],
      finalComplianceChecklist: ["Exactly one public function"],
      knownTraps: ["Do not emit extra files"],
      implementationPlan: ["Create src/index.ts"],
      testPlan: ["Add one Vitest test"],
      recommendedBuildPrompt: "Build the tiny package.",
      panelAssessments: [
        { modelId: "candidate-1", summary: "Strong baseline.", strengths: ["Minimal"], weaknesses: ["Weak tsconfig"] },
        { modelId: "candidate-2", summary: "Best tests.", strengths: ["Clear tests"], weaknesses: ["Extra config"] },
        { modelId: "candidate-3", summary: "Best structure.", strengths: ["Simple tree"], weaknesses: ["Verbose output"] },
      ],
      finalOutput: "Candidate build synthesis",
      panel: [{ modelId: "candidate-1", provider: "test", success: true, content: "candidate", latencyMs: 1 }],
      trace: { runId: "fusion-test", timestamp: "2026-06-16T12:00:00.000Z", mode: "build_prompt", panelMode: "candidate_build", modelSource: "opencode", requestedModelSource: "opencode", actualModelSource: "opencode", fallbackUsed: false, panelModelsRequested: [{ modelId: "a" }, { modelId: "b" }, { modelId: "c" }], judgeModelRequested: { modelId: "judge" }, panel: [], judge: { modelId: "judge", success: true } },
    } as any);

    expect(markdown).toContain("## Panel Candidate Summary");
    expect(markdown).toContain("## Candidate 1 Strengths/Weaknesses");
    expect(markdown).toContain("## Candidate 2 Strengths/Weaknesses");
    expect(markdown).toContain("## Candidate 3 Strengths/Weaknesses");
    expect(markdown).toContain("## Judge Decision");
    expect(markdown).toContain("## Final Build Guidance");
    expect(markdown).toContain("## Must-Not-Break Constraints");
    expect(markdown).toContain("## Required Tests");
    expect(markdown).toContain("## Final Compliance Checklist");
  });

  test("advisory markdown includes advisory-only sections and stop notice", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "plan",
      panelMode: "advisory",
      decision: "implement",
      summary: "Three advisory plans were synthesized.",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: ["Overbuilding"],
      missingConsiderations: [],
      finalRecommendation: "Use the simplest plan.",
      requirementChecklist: ["One add function"],
      rejectedRiskyIdeas: ["No extra helpers"],
      finalBuildGuidance: "",
      mustNotBreakConstraints: ["Do not change semantics"],
      requiredTests: ["One Vitest test"],
      finalComplianceChecklist: [],
      knownTraps: [],
      implementationPlan: ["Create src/index.ts", "Add one test"],
      testPlan: ["Verify add(2,3)=5"],
      recommendedBuildPrompt: "/fusion-build Create the tiny package",
      panelAssessments: [
        { modelId: "advice-1", summary: "Simple plan.", strengths: ["Minimal"], weaknesses: ["No examples"] },
      ],
      finalOutput: "Advisory output",
      panel: [{ modelId: "advice-1", provider: "test", success: true, content: "advice", latencyMs: 1 }],
      trace: { runId: "fusion-test", timestamp: "2026-06-16T12:00:00.000Z", mode: "build_prompt", panelMode: "candidate_build", modelSource: "opencode", requestedModelSource: "opencode", actualModelSource: "opencode", fallbackUsed: false, panelModelsRequested: [{ modelId: "a" }, { modelId: "b" }, { modelId: "c" }], judgeModelRequested: { modelId: "judge" }, panel: [], judge: { modelId: "judge", success: true } },
    } as any);

    expect(markdown).toContain("## Panel Advisory Summary");
    expect(markdown).toContain("## Judge Recommendation");
    expect(markdown).toContain("## Requirement Checklist");
    expect(markdown).toContain("## Risks");
    expect(markdown).toContain("## Implementation Plan");
    expect(markdown).toContain("## Test Plan");
    expect(markdown).toContain("## Recommended Build Prompt");
    expect(markdown).toContain("## Main Agent Implementation Instructions");
    expect(markdown).toContain("implement the original user task automatically");
    expect(markdown).toContain("implementation contract");
    expect(markdown).toContain("hidden-edge checks were implemented as tests");
    expect(markdown).toContain("Requirement Ledger");
    expect(markdown).toContain("Do not accept visible-test-only success");
    expect(markdown).toContain("**Run ID:** fusion-test");
  });
});

describe("panel modes in prompts", () => {
  const context = { summary: "No context.", files: [], omitted: [] };

  test("candidate_build panel prompt requires Requirement Ledger, hidden probes, and strict contract preservation", () => {
    const prompt = buildPanelPrompt({ task: specTrapTask, mode: "build_prompt", context, panelMode: "candidate_build" });

    expect(prompt).toContain("CANDIDATE BUILD mode");
    expect(prompt).toContain("Requirement Ledger");
    expect(prompt).toContain("Contract-Critical Behaviors");
    expect(prompt).toContain("Hidden Probe Test Plan");
    expect(prompt).toContain("Edge-Case Semantics");
    expect(prompt).toContain("Failure Modes To Avoid");
    expect(prompt).toContain("Public API / Error Contract Checklist");
    expect(prompt).toContain("Implementation Proposal");
    expect(prompt).toContain("Self-Review Against Original Task");
    expect(prompt).toContain("Preserve explicit API shapes, error contracts");
    expect(prompt).toContain("If the task literally says 'must throw X'");
    expect(prompt).toContain("Visible-test-only success is a failure");
    expect(prompt).toContain("must throw `LimitExceededError`");
    expect(prompt).toContain("Do NOT provide only a high-level plan");
    expect(prompt).not.toContain("ADVISORY mode");
  });

  test("candidate_build panel prompt instructs not to edit files", () => {
    const prompt = buildPanelPrompt({ task: "Build add(a,b)", mode: "build_prompt", context, panelMode: "candidate_build" });

    expect(prompt).toContain("Do NOT create or edit any files");
  });

  test("advisory panel prompt requires semantic bug traps and hidden probe checklist", () => {
    const prompt = buildPanelPrompt({ task: "Build add(a,b)", mode: "plan", context, panelMode: "advisory" });

    expect(prompt).toContain("ADVISORY mode");
    expect(prompt).toContain("Requirement Ledger");
    expect(prompt).toContain("Contract-Critical Behaviors");
    expect(prompt).toContain("Implementation strategy");
    expect(prompt).toContain("Semantic bug traps");
    expect(prompt).toContain("Hidden probe checklist");
    expect(prompt).toContain("Must-not-break constraints");
    expect(prompt).toContain("package.json main/types vs dist output");
    expect(prompt).toContain("typed domain errors vs raw Error leaks");
    expect(prompt).toContain("Visible-test-only success is a failure");
    expect(prompt).toContain("Do NOT produce a full codebase proposal");
    expect(prompt).not.toContain("CANDIDATE BUILD mode");
  });

  test("advisory panel prompt instructs not to implement", () => {
    const prompt = buildPanelPrompt({ task: "Build add(a,b)", mode: "plan", context, panelMode: "advisory" });

    expect(prompt).toContain("Do NOT implement");
  });

  test("default panel prompt (no panelMode) uses mode-based instructions", () => {
    const prompt = buildPanelPrompt({ task: "Build add(a,b)", mode: "plan", context });

    expect(prompt).toContain("Mode: plan");
    expect(prompt).not.toContain("CANDIDATE BUILD mode");
    expect(prompt).not.toContain("ADVISORY mode");
  });

  test("candidate_build judge prompt includes quorum status and failed panel diagnostics", () => {
    const prompt = buildJudgePrompt({
      task: specTrapTask,
      mode: "build_prompt",
      context,
      panel: [
        { modelId: "panel-a", provider: "test", success: true, content: "candidate", latencyMs: 1 },
        { modelId: "panel-b", provider: "test", success: false, error: "timed out", errorType: "timeout", latencyMs: 600000 },
      ],
      panelMode: "candidate_build",
      quorum: {
        required: 2,
        usable: 1,
        total: 2,
        degraded: false,
        failedPanels: [{ modelId: "panel-b", errorType: "timeout", elapsedMs: 600000 }],
      },
    });

    expect(prompt).toContain("Council quorum status");
    expect(prompt).toContain("panel-b");
    expect(prompt).toContain("Council Quorum Status");
    expect(prompt).toContain("required hidden test");
  });

  test("candidate_build panel prompt is compact by default and includes output budget", () => {
    const compact = buildPanelPrompt({ task: specTrapTask, mode: "build_prompt", context, panelMode: "candidate_build" });
    const detailed = buildPanelPrompt({ task: specTrapTask, mode: "build_prompt", context, panelMode: "candidate_build", promptVerbosity: "detailed" });

    expect(compact).toContain("Be concise. Prefer bullet points.");
    expect(compact).toContain("Requirement Ledger");
    expect(compact).toContain("Hidden Probe Test Plan");
    expect(compact).toContain("Visible-test-only success is a failure");
    expect(compact.length).toBeLessThan(detailed.length);
    expect((compact.match(/package\.json main\/types/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  test("candidate_build judge prompt enforces strict spec compliance and required hidden tests", () => {
    const prompt = buildJudgePrompt({
      task: specTrapTask,
      mode: "build_prompt",
      context,
      panel: [{ modelId: "panel", provider: "test", success: true, content: "candidate", latencyMs: 1 }],
      panelMode: "candidate_build",
    });

    expect(prompt).toContain("CANDIDATE BUILD mode");
    expect(prompt).toContain("Requirement Ledger");
    expect(prompt).toContain("Spec Compliance Verdict");
    expect(prompt).toContain("Candidate Summary Table");
    expect(prompt).toContain("Candidate Bug Audit");
    expect(prompt).toContain("Best Ideas To Use");
    expect(prompt).toContain("Ideas To Reject");
    expect(prompt).toContain("Final Build Contract");
    expect(prompt).toContain("Main-Agent Test Obligations");
    expect(prompt).toContain("Rank candidates by requirement compliance first");
    expect(prompt).toContain("If visible tests pass but hidden probes fail, treat the candidate as failing");
    expect(prompt).toContain("must throw `LimitExceededError`");
    expect(prompt).not.toContain("ADVISORY mode");
  });

  test("advisory judge prompt requires final implementation contract and semantic checklists", () => {
    const prompt = buildJudgePrompt({
      task: "Build add(a,b)",
      mode: "plan",
      context,
      panel: [{ modelId: "panel", provider: "test", success: true, content: "advice", latencyMs: 1 }],
      panelMode: "advisory",
    });

    expect(prompt).toContain("ADVISORY mode");
    expect(prompt).toContain("Do NOT implement");
    expect(prompt).toContain("Requirement Ledger");
    expect(prompt).toContain("Consensus plan");
    expect(prompt).toContain("Disagreements between panels");
    expect(prompt).toContain("Exact API checklist");
    expect(prompt).toContain("Exact semantic checklist");
    expect(prompt).toContain("Hidden edge probe checklist");
    expect(prompt).toContain("Typed error checklist");
    expect(prompt).toContain("Immutability/safety checklist");
    expect(prompt).toContain("Determinism checklist");
    expect(prompt).toContain("Final implementation contract");
    expect(prompt).toContain("required hidden test");
    expect(prompt).not.toContain("CANDIDATE BUILD mode");
  });

  test("default judge prompt (no panelMode) uses existing requirement-by-requirement behavior", () => {
    const prompt = buildJudgePrompt({
      task: "Build add(a,b)",
      mode: "plan",
      context,
      panel: [{ modelId: "panel", provider: "test", success: true, content: "advice", latencyMs: 1 }],
    });

    expect(prompt).toContain("Build a requirement ledger from the original task");
    expect(prompt).not.toContain("CANDIDATE BUILD mode");
    expect(prompt).not.toContain("ADVISORY mode");
  });

  test("fusion-no-build markdown instructs automatic implementation and hidden-edge test obligations", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "plan",
      panelMode: "advisory",
      decision: "implement",
      summary: "Advisory synthesized.",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      finalRecommendation: "Proceed.",
      requirementChecklist: [],
      rejectedRiskyIdeas: [],
      finalBuildGuidance: "Contract",
      mustNotBreakConstraints: [],
      requiredTests: ["probe immutable reads"],
      finalOutput: "output",
      panel: [{ modelId: "a", provider: "test", success: true, content: "advice", latencyMs: 1 }],
      trace: { runId: "fusion-test", timestamp: "2026-06-16T12:00:00.000Z", mode: "plan", panelMode: "advisory", modelSource: "opencode", requestedModelSource: "opencode", actualModelSource: "opencode", fallbackUsed: false, panelModelsRequested: [{ modelId: "a" }], judgeModelRequested: { modelId: "judge" }, panel: [], judge: { modelId: "judge", success: true } },
    } as any);

    expect(markdown).toContain("implement the original user task automatically");
    expect(markdown).toContain("implementation contract");
    expect(markdown).toContain("hidden-edge checks were implemented as tests");
    expect(markdown).toContain("hidden-edge tests added");
    expect(markdown).toContain("Requirement Ledger");
    expect(markdown).toContain("Do not accept visible-test-only success");
  });

  test("fusion-build markdown instructs automatic implementation and hidden-edge test obligations", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "build_prompt",
      panelMode: "candidate_build",
      decision: "implement",
      summary: "Candidates compared.",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      finalRecommendation: "Build it.",
      requirementChecklist: [],
      rejectedRiskyIdeas: ["risky helper API"],
      finalBuildGuidance: "Final build contract",
      mustNotBreakConstraints: [],
      requiredTests: ["probe rollback on guard failure"],
      finalOutput: "output",
      panel: [{ modelId: "a", provider: "test", success: true, content: "candidate", latencyMs: 1 }],
      trace: { runId: "fusion-test", timestamp: "2026-06-16T12:00:00.000Z", mode: "build_prompt", panelMode: "candidate_build", modelSource: "opencode", requestedModelSource: "opencode", actualModelSource: "opencode", fallbackUsed: false, panelModelsRequested: [{ modelId: "a" }], judgeModelRequested: { modelId: "judge" }, panel: [], judge: { modelId: "judge", success: true } },
    } as any);

    expect(markdown).toContain("hidden-edge tests added");
    expect(markdown).toContain("implementation contract");
    expect(markdown).toContain("Requirement Ledger");
    expect(markdown).toContain("Do not accept visible-test-only success");
  });
});

describe("panelMode safety", () => {
  test("runCouncil with candidate_build passes panelMode to panel via prompt", async () => {
    const capturedPrompts: string[] = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId, prompt) => {
        capturedPrompts.push(prompt);
        if (modelId === "good") return completeCandidate;
        if (modelId === "bad") return completeCandidate;
        return JSON.stringify({
          decision: "implement",
          summary: "Three candidates compared.",
          consensus: [],
          contradictions: [],
          uniqueInsights: [],
          risks: [],
          missingConsiderations: [],
          requirementChecklist: [],
          rejectedRiskyIdeas: [],
          finalBuildGuidance: "Build it.",
          mustNotBreakConstraints: [],
          requiredTests: [],
          finalRecommendation: "Build it.",
          finalOutput: "Build it.",
        });
      },
    };

    await runCouncil(
      { task: "Build add(a,b)", mode: "build_prompt", panelMode: "candidate_build" },
      { config, modelRunner, trace: { saveRunArtifacts: false } },
    );

    const panelPrompts = capturedPrompts.slice(0, 2);
    for (const p of panelPrompts) {
      expect(p).toContain("CANDIDATE BUILD mode");
    }
  });

  test("runCouncil with advisory passes panelMode to panel via prompt", async () => {
    const capturedPrompts: string[] = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId, prompt) => {
        capturedPrompts.push(prompt);
        if (modelId === "good") return "Advisory output A";
        if (modelId === "bad") return "Advisory output B";
        return JSON.stringify({
          decision: "implement",
          summary: "Advisory synthesized.",
          consensus: [],
          contradictions: [],
          uniqueInsights: [],
          risks: [],
          missingConsiderations: [],
          requirementChecklist: [],
          rejectedRiskyIdeas: [],
          finalBuildGuidance: "not applicable",
          mustNotBreakConstraints: [],
          requiredTests: [],
          finalRecommendation: "Proceed carefully.",
          finalOutput: "Plan: do the thing.",
        });
      },
    };

    await runCouncil(
      { task: "Advise on add(a,b)", mode: "plan", panelMode: "advisory" },
      { config, modelRunner, trace: { saveRunArtifacts: false } },
    );

    const panelPrompts = capturedPrompts.slice(0, 2);
    for (const p of panelPrompts) {
      expect(p).toContain("ADVISORY mode");
    }
  });

  test("fusion-no-build safety: stops if any panel fails when requireAllPanels is true", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return "Advisory output";
        if (modelId === "bad") throw new Error("panel down");
        throw new Error("judge should not run");
      },
    };

    await expect(
      runCouncil(
        { task: "Advise on add(a,b)", mode: "plan", panelMode: "advisory", requireAllPanels: true },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/required panel models failed/i);
  });

  test("fusion-build safety: stops if any panel fails when requireAllPanels is true", async () => {
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "good") return completeCandidate;
        if (modelId === "bad") throw new Error("panel down");
        throw new Error("judge should not run");
      },
    };

    await expect(
      runCouncil(
        { task: "Build add(a,b)", mode: "build_prompt", panelMode: "candidate_build", requireAllPanels: true },
        { config, modelRunner, trace: { saveRunArtifacts: false } },
      ),
    ).rejects.toThrow(/required panel models failed/i);
  });
});
