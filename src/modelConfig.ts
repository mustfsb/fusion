import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_JUDGE_MODEL, DEFAULT_PANEL_MODELS } from "./config.js";
import {
  formatModelSpecDisplay,
  formatModelSpecExact,
  getSuspiciousModelWarning,
  MODEL_REGISTRY_DISCLAIMER,
  normalizeModelSpecEntry,
  parseModelSpec,
  toModelSpec,
  type FusionModelSpec,
} from "./modelSpec.js";

export const SAVED_MODEL_CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "opencode",
  "fusion-council-models.json",
);

export type SavedModelConfig = {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  updatedAt: string;
};

export type ResolvedModels = {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  source: "explicit" | "saved" | "default";
};

export {
  MODEL_FORMAT_HELP,
  MODEL_REGISTRY_DISCLAIMER,
  parseModelSpec,
  validateModelId,
  type FusionModelSpec,
  type ReasoningEffort,
} from "./modelSpec.js";

export function getDefaultPanelModelSpecs(): FusionModelSpec[] {
  return DEFAULT_PANEL_MODELS.map((modelId) => ({ modelId }));
}

export function getDefaultJudgeModelSpec(): FusionModelSpec {
  return { modelId: DEFAULT_JUDGE_MODEL };
}

export function parseModelArgs(raw: string): {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
} {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 4) {
    throw new Error(
      `Expected exactly 4 model specs (3 panel + 1 judge), got ${parts.length}`,
    );
  }
  const specs = parts.map((part) => parseModelSpec(part));
  return { panelModels: specs.slice(0, 3), judgeModel: specs[3] };
}

function normalizeSavedConfig(data: unknown): SavedModelConfig | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.panelModels) || record.judgeModel == null) return null;
  return {
    panelModels: record.panelModels.map((entry) => normalizeModelSpecEntry(entry)),
    judgeModel: normalizeModelSpecEntry(record.judgeModel),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

export async function loadSavedModelConfig(
  configPath = SAVED_MODEL_CONFIG_PATH,
): Promise<SavedModelConfig | null> {
  try {
    const text = await readFile(configPath, "utf8");
    return normalizeSavedConfig(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function saveSavedModelConfig(
  config: { panelModels: FusionModelSpec[]; judgeModel: FusionModelSpec },
  configPath = SAVED_MODEL_CONFIG_PATH,
): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const data: SavedModelConfig = {
    panelModels: config.panelModels,
    judgeModel: config.judgeModel,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(configPath, JSON.stringify(data, null, 2), "utf8");
}

export async function resetSavedModelConfig(
  configPath = SAVED_MODEL_CONFIG_PATH,
): Promise<void> {
  try {
    await unlink(configPath);
  } catch {
    // Already deleted or never existed — not an error.
  }
}

function explicitPanelSpecs(panelModels?: string[]): FusionModelSpec[] | undefined {
  if (panelModels == null || panelModels.length === 0) return undefined;
  return panelModels.map((entry) => toModelSpec(entry));
}

function explicitJudgeSpec(judgeModel?: string): FusionModelSpec | undefined {
  if (judgeModel == null || judgeModel === "") return undefined;
  return toModelSpec(judgeModel);
}

export async function resolveModels(
  explicit?: { panelModels?: string[]; judgeModel?: string },
  configPath = SAVED_MODEL_CONFIG_PATH,
): Promise<ResolvedModels> {
  const explicitPanels = explicitPanelSpecs(explicit?.panelModels);
  const explicitJudge = explicitJudgeSpec(explicit?.judgeModel);
  const hasExplicitPanel = explicitPanels != null;
  const hasExplicitJudge = explicitJudge != null;

  if (hasExplicitPanel && hasExplicitJudge) {
    return {
      panelModels: explicitPanels,
      judgeModel: explicitJudge,
      source: "explicit",
    };
  }

  const saved = await loadSavedModelConfig(configPath);
  if (saved) {
    return {
      panelModels: hasExplicitPanel ? explicitPanels : saved.panelModels,
      judgeModel: hasExplicitJudge ? explicitJudge : saved.judgeModel,
      source: "saved",
    };
  }

  return {
    panelModels: hasExplicitPanel ? explicitPanels : getDefaultPanelModelSpecs(),
    judgeModel: hasExplicitJudge ? explicitJudge : getDefaultJudgeModelSpec(),
    source: "default",
  };
}

export function formatSavedModelConfigMarkdown(saved: SavedModelConfig, sourceLabel: string): string {
  const warnings = formatSuspiciousModelWarnings(saved.panelModels, saved.judgeModel);
  return [
    "## Fusion Council Model Config",
    `**Source:** ${sourceLabel}`,
    `**Config path:** ${SAVED_MODEL_CONFIG_PATH}`,
    saved.updatedAt ? `**Updated:** ${saved.updatedAt}` : undefined,
    "",
    "Saved Fusion models:",
    ...formatExactModelSummary(saved.panelModels, saved.judgeModel),
    "",
    "**Panel models:**",
    ...saved.panelModels.map((spec, index) => `- ${formatModelSpecDisplay(spec, index + 1)}`),
    "",
    `**Judge model:** ${formatModelSpecDisplay(saved.judgeModel, saved.panelModels.length + 1)}`,
    "",
    ...warnings,
    warnings.length > 0 ? "" : undefined,
    MODEL_REGISTRY_DISCLAIMER,
    "Note: Model IDs are passed through to OpenCode exactly. Confirm with /models if provider errors occur.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatUpdatedModelConfigMarkdown(config: {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
}): string {
  const warnings = formatSuspiciousModelWarnings(config.panelModels, config.judgeModel);
  return [
    "## Fusion Council Model Config Saved",
    "Fusion model config updated.",
    `**Config path:** ${SAVED_MODEL_CONFIG_PATH}`,
    "",
    "Saved Fusion models:",
    ...formatExactModelSummary(config.panelModels, config.judgeModel),
    "",
    "**Panel models:**",
    ...config.panelModels.map((spec, index) => `- ${formatModelSpecDisplay(spec, index + 1)}`),
    "",
    `**Judge model:** ${formatModelSpecDisplay(config.judgeModel, config.panelModels.length + 1)}`,
    "",
    ...warnings,
    warnings.length > 0 ? "" : undefined,
    MODEL_REGISTRY_DISCLAIMER,
    "Note: Model IDs are passed through to OpenCode exactly. Confirm with /models if provider errors occur.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatExactModelSummary(panelModels: FusionModelSpec[], judgeModel: FusionModelSpec): string[] {
  return [
    ...panelModels.map((spec, index) => `Panel ${index + 1}: ${formatModelSpecExact(spec)}`),
    `Judge: ${formatModelSpecExact(judgeModel)}`,
  ];
}

function formatSuspiciousModelWarnings(panelModels: FusionModelSpec[], judgeModel: FusionModelSpec): string[] {
  const warnings = [...panelModels, judgeModel]
    .map((spec) => getSuspiciousModelWarning(spec))
    .filter((warning): warning is string => warning !== undefined);
  return warnings.length > 0 ? ["Warnings:", ...warnings.map((warning) => `- ${warning}`)] : [];
}
