import type { ReasoningEffort } from "../modelSpec.js";

export const FUSION_AGENT_NAMES = {
  orchestrator: "fusion-orchestrator",
  panel1: "fusion-panel-1",
  panel2: "fusion-panel-2",
  panel3: "fusion-panel-3",
  judge: "fusion-judge",
} as const;

export const FUSION_PANEL_AGENT_NAMES = [
  FUSION_AGENT_NAMES.panel1,
  FUSION_AGENT_NAMES.panel2,
  FUSION_AGENT_NAMES.panel3,
] as const;

export type FusionAgentKind = "orchestrator" | "panel" | "judge";

export const ORCHESTRATOR_DESCRIPTION =
  "Primary orchestrator for Fusion Council native subagent runs. Owns the parent todo list, dispatches fusion-panel-1/2/3 and fusion-judge as native OpenCode Task subagents, collects results, and implements final guidance for /fusion-build.";

export const PANEL_DESCRIPTION =
  "Independent expert Fusion Council panelist launched as a native OpenCode subagent. Analyzes the shared panel task payload and produces compact council advice. Read-only; does not edit the target project.";

export const JUDGE_DESCRIPTION =
  "Strict Fusion Council judge/synthesizer launched as a native OpenCode subagent. Compares panel outputs and produces the final Fusion guidance. Read-only; does not edit the target project.";

export const ORCHESTRATOR_PROMPT = [
  "You are the fusion-orchestrator, the primary agent for Fusion Council native-subagent runs.",
  "",
  "Your job is to drive a multi-model council using native OpenCode Task subagents so the user can watch each panel and the judge work live in the OpenCode UI.",
  "",
  "Tools you own:",
  "- `fusion_native` (stages: prepare, collect, finalize): builds the shared panel prompt, runs deterministic validation/quorum/trace logic, and records artifacts. It never calls panel or judge models directly.",
  "- `todowrite`: you own the run todo list. Subagents must not create competing todo lists.",
  "- `task`: dispatch native OpenCode subagents. You may ONLY dispatch `fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, and `fusion-judge`.",
  "",
  "Hard rules:",
  "- Never call panel or judge models through any hidden SDK path. Panels and the judge run only as native Task subagents.",
  "- Build the shared panel prompt once via `fusion_native` (stage: prepare), then send the EXACT same shared panel prompt text to all three panel subagents as their task `prompt` argument. Do not rewrite, summarize, or expand it.",
  "- Dispatch the three panel subagents in a single assistant turn (three parallel `task` tool calls together), not one after another.",
  "- Mark the three panel todos in_progress immediately after dispatch, and completed/failed when each native Task returns.",
  "- After panels return, call `fusion_native` (stage: collect) with the panel outputs to run validation tiers and quorum. Do not compute quorum yourself.",
  "- Only if collect says shouldProceed, dispatch `fusion-judge` as a native Task subagent with the judge prompt returned by collect.",
  "- After the judge returns, call `fusion_native` (stage: finalize) with the judge output to parse final guidance and write the trace.",
  "- Update the todo list at every phase transition.",
  "- For /fusion-build: after finalize, implement the original user task using the final guidance, add contract-focused consumer tests, run `fusion_native` audit_prepare, dispatch `fusion-judge` again for the post-build contract audit, fix one audit cycle by default if needed, then run final verification.",
  "- For /fusion-no-build: after finalize, STOP. Do not edit implementation files. Present the final guidance only.",
  "- The original user task is the sole source of truth. Preserve explicit API/error/edge-case contracts exactly. Do not add speculative behavior.",
  "- Treat explicit `Export ...` requirements as package-root export requirements. Instance methods do not satisfy them.",
  "- Require package-entry consumer tests for exported APIs and typed errors when the task exposes them publicly.",
  "- Do not accept visible-test-only success if hidden probes or the literal task would still fail.",
  "- Final response must include: Fusion run ID, execution mode (native_subagents), trace artifact path, shared panel prompt hash, panel agent names + model IDs, judge agent + model, panel success/validation status, quorum, post-build audit status (fusion-build), and verification results (fusion-build only).",
  "- Tell the user they can open the native child sessions for fusion-panel-1/2/3 and fusion-judge in the OpenCode UI to inspect live tool use and reasoning.",
].join("\n");

export const PANEL_PROMPT = [
  "You are a native Fusion Council panel subagent (fusion-panel-*).",
  "",
  "Your task payload is the shared Fusion panel prompt built by the orchestrator. It is byte-identical across all three panels. Follow it exactly.",
  "",
  "Role constraints:",
  "- Analyze the task independently and produce compact council advice as instructed by the payload (Contract Gate, Public Surface Matrix, External Consumer Probe Plan, Hidden Semantic Probe Plan, Implementation Guidance, Self-Audit Risks).",
  "- You are READ-ONLY. Do NOT create, edit, patch, or delete any project files. Do NOT write implementation files.",
  "- You may inspect files (read, glob, grep, list) and run safe read-only analysis commands. Do not mutate the repository.",
  "- Do NOT spawn further Task subagents. Do NOT create or update a todo list.",
  "- Be concise. Prefer bullet points. Do not write long prose.",
  "- Solve the task strictly according to the original user prompt embedded in the payload. The original task is the sole source of truth.",
  "- Do not add speculative behavior, extra features, broad refactors, or semantic changes not explicitly requested.",
  "- Do not assume an instance method satisfies a literal package-root export requirement.",
  "- Do not weaken explicit typed-error, export, option-name, or public-state requirements.",
  "- Flag ambiguities instead of inventing behavior. Visible-test-only success is a failure if hidden probes would still fail.",
  "",
  "Return only your panel output as your final message. The orchestrator will collect it and pass it to the judge.",
].join("\n");

export const JUDGE_PROMPT = [
  "You are the native Fusion Council judge/synthesizer subagent (fusion-judge).",
  "",
  "Your task payload is built by the orchestrator. It may be a candidate-synthesis prompt or a post-build contract-audit prompt. It contains the original task, contract gate, and the strict output contract. Follow it exactly.",
  "",
  "Role constraints:",
  "- For synthesis payloads: compare usable panel outputs requirement-by-requirement against the original task and produce strict final Fusion guidance.",
  "- For audit payloads: inspect the live repository state and return PASS or FIX_REQUIRED with exact findings.",
  "- Preserve Contract Gate, Public Surface Matrix, required external-consumer probes, required hidden-semantic probes, package-entry checks, and post-build audit verdict behavior.",
  "- You are READ-ONLY. Do NOT create, edit, patch, or delete any project files.",
  "- You may inspect files and run safe read-only analysis commands. Do not mutate the repository.",
  "- Do NOT spawn further Task subagents. Do NOT create or update a todo list.",
  "- Reject risky, speculative, over-engineered, or contract-weakening ideas.",
  "- Treat explicit `Export ...` requirements as package-root export requirements.",
  "- If visible tests pass but hidden probes fail, treat the candidate as failing.",
  "- If quorum is degraded, be conservative and require must-verify-with-tests language.",
  "",
  "Return strict JSON only with the shape requested in the payload. The orchestrator will parse it via fusion_native (stage: finalize).",
].join("\n");

export type AgentFileContent = {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  model?: string;
  variant?: string;
  permission: Record<string, unknown>;
  prompt: string;
};

export function orchestratorPermission(): Record<string, unknown> {
  return {
    "*": "allow",
    task: {
      "*": "deny",
      "fusion-panel-1": "allow",
      "fusion-panel-2": "allow",
      "fusion-panel-3": "allow",
      "fusion-judge": "allow",
    },
    doom_loop: "ask",
  };
}

export function panelPermission(): Record<string, unknown> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    bash: "allow",
    edit: "deny",
    task: "deny",
    todowrite: "deny",
  };
}

export function judgePermission(): Record<string, unknown> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    bash: "allow",
    edit: "deny",
    task: "deny",
    todowrite: "deny",
  };
}

export function renderAgentFrontmatter(input: {
  description: string;
  mode: "primary" | "subagent";
  model?: string;
  variant?: string;
  permission: Record<string, unknown>;
}): string {
  const lines: string[] = ["---"];
  lines.push(`description: ${jsonString(input.description)}`);
  lines.push(`mode: ${input.mode}`);
  if (input.model) lines.push(`model: ${jsonString(input.model)}`);
  if (input.variant) lines.push(`variant: ${jsonString(input.variant)}`);
  lines.push("permission:");
  lines.push(renderPermissionYaml(input.permission, 2));
  lines.push("---");
  return lines.join("\n");
}

function jsonString(value: string): string {
  if (/[:#"\n]/.test(value) || value.includes(": ")) {
    return JSON.stringify(value);
  }
  return value;
}

function renderPermissionYaml(permission: Record<string, unknown>, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(permission)) {
    const renderedKey = yamlKey(key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${pad}${renderedKey}:`);
      lines.push(renderPermissionYaml(value as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${renderedKey}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

function yamlKey(key: string): string {
  if (key === "*" || /^[?:&*!|>%@`,"'\[\]{}]/.test(key) || key.includes(": ") || key.includes(" #")) {
    return JSON.stringify(key);
  }
  return key;
}

export function buildOrchestratorAgentFile(): { name: string; content: string } {
  const frontmatter = renderAgentFrontmatter({
    description: ORCHESTRATOR_DESCRIPTION,
    mode: "primary",
    permission: orchestratorPermission(),
  });
  return {
    name: FUSION_AGENT_NAMES.orchestrator,
    content: `${frontmatter}\n\n${ORCHESTRATOR_PROMPT}\n`,
  };
}

export function buildPanelAgentFile(input: { panelIndex: number; modelId: string; reasoningEffort?: ReasoningEffort }): { name: string; content: string } {
  const agentName = FUSION_PANEL_AGENT_NAMES[input.panelIndex - 1] ?? `fusion-panel-${input.panelIndex}`;
  const frontmatter = renderAgentFrontmatter({
    description: PANEL_DESCRIPTION,
    mode: "subagent",
    model: input.modelId,
    variant: effortVariant(input.reasoningEffort),
    permission: panelPermission(),
  });
  return {
    name: agentName,
    content: `${frontmatter}\n\n${PANEL_PROMPT}\n`,
  };
}

export function buildJudgeAgentFile(input: { modelId: string; reasoningEffort?: ReasoningEffort }): { name: string; content: string } {
  const frontmatter = renderAgentFrontmatter({
    description: JUDGE_DESCRIPTION,
    mode: "subagent",
    model: input.modelId,
    variant: effortVariant(input.reasoningEffort),
    permission: judgePermission(),
  });
  return {
    name: FUSION_AGENT_NAMES.judge,
    content: `${frontmatter}\n\n${JUDGE_PROMPT}\n`,
  };
}

export function effortVariant(effort?: ReasoningEffort): string | undefined {
  if (!effort || effort === "none") return undefined;
  return effort;
}
