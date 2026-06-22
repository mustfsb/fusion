import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContractGate,
  ContextBundle,
  CouncilResult,
  CouncilMode,
  FusionModelSpec,
  PostBuildAuditTrace,
  FusionTraceOptions,
  NativePanelAgentPlan,
  NativePanelResult,
  NativeJudgeAgentPlan,
  PanelMode,
  PromptVerbosity,
} from "../types.js";
import { resolveTraceRoot } from "../trace/runTrace.js";

export type RunState = {
  runId: string;
  timestamp: string;
  command?: string;
  task: string;
  mode: CouncilMode;
  panelMode?: PanelMode;
  context: ContextBundle;
  contractGate: ContractGate;
  panelModelSpecs: FusionModelSpec[];
  judgeModelSpec: FusionModelSpec;
  sharedPanelPrompt: string;
  sharedPanelPromptHash: string;
  sharedPanelPromptPath: string;
  panelAgents: NativePanelAgentPlan[];
  judgeAgent: NativeJudgeAgentPlan;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
  promptVerbosity?: PromptVerbosity;
  traceOptions: FusionTraceOptions;
  postBuildContractAudit: boolean;
  maxPostBuildAuditFixCycles: number;
  panelResults?: NativePanelResult[];
  panelResponses?: import("../types.js").PanelResponse[];
  quorum?: import("../types.js").FusionTraceQuorum;
  judgePrompt?: string;
  judgeOutput?: string;
  judgeError?: string;
  finalGuidance?: string;
  councilResult?: CouncilResult;
  postBuildAuditPrompt?: string;
  postBuildAuditOutput?: string;
  postBuildAudit?: PostBuildAuditTrace;
};

export function hashSharedPanelPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function runStatePath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "run-state.json");
}

export function sharedPromptArtifactPath(cwd: string, runId: string, traceDir?: string): string {
  return path.join(resolveTraceRoot(cwd, traceDir), runId, "shared-panel-prompt.md");
}

export async function writeRunState(state: RunState, cwd: string, traceDir?: string): Promise<string> {
  const filePath = runStatePath(cwd, state.runId, traceDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

export async function loadRunState(cwd: string, runId: string, traceDir?: string): Promise<RunState> {
  const filePath = runStatePath(cwd, runId, traceDir);
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as RunState;
}

export async function writeSharedPromptArtifact(prompt: string, cwd: string, runId: string, traceDir?: string): Promise<string> {
  const filePath = sharedPromptArtifactPath(cwd, runId, traceDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, prompt, "utf8");
  return filePath;
}
