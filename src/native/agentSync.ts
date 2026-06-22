import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getDefaultJudgeModelSpec, getDefaultPanelModelSpecs } from "../modelConfig.js";
import type { FusionModelSpec } from "../modelSpec.js";
import {
  FUSION_AGENT_NAMES,
  buildJudgeAgentFile,
  buildOrchestratorAgentFile,
  buildPanelAgentFile,
} from "./agentTemplates.js";

export const FUSION_AGENT_DIR_NAME = "agent";
export const FUSION_AGENT_DIR_NAME_ALT = "agents";

export function defaultAgentDir(): string {
  return path.join(homedir(), ".config", "opencode", FUSION_AGENT_DIR_NAME);
}

export type AgentSyncInput = {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
};

export type AgentSyncResult = {
  agentDir: string;
  wrote: string[];
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
  });
  await writeAgentFile(agentDir, judgeFile.name, judgeFile.content);
  wrote.push(`${judgeFile.name}.md`);

  return {
    agentDir,
    wrote,
    panelAgents,
    judgeAgent: {
      agentName: judgeFile.name,
      modelId: input.judgeModel.modelId,
      reasoningEffort: input.judgeModel.reasoningEffort,
    },
    orchestratorAgent: { agentName: orchestratorFile.name },
  };
}

export async function syncDefaultNativeAgents(agentDir = defaultAgentDir()): Promise<AgentSyncResult> {
  return syncNativeAgents(
    { panelModels: getDefaultPanelModelSpecs(), judgeModel: getDefaultJudgeModelSpec() },
    agentDir,
  );
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
    (panel) => `- Panel ${panel.panelIndex} agent: ${panel.agentName} -> ${panel.modelId}${panel.reasoningEffort ? ` (variant: ${panel.reasoningEffort})` : ""}`,
  );
  return [
    "Saved Fusion model configuration and synchronized native subagents.",
    "",
    ...panelLines,
    `- Judge agent: ${result.judgeAgent.agentName} -> ${result.judgeAgent.modelId}${result.judgeAgent.reasoningEffort ? ` (variant: ${result.judgeAgent.reasoningEffort})` : ""}`,
    `- Orchestrator agent: ${result.orchestratorAgent.agentName} (primary, uses workspace default model)`,
    "",
    `Agent files written to: ${result.agentDir}`,
    `Files: ${result.wrote.join(", ")}`,
    "",
    "Restart OpenCode only if the installed version does not hot-reload agent definitions.",
  ].join("\n");
}
