import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  bootstrapCanonicalModelConfig,
  SAVED_MODEL_CONFIG_PATH,
  type CanonicalModelConfig,
  type ModelSyncStatus,
} from "../modelConfig.js";
import type { FusionModelSpec } from "../modelSpec.js";
import {
  FUSION_AGENT_NAMES,
  FUSION_MODEL_CONFIG_FINGERPRINT_MARKER,
  buildJudgeAgentFile,
  buildOrchestratorAgentFile,
  buildPanelAgentFile,
} from "./agentTemplates.js";

export const FUSION_AGENT_DIR_NAME = "agent";
export const FUSION_AGENT_DIR_NAME_ALT = "agents";

export function defaultAgentDir(): string {
  const configDir = process.env.FUSION_OPENCODE_CONFIG_DIR;
  const base = configDir ?? path.join(homedir(), ".config", "opencode");
  return path.join(base, FUSION_AGENT_DIR_NAME);
}

export type AgentSyncInput = {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  configFingerprint: string;
};

export type AgentSyncResult = {
  agentDir: string;
  wrote: string[];
  configFingerprint: string;
  panelAgents: { panelIndex: number; agentName: string; modelId: string; reasoningEffort?: string }[];
  judgeAgent: { agentName: string; modelId: string; reasoningEffort?: string };
  orchestratorAgent: { agentName: string };
};

export const FUSION_AGENT_FILE_NAMES = [
  `${FUSION_AGENT_NAMES.orchestrator}.md`,
  `${FUSION_AGENT_NAMES.panel1}.md`,
  `${FUSION_AGENT_NAMES.panel2}.md`,
  `${FUSION_AGENT_NAMES.panel3}.md`,
  `${FUSION_AGENT_NAMES.judge}.md`,
];

export type InstalledAgentModels = {
  panelModels: Array<string | undefined>;
  judgeModel: string | undefined;
  fingerprint: string | undefined;
};

export async function readInstalledAgentModels(agentDir: string): Promise<InstalledAgentModels> {
  const panelModels: Array<string | undefined> = [];
  for (let index = 1; index <= 3; index += 1) {
    const agentId = FUSION_AGENT_NAMES[`panel${index}` as "panel1" | "panel2" | "panel3"];
    panelModels.push(await readAgentFileModel(agentDir, agentId));
  }
  return {
    panelModels,
    judgeModel: await readAgentFileModel(agentDir, FUSION_AGENT_NAMES.judge),
    fingerprint: await readAgentFileFingerprint(agentDir, FUSION_AGENT_NAMES.panel1),
  };
}

async function readAgentFileModel(agentDir: string, agentId: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.join(agentDir, `${agentId}.md`), "utf8");
    const match = text.match(/^model:\s*(.+)$/m);
    return match?.[1]?.trim()?.replace(/^"|"$/g, "");
  } catch {
    return undefined;
  }
}

export async function readAgentFileFingerprint(agentDir: string, agentId: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.join(agentDir, `${agentId}.md`), "utf8");
    const match = text.match(new RegExp(`^${FUSION_MODEL_CONFIG_FINGERPRINT_MARKER}\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export function evaluateModelSyncStatus(
  config: CanonicalModelConfig,
  installed: InstalledAgentModels,
): ModelSyncStatus {
  const panelConfigured = config.panelModels.map((spec) => spec.modelId);
  const judgeConfigured = config.judgeModel.modelId;
  const modelsMatch =
    panelConfigured.every((modelId, index) => installed.panelModels[index] === modelId) &&
    installed.judgeModel === judgeConfigured;
  const fingerprintMatch =
    installed.fingerprint != null && installed.fingerprint === config.fingerprint;
  let status: ModelSyncStatus["status"];
  if (modelsMatch && fingerprintMatch) {
    status = "synchronized";
  } else if (modelsMatch && !fingerprintMatch) {
    status = "restart required";
  } else {
    status = "stale";
  }
  return {
    panelConfigured,
    panelInstalled: installed.panelModels,
    judgeConfigured,
    judgeInstalled: installed.judgeModel,
    configFingerprint: config.fingerprint,
    agentFileFingerprint: installed.fingerprint,
    status,
  };
}

export async function inspectModelSyncStatus(
  configPath: string,
  agentDir = defaultAgentDir(),
): Promise<ModelSyncStatus> {
  const config = await bootstrapCanonicalModelConfig(configPath);
  const installed = await readInstalledAgentModels(agentDir);
  return evaluateModelSyncStatus(config, installed);
}

export async function syncNativeAgents(input: AgentSyncInput, agentDir = defaultAgentDir()): Promise<AgentSyncResult> {
  await mkdir(agentDir, { recursive: true });

  const wrote: string[] = [];
  const panelAgents: AgentSyncResult["panelAgents"] = [];

  const orchestratorFile = buildOrchestratorAgentFile();
  await writeAgentFile(agentDir, orchestratorFile.name, orchestratorFile.content);
  wrote.push(`${orchestratorFile.name}.md`);

  for (let index = 0; index < 3; index += 1) {
    const spec = input.panelModels[index] ?? input.panelModels[0];
    const panelIndex = index + 1;
    const file = buildPanelAgentFile({
      panelIndex,
      modelId: spec.modelId,
      reasoningEffort: spec.reasoningEffort,
      configFingerprint: input.configFingerprint,
    });
    await writeAgentFile(agentDir, file.name, file.content);
    wrote.push(`${file.name}.md`);
    panelAgents.push({
      panelIndex,
      agentName: file.name,
      modelId: spec.modelId,
      reasoningEffort: spec.reasoningEffort,
    });
  }

  const judgeFile = buildJudgeAgentFile({
    modelId: input.judgeModel.modelId,
    reasoningEffort: input.judgeModel.reasoningEffort,
    configFingerprint: input.configFingerprint,
  });
  await writeAgentFile(agentDir, judgeFile.name, judgeFile.content);
  wrote.push(`${judgeFile.name}.md`);

  verifyGeneratedAgentModels(input, agentDir);

  return {
    agentDir,
    wrote,
    configFingerprint: input.configFingerprint,
    panelAgents,
    judgeAgent: {
      agentName: judgeFile.name,
      modelId: input.judgeModel.modelId,
      reasoningEffort: input.judgeModel.reasoningEffort,
    },
    orchestratorAgent: { agentName: orchestratorFile.name },
  };
}

function verifyGeneratedAgentModels(input: AgentSyncInput, agentDir: string): void {
  for (let index = 0; index < 3; index += 1) {
    const spec = input.panelModels[index] ?? input.panelModels[0];
    const agentId = FUSION_AGENT_NAMES[`panel${index + 1}` as "panel1" | "panel2" | "panel3"];
    const installed = readAgentFileModelSync(agentDir, agentId);
    if (installed !== spec.modelId) {
      throw new Error(
        `Agent generation verification failed for ${agentId}: expected ${spec.modelId}, wrote ${installed ?? "missing"}`,
      );
    }
  }
  const judgeInstalled = readAgentFileModelSync(agentDir, FUSION_AGENT_NAMES.judge);
  if (judgeInstalled !== input.judgeModel.modelId) {
    throw new Error(
      `Agent generation verification failed for fusion-judge: expected ${input.judgeModel.modelId}, wrote ${judgeInstalled ?? "missing"}`,
    );
  }
}

function readAgentFileModelSync(agentDir: string, agentId: string): string | undefined {
  try {
    const text = readFileSync(path.join(agentDir, `${agentId}.md`), "utf8");
    const match = text.match(/^model:\s*(.+)$/m);
    return match?.[1]?.trim()?.replace(/^"|"$/g, "");
  } catch {
    return undefined;
  }
}

export async function syncNativeAgentsFromCanonicalConfig(
  configPath: string = SAVED_MODEL_CONFIG_PATH,
  agentDir = defaultAgentDir(),
): Promise<AgentSyncResult> {
  const config = await bootstrapCanonicalModelConfig(configPath);
  return syncNativeAgents(
    {
      panelModels: config.panelModels,
      judgeModel: config.judgeModel,
      configFingerprint: config.fingerprint,
    },
    agentDir,
  );
}

/** @deprecated Use syncNativeAgentsFromCanonicalConfig — never writes hardcoded defaults over user config. */
export async function syncDefaultNativeAgents(agentDir = defaultAgentDir()): Promise<AgentSyncResult> {
  return syncNativeAgentsFromCanonicalConfig(SAVED_MODEL_CONFIG_PATH, agentDir);
}

async function writeAgentFile(agentDir: string, agentName: string, content: string): Promise<void> {
  const filePath = path.join(agentDir, `${agentName}.md`);
  await writeFile(filePath, content, "utf8");
}

export async function readFusionAgentFile(agentDir: string, agentName: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(agentDir, `${agentName}.md`), "utf8");
  } catch {
    return undefined;
  }
}

export async function listFusionAgentFiles(agentDir: string): Promise<string[]> {
  const present: string[] = [];
  for (const agentName of [
    FUSION_AGENT_NAMES.orchestrator,
    FUSION_AGENT_NAMES.panel1,
    FUSION_AGENT_NAMES.panel2,
    FUSION_AGENT_NAMES.panel3,
    FUSION_AGENT_NAMES.judge,
  ]) {
    const text = await readFusionAgentFile(agentDir, agentName);
    if (text !== undefined) present.push(agentName);
  }
  return present;
}

export async function listNonFusionAgentFiles(agentDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(agentDir);
  } catch {
    return [];
  }
  const fusionSet = new Set(FUSION_AGENT_FILE_NAMES);
  return entries.filter((entry) => entry.endsWith(".md") && !fusionSet.has(entry));
}

export async function clearFusionAgentFiles(agentDir: string): Promise<void> {
  for (const fileName of FUSION_AGENT_FILE_NAMES) {
    await rm(path.join(agentDir, fileName), { force: true });
  }
}

export function formatAgentSyncMarkdown(result: AgentSyncResult): string {
  const panelLines = result.panelAgents.map(
    (panel) => `- Panel ${panel.panelIndex}: ${panel.agentName} -> ${panel.modelId}${panel.reasoningEffort ? ` (variant: ${panel.reasoningEffort})` : ""}`,
  );
  return [
    "Saved Fusion model configuration and synchronized native subagents.",
    `Config fingerprint: ${result.configFingerprint}`,
    "",
    ...panelLines,
    `- Judge: ${result.judgeAgent.agentName} -> ${result.judgeAgent.modelId}${result.judgeAgent.reasoningEffort ? ` (variant: ${result.judgeAgent.reasoningEffort})` : ""}`,
    `- Orchestrator: ${result.orchestratorAgent.agentName} (primary, uses active session model for /fusion-build)`,
    "",
    `Agent files written to: ${result.agentDir}`,
    `Files: ${result.wrote.join(", ")}`,
    "",
    "Restart OpenCode once so native agent definitions reload.",
  ].join("\n");
}

export function formatInstalledModelMapping(result: AgentSyncResult): string[] {
  return [
    ...result.panelAgents.map((panel) => `  fusion-panel-${panel.panelIndex} -> ${panel.modelId}`),
    `  fusion-judge -> ${result.judgeAgent.modelId}`,
  ];
}
