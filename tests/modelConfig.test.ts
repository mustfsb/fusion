import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_JUDGE_MODEL, DEFAULT_PANEL_MODELS } from "../src/config.js";
import {
  loadSavedModelConfig,
  MODEL_FORMAT_HELP,
  formatSavedModelConfigMarkdown,
  formatUpdatedModelConfigMarkdown,
  parseModelArgs,
  parseModelSpec,
  resetSavedModelConfig,
  resolveModels,
  saveSavedModelConfig,
  validateModelId,
} from "../src/modelConfig.js";
import { formatCouncilResultMarkdown, runCouncil } from "../src/council/runCouncil.js";
import { OPENCODE_SDK_SUPPORTS_REASONING_EFFORT } from "../src/runners/opencodeModelRunner.js";
import type { FusionCouncilConfig, ModelRunner } from "../src/types.js";

let tmpDir: string;
let tmpConfigPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "fusion-model-test-"));
  tmpConfigPath = path.join(tmpDir, "fusion-council-models.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("parseModelSpec", () => {
  test("parses provider/model without effort", () => {
    expect(parseModelSpec("openai/gpt-5.4")).toEqual({ modelId: "openai/gpt-5.4", raw: "openai/gpt-5.4" });
    expect(parseModelSpec("opencode-go/kimi-k2.7-code")).toEqual({
      modelId: "opencode-go/kimi-k2.7-code",
      raw: "opencode-go/kimi-k2.7-code",
    });
  });

  test("preserves opencode-go panel provider prefixes exactly", () => {
    expect(parseModelSpec("opencode-go/qwen3.7-max")).toEqual({
      modelId: "opencode-go/qwen3.7-max",
      raw: "opencode-go/qwen3.7-max",
    });
    expect(parseModelSpec("opencode-go/kimi-k2.7-code")).toEqual({
      modelId: "opencode-go/kimi-k2.7-code",
      raw: "opencode-go/kimi-k2.7-code",
    });
    expect(parseModelSpec("opencode-go/minimax-m3")).toEqual({
      modelId: "opencode-go/minimax-m3",
      raw: "opencode-go/minimax-m3",
    });
  });

  test("parses provider/model/high and provider/model/xhigh", () => {
    expect(parseModelSpec("openai/gpt-5.4/high")).toEqual({
      modelId: "openai/gpt-5.4",
      reasoningEffort: "high",
      raw: "openai/gpt-5.4/high",
    });
    expect(parseModelSpec("openai/gpt-5.4/xhigh")).toEqual({
      modelId: "openai/gpt-5.4",
      reasoningEffort: "xhigh",
      raw: "openai/gpt-5.4/xhigh",
    });
  });

  test("preserves openai judge effort spec exactly", () => {
    expect(parseModelSpec("openai/gpt-5.4/high")).toEqual({
      modelId: "openai/gpt-5.4",
      reasoningEffort: "high",
      raw: "openai/gpt-5.4/high",
    });
  });

  test("parses panel model with effort", () => {
    expect(parseModelSpec("opencode-go/kimi-k2.7-code/medium")).toEqual({
      modelId: "opencode-go/kimi-k2.7-code",
      reasoningEffort: "medium",
      raw: "opencode-go/kimi-k2.7-code/medium",
    });
  });

  test("rejects invalid effort", () => {
    expect(() => parseModelSpec("openai/gpt-5.4/ultra")).toThrow(/Invalid reasoning effort/i);
    expect(() => parseModelSpec("openai/gpt-5.4/ultra")).toThrow(/Allowed efforts/i);
  });

  test("rejects missing provider, missing model, and extra slash segments", () => {
    expect(() => parseModelSpec("openai")).toThrow(MODEL_FORMAT_HELP);
    expect(() => parseModelSpec("openai/")).toThrow(MODEL_FORMAT_HELP);
    expect(() => parseModelSpec("/gpt-5.4")).toThrow(MODEL_FORMAT_HELP);
    expect(() => parseModelSpec("openai/gpt-5.4/high/extra")).toThrow(MODEL_FORMAT_HELP);
  });

  test("rejects empty model entries", () => {
    expect(() => parseModelSpec("   ")).toThrow(/Empty model entry/i);
  });
});

describe("parseModelArgs", () => {
  test("parses exactly 4 comma-separated model specs with optional effort", () => {
    const result = parseModelArgs(
      "opencode-go/kimi-k2.7-code, opencode-go/qwen3.7-max, opencode-go/minimax-m3, openai/gpt-5.4/high",
    );
    expect(result.panelModels).toEqual([
      { modelId: "opencode-go/kimi-k2.7-code", raw: "opencode-go/kimi-k2.7-code" },
      { modelId: "opencode-go/qwen3.7-max", raw: "opencode-go/qwen3.7-max" },
      { modelId: "opencode-go/minimax-m3", raw: "opencode-go/minimax-m3" },
    ]);
    expect(result.judgeModel).toEqual({
      modelId: "openai/gpt-5.4",
      reasoningEffort: "high",
      raw: "openai/gpt-5.4/high",
    });
  });

  test("keeps legacy provider/model syntax working", () => {
    const result = parseModelArgs("a/b, c/d, e/f, g/h");
    expect(result.panelModels).toEqual([
      { modelId: "a/b", raw: "a/b" },
      { modelId: "c/d", raw: "c/d" },
      { modelId: "e/f", raw: "e/f" },
    ]);
    expect(result.judgeModel).toEqual({ modelId: "g/h", raw: "g/h" });
  });

  test("rejects fewer than 4 model specs", () => {
    expect(() => parseModelArgs("a/b, c/d, e/f")).toThrow(/exactly 4/);
  });

  test("invalid format includes accepted format and allowed efforts", () => {
    expect(() => parseModelArgs("a/b, c/d, badformat, g/h")).toThrow(/Allowed efforts/i);
    expect(() => parseModelArgs("a/b, c/d, badformat, g/h")).toThrow(/provider\/model\/effort/i);
  });
});

describe("validateModelId", () => {
  test("accepts valid provider/model format", () => {
    expect(() => validateModelId("opencode-go/kimi-k2.7-code")).not.toThrow();
  });

  test("rejects model ID with no slash", () => {
    expect(() => validateModelId("gpt4")).toThrow(/provider\/model format/);
  });
});

describe("model config persistence", () => {
  test("saves effort in config", async () => {
    await saveSavedModelConfig(
      {
        panelModels: [
          { modelId: "openai/gpt-5.4", reasoningEffort: "medium", raw: "openai/gpt-5.4/medium" },
          { modelId: "a/b" },
          { modelId: "c/d" },
        ],
        judgeModel: { modelId: "openai/gpt-5.4", reasoningEffort: "high", raw: "openai/gpt-5.4/high" },
      },
      tmpConfigPath,
    );
    const loaded = await loadSavedModelConfig(tmpConfigPath);
    expect(loaded!.panelModels[0].reasoningEffort).toBe("medium");
    expect(loaded!.judgeModel.reasoningEffort).toBe("high");
  });

  test("migrates old string configs", async () => {
    await writeFile(
      tmpConfigPath,
      JSON.stringify({
        panelModels: ["a/b", "c/d", "e/f"],
        judgeModel: "g/h",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const loaded = await loadSavedModelConfig(tmpConfigPath);
    expect(loaded!.panelModels).toEqual([
      { modelId: "a/b" },
      { modelId: "c/d" },
      { modelId: "e/f" },
    ]);
    expect(loaded!.judgeModel).toEqual({ modelId: "g/h" });
  });

  test("reset clears effort and restores defaults", async () => {
    await saveSavedModelConfig(
      {
        panelModels: [{ modelId: "a/b", reasoningEffort: "high" }, { modelId: "c/d" }, { modelId: "e/f" }],
        judgeModel: { modelId: "g/h", reasoningEffort: "xhigh" },
      },
      tmpConfigPath,
    );
    await resetSavedModelConfig(tmpConfigPath);
    const result = await resolveModels(undefined, tmpConfigPath);
    expect(result.source).toBe("default");
    expect(result.panelModels).toEqual(DEFAULT_PANEL_MODELS.map((modelId) => ({ modelId })));
    expect(result.judgeModel).toEqual({ modelId: DEFAULT_JUDGE_MODEL });
  });
});

describe("resolveModels", () => {
  test("explicit args with effort override saved config", async () => {
    await saveSavedModelConfig(
      {
        panelModels: [{ modelId: "saved/p1" }, { modelId: "saved/p2" }, { modelId: "saved/p3" }],
        judgeModel: { modelId: "saved/judge", reasoningEffort: "low" },
      },
      tmpConfigPath,
    );
    const result = await resolveModels(
      {
        panelModels: ["explicit/p1", "explicit/p2/medium", "explicit/p3"],
        judgeModel: "explicit/judge/high",
      },
      tmpConfigPath,
    );
    expect(result.source).toBe("explicit");
    expect(result.panelModels[1].reasoningEffort).toBe("medium");
    expect(result.judgeModel).toEqual({
      modelId: "explicit/judge",
      reasoningEffort: "high",
      raw: "explicit/judge/high",
    });
  });

  test("saved config with effort beats defaults", async () => {
    await saveSavedModelConfig(
      {
        panelModels: [{ modelId: "saved/p1" }, { modelId: "saved/p2" }, { modelId: "saved/p3" }],
        judgeModel: { modelId: "saved/judge", reasoningEffort: "high" },
      },
      tmpConfigPath,
    );
    const result = await resolveModels(undefined, tmpConfigPath);
    expect(result.source).toBe("saved");
    expect(result.judgeModel.reasoningEffort).toBe("high");
  });
});

describe("model config markdown", () => {
  test("saved config output includes registry disclaimer", () => {
    const markdown = formatUpdatedModelConfigMarkdown({
      panelModels: [{ modelId: "a/b" }, { modelId: "c/d" }, { modelId: "e/f" }],
      judgeModel: { modelId: "g/h" },
    });
    expect(markdown).toContain("not registry-validated");
  });

  test("set output displays exact saved provider/model IDs", () => {
    const markdown = formatUpdatedModelConfigMarkdown(parseModelArgs(
      "opencode-go/qwen3.7-max, opencode-go/kimi-k2.7-code, opencode-go/minimax-m3, openai/gpt-5.4/high",
    ));
    expect(markdown).toContain("Saved Fusion models:");
    expect(markdown).toContain("Panel 1: opencode-go/qwen3.7-max");
    expect(markdown).toContain("Panel 2: opencode-go/kimi-k2.7-code");
    expect(markdown).toContain("Panel 3: opencode-go/minimax-m3");
    expect(markdown).toContain("Judge: openai/gpt-5.4/high");
    expect(markdown).toContain("Model IDs are passed through to OpenCode exactly");
  });

  test("show output displays exact saved provider/model IDs", () => {
    const parsed = parseModelArgs(
      "opencode-go/qwen3.7-max, opencode-go/kimi-k2.7-code, opencode-go/minimax-m3, openai/gpt-5.4/high",
    );
    const markdown = formatSavedModelConfigMarkdown({
      ...parsed,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, "Custom (saved)");
    expect(markdown).toContain("Panel 1: opencode-go/qwen3.7-max");
    expect(markdown).toContain("Panel 2: opencode-go/kimi-k2.7-code");
    expect(markdown).toContain("Panel 3: opencode-go/minimax-m3");
    expect(markdown).toContain("Judge: openai/gpt-5.4/high");
  });

  test("suspicious openai qwen model produces a warning", () => {
    const markdown = formatUpdatedModelConfigMarkdown(parseModelArgs(
      "openai/qwen3.7-max, opencode-go/kimi-k2.7-code, opencode-go/minimax-m3, openai/gpt-5.4/high",
    ));
    expect(markdown).toContain("Suspicious model ID: openai/qwen3.7-max. Did you mean opencode-go/qwen3.7-max?");
  });
});

describe("runner effort propagation", () => {
  const config: FusionCouncilConfig = {
    defaults: {
      panelModels: ["panel-a"],
      judgeModel: "judge",
      timeoutMs: 1000,
      maxPanelConcurrency: 1,
      postBuildContractAudit: true,
      maxPostBuildAuditFixCycles: 1,
    },
    models: {},
  };

  test("mock runner receives reasoningEffort option from panel and judge specs", async () => {
    const calls: Array<{ modelId: string; reasoningEffort?: string }> = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId, _prompt, options) => {
        calls.push({ modelId, reasoningEffort: options.reasoningEffort });
        if (modelId === "panel-a") return "panel";
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
      {
        task: "Design auth",
        mode: "plan",
        panelModelSpecs: [{ modelId: "panel-a", reasoningEffort: "medium" }],
        judgeModelSpec: { modelId: "judge", reasoningEffort: "high" },
        trace: { saveRunArtifacts: false },
      },
      { config, modelRunner },
    );

    expect(calls).toEqual([
      { modelId: "panel-a", reasoningEffort: "medium" },
      { modelId: "judge", reasoningEffort: "high" },
    ]);
  });

  test("no effort means no reasoningEffort option is passed", async () => {
    const calls: Array<{ reasoningEffort?: string }> = [];
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (_modelId, _prompt, options) => {
        calls.push({ reasoningEffort: options.reasoningEffort });
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
      {
        task: "Design auth",
        mode: "plan",
        panelModelSpecs: [{ modelId: "panel-a" }],
        judgeModelSpec: { modelId: "judge" },
        trace: { saveRunArtifacts: false },
      },
      { config, modelRunner },
    );

    expect(calls.every((call) => call.reasoningEffort === undefined)).toBe(true);
  });

  test("OpenCode SDK reasoning effort support flag is documented as unsupported", () => {
    expect(OPENCODE_SDK_SUPPORTS_REASONING_EFFORT).toBe(false);
  });
});

describe("model trace output", () => {
  test("markdown trace displays configured effort and unsupported application", () => {
    const markdown = formatCouncilResultMarkdown({
      mode: "plan",
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
      panel: [{ modelId: "panel-a", provider: "test", success: true, content: "ok", latencyMs: 1, reasoningEffort: "medium", reasoningEffortApplied: "unsupported" }],
      trace: {
        runId: "fusion-test",
        timestamp: "2026-06-16T12:00:00.000Z",
        mode: "plan",
        modelSource: "opencode",
        requestedModelSource: "opencode",
        actualModelSource: "test",
        fallbackUsed: false,
        panelModelsRequested: [{ modelId: "panel-a", reasoningEffort: "medium" }],
        judgeModelRequested: { modelId: "judge", reasoningEffort: "high" },
        panel: [{ modelId: "panel-a", success: true, reasoningEffort: "medium", reasoningEffortApplied: "unsupported" }],
        judge: { modelId: "judge", success: true, reasoningEffort: "high", reasoningEffortApplied: "unsupported" },
      },
    });

    expect(markdown).toContain("Panel 1: panel-a (effort: medium)");
    expect(markdown).toContain("Judge: judge (effort: high)");
    expect(markdown).toContain("configured effort not applied");
    expect(markdown).toContain("configuredEffort=medium");
    expect(markdown).toContain("appliedEffort=unsupported");
  });

  test("trace.json includes configured effort on panel and judge models", async () => {
    const config: FusionCouncilConfig = {
      defaults: { panelModels: ["panel-a"], judgeModel: "judge", timeoutMs: 1000, maxPanelConcurrency: 1, postBuildContractAudit: true, maxPostBuildAuditFixCycles: 1 },
      models: {},
    };
    const modelRunner: ModelRunner = {
      source: "test",
      generate: async (modelId) => {
        if (modelId === "panel-a") return "panel";
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

    const cwd = await mkdtemp(path.join(tmpdir(), "fusion-effort-trace-"));
    try {
      const result = await runCouncil(
        {
          task: "Design auth",
          mode: "plan",
          panelModelSpecs: [{ modelId: "panel-a", reasoningEffort: "medium", raw: "panel-a/medium" }],
          judgeModelSpec: { modelId: "judge", reasoningEffort: "high", raw: "judge/high" },
          trace: { saveRunArtifacts: true },
        },
        { config, modelRunner, cwd },
      );

      const traceJson = JSON.parse(await readFile(path.join(result.trace!.artifactDir!, "trace.json"), "utf8"));
      expect(traceJson.panelModelsRequested).toEqual([{ modelId: "panel-a", reasoningEffort: "medium", raw: "panel-a/medium" }]);
      expect(traceJson.judgeModelRequested).toEqual({ modelId: "judge", reasoningEffort: "high", raw: "judge/high" });
      expect(traceJson.panel[0].reasoningEffort).toBe("medium");
      expect(traceJson.judge.reasoningEffort).toBe("high");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
