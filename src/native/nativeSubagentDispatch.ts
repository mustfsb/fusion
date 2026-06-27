import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FusionModelSpec } from "../modelSpec.js";
import {
  defaultAgentDir,
  readInstalledAgentModels,
  syncNativeAgents,
} from "./agentSync.js";
import { FUSION_AGENT_NAMES, FUSION_PANEL_AGENT_NAMES } from "./agentTemplates.js";
import type { WorkerRecord } from "./supervisorTypes.js";

export const NATIVE_TASK_DISPATCH_MECHANISM = "native-visible-task-subagent";

export type NativePanelLaunchSpec = {
  logicalPanelIndex: 1 | 2 | 3;
  agentId: string;
  configuredModelId: string;
  candidateWorkspace: string;
  prohibitedSourceWorkspace: string;
  taskArtifactPath: string;
  taskArtifactHash: string;
  executionContextPath: string;
  resultArtifactPath: string;
  instructionArtifactPath: string;
  prompt: string;
  description: string;
};

export type NativeJudgeLaunchSpec = {
  agentId: string;
  configuredModelId: string;
  prompt: string;
  description: string;
  resultArtifactPath: string;
  instructionArtifactPath: string;
};

export type NativeDispatchRequest = {
  agentId: string;
  logicalPanelIndex?: 1 | 2 | 3;
  configuredModelId: string;
  prompt: string;
  description: string;
  dispatchRequestedAt: string;
  resultArtifactPath: string;
  instructionArtifactPath: string;
  candidateWorkspace?: string;
};

export type NativeDispatchReceipt = {
  agentId: string;
  logicalPanelIndex?: 1 | 2 | 3;
  sessionId: string;
  taskId?: string;
  configuredModelId: string;
  dispatchMechanism: string;
  dispatchRequestedAt: string;
  dispatchedAt: string;
  candidateWorkspace?: string;
  resultArtifactPath: string;
};

export type NativeSessionTerminal = {
  sessionId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  terminalAt: string;
  errorSummary?: string;
};

export interface NativeSubagentDispatcher {
  readonly mechanism: string;
  validatePanelAgents(panelModels: FusionModelSpec[]): Promise<void>;
  dispatchPanelsConcurrently(requests: NativeDispatchRequest[]): Promise<NativeDispatchReceipt[]>;
  dispatchJudge(request: NativeDispatchRequest): Promise<NativeDispatchReceipt>;
  waitForTerminal?(sessionId: string): Promise<NativeSessionTerminal>;
}

export class FusionNativePanelDispatchError extends Error {
  constructor(
    message: string,
    readonly details: {
      agentId?: string;
      configuredModel?: string;
      dispatchMechanism: string;
      cause: string;
    },
  ) {
    super(message);
    this.name = "FusionNativePanelDispatchError";
  }
}

export function formatNativePanelDispatchFailure(error: FusionNativePanelDispatchError): string {
  const parts = [
    "FUSION_NATIVE_PANEL_DISPATCH_FAILED",
    error.details.agentId ? `agentId=${error.details.agentId}` : undefined,
    error.details.configuredModel ? `configuredModel=${error.details.configuredModel}` : undefined,
    `dispatchMechanism=${error.details.dispatchMechanism}`,
    `failure=${error.details.cause}`,
  ].filter(Boolean);
  return parts.join(": ");
}

/**
 * Raised when stale native agent files were repaired from canonical config but
 * OpenCode must restart before workers can launch with the updated definitions.
 */
export class FusionRestartRequiredAfterAgentResyncError extends Error {
  constructor(
    readonly details: {
      configFingerprint: string;
      repairedAgents: string[];
    },
  ) {
    super(formatRestartRequiredAfterAgentResync(details));
    this.name = "FusionRestartRequiredAfterAgentResyncError";
  }
}

export function formatRestartRequiredAfterAgentResync(details: {
  configFingerprint: string;
  repairedAgents: string[];
}): string {
  return [
    "FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC",
    "Installed native agent files disagreed with the persisted /fusion-model configuration.",
    "Agent files were repaired from the canonical Fusion model config; the config was NOT modified.",
    `Config fingerprint: ${details.configFingerprint}`,
    `Repaired agents: ${details.repairedAgents.join(", ")}`,
    "Restart OpenCode, then rerun /fusion-build.",
  ].join("\n");
}

/** @deprecated Stale agent recovery now uses FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC. */
export class FusionNativeAgentConfigMismatchError extends Error {
  constructor(
    readonly details: { agentId: string; configuredModel: string; agentFileModel: string },
  ) {
    super(formatNativeAgentConfigMismatch(details));
    this.name = "FusionNativeAgentConfigMismatchError";
  }
}

/** @deprecated */
export function formatNativeAgentConfigMismatch(details: {
  agentId: string;
  configuredModel: string;
  agentFileModel: string;
}): string {
  return [
    "FUSION_NATIVE_AGENT_CONFIG_MISMATCH",
    `agent "${details.agentId}": persisted Fusion model config = ${details.configuredModel}, ` +
      `installed agent file model = ${details.agentFileModel}`,
  ].join("\n");
}

export type NativeAgentReconcileResult = {
  synchronized: boolean;
  configFingerprint: string;
  installedAgentFingerprint?: string;
  installedAgentModels: {
    panelModels: string[];
    judgeModel: string;
  };
};

export async function reconcileNativeAgentsAtLaunch(input: {
  panelModels: FusionModelSpec[];
  judgeModel: FusionModelSpec;
  configFingerprint: string;
  agentDir?: string;
}): Promise<NativeAgentReconcileResult> {
  const agentDir = input.agentDir ?? defaultAgentDir();
  const installed = await readInstalledAgentModels(agentDir);
  const expectedPanels = input.panelModels.map((spec) => spec.modelId);
  const expectedJudge = input.judgeModel.modelId;
  const modelsMatch =
    expectedPanels.every((modelId, index) => installed.panelModels[index] === modelId) &&
    installed.judgeModel === expectedJudge;
  const fingerprintMatch =
    installed.fingerprint != null && installed.fingerprint === input.configFingerprint;

  if (modelsMatch && fingerprintMatch) {
    return {
      synchronized: true,
      configFingerprint: input.configFingerprint,
      installedAgentFingerprint: installed.fingerprint,
      installedAgentModels: {
        panelModels: expectedPanels,
        judgeModel: expectedJudge,
      },
    };
  }

  await syncNativeAgents(
    {
      panelModels: input.panelModels,
      judgeModel: input.judgeModel,
      configFingerprint: input.configFingerprint,
    },
    agentDir,
  );

  throw new FusionRestartRequiredAfterAgentResyncError({
    configFingerprint: input.configFingerprint,
    repairedAgents: [...FUSION_PANEL_AGENT_NAMES, FUSION_AGENT_NAMES.judge],
  });
}

export function assertJudgeDispatchModelConsistency(input: {
  configuredJudgeModelId: string;
  agentFileJudgeModelId: string;
  dispatchJudgeModelId: string;
}): void {
  const { configuredJudgeModelId, agentFileJudgeModelId, dispatchJudgeModelId } = input;
  if (
    configuredJudgeModelId !== agentFileJudgeModelId ||
    configuredJudgeModelId !== dispatchJudgeModelId ||
    agentFileJudgeModelId !== dispatchJudgeModelId
  ) {
    throw new Error(
      [
        "FUSION_JUDGE_MODEL_CONFIG_MISMATCH",
        `configured judge model = ${configuredJudgeModelId}`,
        `native fusion-judge agent-file model = ${agentFileJudgeModelId}`,
        `recorded judge dispatch model = ${dispatchJudgeModelId}`,
      ].join("\n"),
    );
  }
}

export async function readNativeJudgeAgentModel(agentDir: string = defaultAgentDir()): Promise<string | undefined> {
  const frontmatter = await readAgentFrontmatter(agentDir, FUSION_AGENT_NAMES.judge);
  return frontmatter?.model;
}

type ParsedAgentFrontmatter = {
  mode?: string;
  model?: string;
};

async function readAgentFrontmatter(agentDir: string, agentId: string): Promise<ParsedAgentFrontmatter | undefined> {
  try {
    const text = await readFile(path.join(agentDir, `${agentId}.md`), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return undefined;
    const body = match[1] ?? "";
    const mode = body.match(/^mode:\s*(.+)$/m)?.[1]?.trim();
    const model = body.match(/^model:\s*(.+)$/m)?.[1]?.trim()?.replace(/^"|"$/g, "");
    return { mode, model };
  } catch {
    return undefined;
  }
}

export async function validateNativePanelAgents(
  panelModels: FusionModelSpec[],
  agentDir: string = defaultAgentDir(),
): Promise<void> {
  for (let index = 0; index < FUSION_PANEL_AGENT_NAMES.length; index += 1) {
    const agentId = FUSION_PANEL_AGENT_NAMES[index];
    const configuredModel = panelModels[index]?.modelId;
    if (!configuredModel) {
      throw new FusionNativePanelDispatchError(formatNativePanelDispatchFailure(new FusionNativePanelDispatchError("", {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: "missing configured panel model",
      })), {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: "missing configured panel model",
      });
    }
    const frontmatter = await readAgentFrontmatter(agentDir, agentId);
    if (!frontmatter) {
      throw new FusionNativePanelDispatchError(formatNativePanelDispatchFailure(new FusionNativePanelDispatchError("", {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `native agent file missing at ${path.join(agentDir, `${agentId}.md`)}`,
      })), {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `native agent file missing at ${path.join(agentDir, `${agentId}.md`)}`,
      });
    }
    if (frontmatter.mode !== "subagent") {
      throw new FusionNativePanelDispatchError(formatNativePanelDispatchFailure(new FusionNativePanelDispatchError("", {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `agent "${agentId}" is not configured as mode: subagent (found ${frontmatter.mode ?? "unknown"})`,
      })), {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `agent "${agentId}" is not configured as mode: subagent (found ${frontmatter.mode ?? "unknown"})`,
      });
    }
    if (!frontmatter.model) {
      throw new FusionNativePanelDispatchError(formatNativePanelDispatchFailure(new FusionNativePanelDispatchError("", {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `agent "${agentId}" is missing an explicit model in its native agent config`,
      })), {
        agentId,
        configuredModel,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        cause: `agent "${agentId}" is missing an explicit model in its native agent config`,
      });
    }
    if (frontmatter.model !== configuredModel) {
      // Persisted config is the source of truth: fail loudly, never rewrite it.
      throw new FusionNativeAgentConfigMismatchError({
        agentId,
        configuredModel,
        agentFileModel: frontmatter.model,
      });
    }
  }
}

export async function validateNativeJudgeAgent(
  judgeModel: FusionModelSpec,
  agentDir: string = defaultAgentDir(),
): Promise<void> {
  const agentId = FUSION_AGENT_NAMES.judge;
  const frontmatter = await readAgentFrontmatter(agentDir, agentId);
  if (!frontmatter || frontmatter.mode !== "subagent" || !frontmatter.model) {
    throw new Error(
      `FUSION_NATIVE_PANEL_DISPATCH_FAILED: agentId=${agentId}; configuredModel=${judgeModel.modelId}; ` +
        `dispatchMechanism=${NATIVE_TASK_DISPATCH_MECHANISM}; failure=judge native agent unavailable or misconfigured`,
    );
  }
  if (frontmatter.model !== judgeModel.modelId) {
    throw new FusionNativeAgentConfigMismatchError({
      agentId,
      configuredModel: judgeModel.modelId,
      agentFileModel: frontmatter.model,
    });
  }
}

export function buildHybridPanelDispatchPrompt(input: {
  runId: string;
  logicalPanelIndex: 1 | 2 | 3;
  agentId: string;
  canonicalTaskHash: string;
  candidateWorkspace: string;
  prohibitedSourceWorkspace: string;
  taskArtifactPath: string;
  executionContextPath: string;
  resultArtifactPath: string;
  receiptArtifactPath: string;
  panelResultArtifactPath: string;
  verificationArtifactPath: string;
}): string {
  return [
    `You are an independent implementation worker (${input.agentId}).`,
    `Your candidate workspace is: ${input.candidateWorkspace}`,
    `The source workspace is prohibited: ${input.prohibitedSourceWorkspace}`,
    "Before modifying anything, verify your candidate workspace.",
    "Use only the candidate workspace for all reads, writes, tests, and git commands.",
    "Do not write to the source workspace.",
    "",
    `Read your panel execution context fully until EOF: ${input.executionContextPath}`,
    `Read the canonical task fully until EOF: ${input.taskArtifactPath}`,
    "",
    "Implement the task independently in YOUR candidate workspace only.",
    "Do NOT wait for another panel or the main builder.",
    "Run typecheck/test/build inside the candidate workspace.",
    "",
    "When finished, write these deterministic artifacts ONLY inside your candidate workspace:",
    `1) Receipt JSON: ${input.receiptArtifactPath}`,
    "   Required fields: runId, panelId, agentId, canonicalTaskHash, candidateWorkspace, status[completed|failed], completedAt, summary.",
    `   Use runId=${input.runId}, panelId=${input.agentId}, agentId=${input.agentId}, canonicalTaskHash=${input.canonicalTaskHash}, candidateWorkspace=${input.candidateWorkspace}.`,
    `2) Panel result JSON: ${input.panelResultArtifactPath}`,
    `3) Verification JSON: ${input.verificationArtifactPath}`,
    `4) Supervisor result JSON: ${input.resultArtifactPath} ` +
      "(fields: workerId, role, status[completed|failed], changedFiles, verification, errorSummary, completedAt).",
  ].join("\n");
}

export function buildHybridJudgeDispatchPrompt(input: {
  manifestPath: string;
  resultArtifactPath: string;
  sourceWorkspace: string;
  contractPath: string;
}): string {
  return [
    "You are the visible native fusion-judge subagent.",
    `You run directly against the real source workspace: ${input.sourceWorkspace}`,
    "You have permission to make targeted code changes there.",
    "",
    "Compare the promoted main implementation against all usable panel candidates.",
    "Compare panel outputs to the actual promoted main code, not only to panel chat text.",
    "Use only the candidate/result artifact PATHS in the preflight manifest; do not request inlined source trees.",
    `Preflight manifest (read it fully): ${input.manifestPath}`,
    "",
    "Write a Merge Patch Contract markdown file with exactly these sections:",
    "1. Main Baseline Assessment",
    "2. Panel Candidate Assessment",
    "3. Common Ground",
    "4. Key Differences",
    "5. Unique Additions",
    "6. Main Strengths To Preserve",
    "7. Main Requirement Gaps",
    "8. Safe Panel Improvements To Adopt",
    "9. Rejected Panel Ideas",
    "10. Required Tests",
    "11. Applied Patch Summary",
    "12. Final Verification",
    "13. Final Decision",
    `Write the contract to: ${input.contractPath}`,
    "",
    "Then APPLY targeted fixes yourself directly to the real source workspace. You may apply ONLY:",
    "- blocker fixes",
    "- mandatory literal requirement fixes",
    "- verified correctness fixes",
    "- safe compatibility additions",
    "- tests needed to prove them",
    "Do NOT wholesale copy a panel candidate over the main source workspace.",
    "Preserve correct main implementation decisions when panels are weaker.",
    "After patching, run project verification (typecheck/test/build) in the real source workspace.",
    "",
    `When finished, write your machine-readable result JSON to: ${input.resultArtifactPath} ` +
      "(fields: workerId, role, status[completed|failed], mergePatchDecision, contractPath, " +
      "appliedPatchItems[{severity,title,status}], verification, errorSummary, completedAt).",
  ].join("\n");
}

export type FakeNativeDispatchBehavior = Record<
  string,
  {
    sleepMs?: number;
    outcome?: "complete" | "fail" | "hang";
    changedFile?: string;
    observedModel?: string;
    decision?: "PATCH_REQUIRED" | "NO_PATCH_REQUIRED";
    writeContract?: boolean;
    appliedPatchItems?: Array<{ severity: "BLOCKER" | "MUST_FIX" | "SAFE_ADDITION"; title: string; status: "applied" | "skipped" | "failed" }>;
    verification?: Record<string, unknown>;
  }
>;

/**
 * Test-only dispatcher that simulates visible native Task dispatch by writing
 * panel/judge result artifacts concurrently without external `opencode run`.
 */
export function createFakeNativeSubagentDispatcher(input: {
  behavior: FakeNativeDispatchBehavior | (() => FakeNativeDispatchBehavior);
  getWorkers: () => Record<string, WorkerRecord>;
  now?: () => number;
  skipAgentValidation?: boolean;
}): NativeSubagentDispatcher {
  const now = input.now ?? Date.now;
  let panelDispatchOrder: number[] = [];
  let panelDispatchStartedAt: number | undefined;

  const resolveBehavior = (): FakeNativeDispatchBehavior =>
    typeof input.behavior === "function" ? input.behavior() : input.behavior;

  async function simulateWorker(request: NativeDispatchRequest): Promise<NativeSessionTerminal> {
    const workers = input.getWorkers();
    const worker =
      Object.values(workers).find((entry) => entry.agentId === request.agentId) ??
      workers[request.agentId] ??
      Object.values(workers).find((entry) => entry.logicalPanelIndex === request.logicalPanelIndex);
    const workerId = worker?.workerId ?? request.agentId;
    const behavior =
      resolveBehavior()[workerId] ??
      resolveBehavior()[request.agentId] ??
      resolveBehavior()["fusion-judge"] ??
      {};
    const sleepMs = behavior.sleepMs ?? 50;
    const outcome = behavior.outcome ?? "complete";
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    if (outcome === "hang") {
      await new Promise(() => undefined);
    }
    const terminalAt = new Date(now()).toISOString();
    const workspace = request.candidateWorkspace ?? worker?.workspacePath ?? process.cwd();
    let contractPath: string | undefined;
    if (outcome === "fail") {
      const failed = {
        workerId,
        role: worker?.role ?? (request.logicalPanelIndex ? "panel" : "judge"),
        workspacePath: workspace,
        status: "failed",
        errorSummary: "fake native panel failure",
        completedAt: terminalAt,
      };
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(request.resultArtifactPath), { recursive: true });
      await writeFile(request.resultArtifactPath, JSON.stringify(failed, null, 2), "utf8");
      return { sessionId: request.agentId, status: "failed", terminalAt, errorSummary: "fake native panel failure" };
    }
    if (behavior.changedFile && worker) {
      const target = path.join(workspace, behavior.changedFile);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `// ${workerId}\n`, "utf8");
    }
    if (behavior.writeContract) {
      contractPath = path.join(path.dirname(request.resultArtifactPath), "merge-patch-contract.md");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(contractPath), { recursive: true });
      await writeFile(contractPath, `# Merge Patch Contract\n\nDecision: ${behavior.decision ?? "NO_PATCH_REQUIRED"}\n`, "utf8");
    }
    const isJudge = worker?.role === "judge" || request.agentId === "fusion-judge";
    const appliedPatchItems = isJudge
      ? behavior.appliedPatchItems ??
        (behavior.changedFile
          ? [{ severity: "BLOCKER" as const, title: behavior.changedFile, status: "applied" as const }]
          : [])
      : undefined;
    const result = {
      workerId,
      role: worker?.role ?? (request.logicalPanelIndex ? "panel" : "judge"),
      runId: worker?.taskArtifactHash,
      workspacePath: workspace,
      taskHash: worker?.taskArtifactHash,
      status: "completed",
      changedFiles: behavior.changedFile ? [behavior.changedFile] : [],
      verification: behavior.verification ?? { typecheck: "pass", test: "pass", build: "pass" },
      completedAt: terminalAt,
      errorSummary: undefined,
      mergePatchDecision: isJudge ? behavior.decision ?? "NO_PATCH_REQUIRED" : undefined,
      contractPath: isJudge ? contractPath : undefined,
      appliedPatchItems,
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(request.resultArtifactPath), { recursive: true });
    await writeFile(request.resultArtifactPath, JSON.stringify(result, null, 2), "utf8");
    return { sessionId: request.agentId, status: "completed", terminalAt };
  }

  return {
    mechanism: NATIVE_TASK_DISPATCH_MECHANISM,
    async validatePanelAgents(panelModels) {
      if (input.skipAgentValidation) return;
      await validateNativePanelAgents(panelModels);
    },
    async dispatchPanelsConcurrently(requests) {
      panelDispatchOrder = [];
      panelDispatchStartedAt = now();
      const receipts = await Promise.all(
        requests.map(async (request) => {
          panelDispatchOrder.push(request.logicalPanelIndex ?? 0);
          const dispatchedAt = new Date(now()).toISOString();
          const sessionId = `native-session-${request.agentId}-${now()}`;
          void simulateWorker(request);
          return {
            agentId: request.agentId,
            logicalPanelIndex: request.logicalPanelIndex,
            sessionId,
            configuredModelId: request.configuredModelId,
            dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
            dispatchRequestedAt: request.dispatchRequestedAt,
            dispatchedAt,
            candidateWorkspace: request.candidateWorkspace,
            resultArtifactPath: request.resultArtifactPath,
          };
        }),
      );
      return receipts;
    },
    async dispatchJudge(request) {
      const dispatchedAt = new Date(now()).toISOString();
      const sessionId = `native-session-${request.agentId}-${now()}`;
      await simulateWorker(request);
      return {
        agentId: request.agentId,
        sessionId,
        configuredModelId: request.configuredModelId,
        dispatchMechanism: NATIVE_TASK_DISPATCH_MECHANISM,
        dispatchRequestedAt: request.dispatchRequestedAt,
        dispatchedAt,
        resultArtifactPath: request.resultArtifactPath,
      };
    },
    getPanelDispatchOrder: () => panelDispatchOrder,
    getPanelDispatchStartedAt: () => panelDispatchStartedAt,
  } as NativeSubagentDispatcher & {
    getPanelDispatchOrder: () => number[];
    getPanelDispatchStartedAt: () => number | undefined;
  };
}

export function createRecordingNativeDispatcher(
  delegate: NativeSubagentDispatcher,
  recordings: {
    panelRequests: NativeDispatchRequest[];
    judgeRequests: NativeDispatchRequest[];
    panelReceipts: NativeDispatchReceipt[];
    judgeReceipts: NativeDispatchReceipt[];
  },
): NativeSubagentDispatcher {
  return {
    mechanism: delegate.mechanism,
    validatePanelAgents: (panelModels) => delegate.validatePanelAgents(panelModels),
    async dispatchPanelsConcurrently(requests) {
      recordings.panelRequests.push(...requests);
      const receipts = await delegate.dispatchPanelsConcurrently(requests);
      recordings.panelReceipts.push(...receipts);
      return receipts;
    },
    async dispatchJudge(request) {
      recordings.judgeRequests.push(request);
      const receipt = await delegate.dispatchJudge(request);
      recordings.judgeReceipts.push(receipt);
      return receipt;
    },
    waitForTerminal: delegate.waitForTerminal?.bind(delegate),
  };
}
