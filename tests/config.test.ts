import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_JUDGE_MODEL, DEFAULT_PANEL_MODELS, getDefaultFusionConfig, loadFusionConfig } from "../src/config.js";

describe("default model setup", () => {
  test("uses OpenCode-native model IDs by default", () => {
    const config = getDefaultFusionConfig();

    expect(DEFAULT_PANEL_MODELS).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(DEFAULT_JUDGE_MODEL).toBe("openai/gpt-5.5");
    expect(config.defaults.panelModels).toEqual(DEFAULT_PANEL_MODELS);
    expect(config.defaults.judgeModel).toBe(DEFAULT_JUDGE_MODEL);
    expect(config.defaults.timeoutMs).toBe(600_000);
    expect(config.defaults.postBuildContractAudit).toBe(true);
    expect(config.defaults.maxPostBuildAuditFixCycles).toBe(1);
  });
});

describe("loadFusionConfig", () => {
  test("loads JSONC config and validates defaults and model records", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fusion-config-"));
    const configPath = path.join(dir, "fusion-council.config.jsonc");

    await writeFile(
      configPath,
      `{
        // comments are allowed
        "defaults": {
          "panelModels": ["fast", "careful"],
          "judgeModel": "judge",
          "timeoutMs": 1234,
          "maxPanelConcurrency": 2
        },
        "models": {
          "fast": { "provider": "openai-compatible", "model": "gpt-fast", "baseUrl": "https://api.example.test/v1", "apiKeyEnv": "OPENAI_API_KEY" },
          "careful": { "provider": "anthropic", "model": "claude-test", "apiKeyEnv": "ANTHROPIC_API_KEY" },
          "judge": { "provider": "google", "model": "gemini-test", "apiKeyEnv": "GOOGLE_API_KEY" }
        }
      }`,
    );

    try {
      const config = await loadFusionConfig(configPath);

      expect(config.defaults.panelModels).toEqual(["fast", "careful"]);
      expect(config.defaults.judgeModel).toBe("judge");
      expect(config.models.fast.provider).toBe("openai-compatible");
      expect(config.models.fast.baseUrl).toBe("https://api.example.test/v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allows OpenCode-style defaults without duplicated direct provider mappings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fusion-config-invalid-"));
    const configPath = path.join(dir, "fusion-council.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        defaults: {
          panelModels: ["opencode-go/kimi-k2.7-code"],
          judgeModel: "openai/gpt-5.5",
          timeoutMs: 1000,
          maxPanelConcurrency: 1,
        },
        models: {},
      }),
    );

    try {
      const config = await loadFusionConfig(configPath);
      expect(config.defaults.panelModels).toEqual(["opencode-go/kimi-k2.7-code"]);
      expect(config.defaults.judgeModel).toBe("openai/gpt-5.5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
