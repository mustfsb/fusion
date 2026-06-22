import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import type { FusionCouncilConfig } from "./types.js";
import { FusionCouncilError } from "./utils/errors.js";

export const DEFAULT_PANEL_MODELS = [
  "opencode-go/kimi-k2.7-code",
  "opencode-go/qwen3.7-max",
  "opencode-go/minimax-m3",
] as const;

export const DEFAULT_JUDGE_MODEL = "openai/gpt-5.5";

export function getDefaultFusionConfig(): FusionCouncilConfig {
  return {
    defaults: {
      panelModels: [...DEFAULT_PANEL_MODELS],
      judgeModel: DEFAULT_JUDGE_MODEL,
      timeoutMs: 600_000,
      maxPanelConcurrency: 3,
      postBuildContractAudit: true,
      maxPostBuildAuditFixCycles: 1,
    },
    models: {},
  };
}

const modelSchema = z.object({
  provider: z.enum(["openai-compatible", "anthropic", "google"]),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

const configSchema = z.object({
  defaults: z.object({
    panelModels: z.array(z.string().min(1)).min(1),
    judgeModel: z.string().min(1),
    timeoutMs: z.number().int().positive().default(600_000),
    maxPanelConcurrency: z.number().int().positive().default(4),
    postBuildContractAudit: z.boolean().default(true),
    maxPostBuildAuditFixCycles: z.number().int().nonnegative().default(1),
  }).partial().default({}),
  models: z.record(modelSchema).default({}),
});

export async function loadFusionConfig(configPath?: string, cwd = process.cwd()): Promise<FusionCouncilConfig> {
  const resolvedPath = configPath ? path.resolve(cwd, configPath) : await findDefaultConfig(cwd);
  if (!resolvedPath) {
    return getDefaultFusionConfig();
  }

  const text = await readFile(resolvedPath, "utf8");
  const parsed = parse(text);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new FusionCouncilError(`Invalid Fusion Council config: ${result.error.message}`);
  }

  const defaults = getDefaultFusionConfig().defaults;
  const config: FusionCouncilConfig = {
    defaults: {
      panelModels: result.data.defaults.panelModels ?? defaults.panelModels,
      judgeModel: result.data.defaults.judgeModel ?? defaults.judgeModel,
      timeoutMs: result.data.defaults.timeoutMs ?? defaults.timeoutMs,
      maxPanelConcurrency: result.data.defaults.maxPanelConcurrency ?? defaults.maxPanelConcurrency,
      postBuildContractAudit: result.data.defaults.postBuildContractAudit ?? defaults.postBuildContractAudit,
      maxPostBuildAuditFixCycles: result.data.defaults.maxPostBuildAuditFixCycles ?? defaults.maxPostBuildAuditFixCycles,
    },
    models: result.data.models,
  };

  return config;
}

export async function findDefaultConfig(cwd: string): Promise<string | undefined> {
  const candidates = [
    "fusion-council.config.jsonc",
    "fusion-council.config.json",
    ".opencode/fusion-council.config.jsonc",
    ".opencode/fusion-council.config.json",
  ];
  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      // Continue searching common config locations.
    }
  }
  return undefined;
}
