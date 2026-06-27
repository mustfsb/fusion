import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  validateModelId,
  type FusionModelSpec,
} from "./modelSpec.js";

export const CANONICAL_MODEL_CONFIG_VERSION = 1;

export const SAVED_MODEL_CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "opencode",
  "fusion-council-models.json",
);

export function resolveModelConfigPath(): string {
  if (process.env.FUSION_COUNCIL_MODELS_CONFIG_PATH) {
    return process.env.FUSION_COUNCIL_MODELS_CONFIG_PATH;
  }
  if (process.env.FUSION_OPENCODE_CONFIG_DIR) {
    return path.join(process.env.FUSION_OPENCODE_CONFIG_DIR, "fusion-council-models.json");
  }
  return SAVED_MODEL_CONFIG_PATH;
}

export type CanonicalModelConfig = {
  version: number;
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  fingerprint: string;
  updatedAt: string;
};

/** @deprecated Use CanonicalModelConfig */
export type SavedModelConfig = CanonicalModelConfig;

export type ResolvedModels = {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  fingerprint: string;
  source: "saved" | "bootstrap";
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

export function computeModelConfigFingerprint(input: {
  version?: number;
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
}): string {
  const payload = {
    version: input.version ?? CANONICAL_MODEL_CONFIG_VERSION,
    panelModels: input.panelModels.map((spec) => formatModelSpecExact(spec)),
    judgeModel: formatModelSpecExact(input.judgeModel),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")
    .slice(0, 16);
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

function normalizeCanonicalConfig(data: unknown): CanonicalModelConfig | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.panelModels) || record.judgeModel == null) return null;
  const panelModels = record.panelModels.map((entry) => normalizeModelSpecEntry(entry));
  const judgeModel = normalizeModelSpecEntry(record.judgeModel);
  const version = typeof record.version === "number" ? record.version : CANONICAL_MODEL_CONFIG_VERSION;
  const fingerprint =
    typeof record.fingerprint === "string" && record.fingerprint.length > 0
      ? record.fingerprint
      : computeModelConfigFingerprint({ version, panelModels, judgeModel });
  return {
    version,
    panelModels,
    judgeModel,
    fingerprint,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

export async function loadSavedModelConfig(
  configPath = resolveModelConfigPath(),
): Promise<CanonicalModelConfig | null> {
  try {
    const text = await readFile(configPath, "utf8");
    return normalizeCanonicalConfig(JSON.parse(text));
  } catch {
    return null;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export function buildCanonicalModelConfig(input: {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  updatedAt?: string;
}): CanonicalModelConfig {
  const version = CANONICAL_MODEL_CONFIG_VERSION;
  const fingerprint = computeModelConfigFingerprint({
    version,
    panelModels: input.panelModels,
    judgeModel: input.judgeModel,
  });
  return {
    version,
    panelModels: input.panelModels,
    judgeModel: input.judgeModel,
    fingerprint,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export async function saveSavedModelConfig(
  config: { panelModels: FusionModelSpec[]; judgeModel: FusionModelSpec },
  configPath = resolveModelConfigPath(),
): Promise<CanonicalModelConfig> {
  const data = buildCanonicalModelConfig(config);
  await atomicWriteJson(configPath, data);
  return data;
}

export async function bootstrapCanonicalModelConfig(
  configPath = resolveModelConfigPath(),
): Promise<CanonicalModelConfig> {
  const existing = await loadSavedModelConfig(configPath);
  if (existing) return existing;
  return saveSavedModelConfig(
    {
      panelModels: getDefaultPanelModelSpecs(),
      judgeModel: getDefaultJudgeModelSpec(),
    },
    configPath,
  );
}

export async function resetSavedModelConfig(
  configPath = resolveModelConfigPath(),
): Promise<CanonicalModelConfig> {
  return saveSavedModelConfig(
    {
      panelModels: getDefaultPanelModelSpecs(),
      judgeModel: getDefaultJudgeModelSpec(),
    },
    configPath,
  );
}

/** @deprecated Config is never deleted; reset writes defaults instead. */
export async function deleteSavedModelConfig(configPath = SAVED_MODEL_CONFIG_PATH): Promise<void> {
  try {
    await unlink(configPath);
  } catch {
    // ignore
  }
}

/**
 * Resolve panel/judge models exclusively from the canonical persisted config.
 * Bootstraps defaults on first-ever use; never derives from agent files,
 * manifests, environment, or launch arguments.
 */
export async function resolveModels(
  _explicit?: { panelModels?: string[]; judgeModel?: string },
  configPath = resolveModelConfigPath(),
): Promise<ResolvedModels> {
  const existing = await loadSavedModelConfig(configPath);
  if (existing) {
    return {
      panelModels: existing.panelModels,
      judgeModel: existing.judgeModel,
      fingerprint: existing.fingerprint,
      source: "saved",
    };
  }
  const bootstrapped = await saveSavedModelConfig(
    {
      panelModels: getDefaultPanelModelSpecs(),
      judgeModel: getDefaultJudgeModelSpec(),
    },
    configPath,
  );
  return {
    panelModels: bootstrapped.panelModels,
    judgeModel: bootstrapped.judgeModel,
    fingerprint: bootstrapped.fingerprint,
    source: "bootstrap",
  };
}

export function formatSavedModelConfigMarkdown(saved: CanonicalModelConfig, sourceLabel: string): string {
  const warnings = formatSuspiciousModelWarnings(saved.panelModels, saved.judgeModel);
  return [
    "## Fusion Council Model Config",
    `**Source:** ${sourceLabel}`,
    `**Config path:** ${SAVED_MODEL_CONFIG_PATH}`,
    saved.updatedAt ? `**Updated:** ${saved.updatedAt}` : undefined,
    `**Config fingerprint:** ${saved.fingerprint}`,
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
  fingerprint: string;
}): string {
  const warnings = formatSuspiciousModelWarnings(config.panelModels, config.judgeModel);
  return [
    "## Fusion Council Model Config Saved",
    "Fusion model config updated.",
    `**Config path:** ${SAVED_MODEL_CONFIG_PATH}`,
    `**Config fingerprint:** ${config.fingerprint}`,
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
    "Restart OpenCode once so native agent definitions reload.",
    "Note: Model IDs are passed through to OpenCode exactly. Confirm with /models if provider errors occur.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export type ModelSyncStatus = {
  panelConfigured: string[];
  panelInstalled: Array<string | undefined>;
  judgeConfigured: string;
  judgeInstalled: string | undefined;
  configFingerprint: string;
  agentFileFingerprint: string | undefined;
  status: "synchronized" | "restart required" | "stale";
};

export function formatModelSyncStatusMarkdown(status: ModelSyncStatus): string {
  const lines = [
    "## Fusion Council Model Config",
    "",
    `Panel 1 configured model: ${status.panelConfigured[0] ?? "—"}`,
    `Panel 1 installed agent-file model: ${status.panelInstalled[0] ?? "—"}`,
    `Panel 2 configured model: ${status.panelConfigured[1] ?? "—"}`,
    `Panel 2 installed agent-file model: ${status.panelInstalled[1] ?? "—"}`,
    `Panel 3 configured model: ${status.panelConfigured[2] ?? "—"}`,
    `Panel 3 installed agent-file model: ${status.panelInstalled[2] ?? "—"}`,
    `Judge configured model: ${status.judgeConfigured}`,
    `Judge installed agent-file model: ${status.judgeInstalled ?? "—"}`,
    `Config fingerprint: ${status.configFingerprint}`,
    `Agent-file fingerprint: ${status.agentFileFingerprint ?? "—"}`,
    `Status: ${status.status}`,
  ];
  if (status.status !== "synchronized") {
    lines.push("", "Restart OpenCode once after `/fusion-model` changes agent files.");
  }
  return lines.join("\n");
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
