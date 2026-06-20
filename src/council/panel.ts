import type { ContextBundle, CouncilMode, FusionCouncilConfig, FusionModelSpec, ModelErrorType, ModelRunner, PanelMode, PanelResponse, PromptVerbosity } from "../types.js";
import { getReasoningEffortApplication } from "../modelSpec.js";
import { errorMessage } from "../utils/errors.js";
import { buildCandidateRepairPrompt, shouldAttemptCandidateRepair, validateCandidateOutput } from "./candidateValidation.js";
import { buildPanelPrompt } from "./prompts.js";
import { providerLabelForModel } from "../runners/modelRunner.js";
import { panelSessionTitle } from "../trace/runTrace.js";

export async function runPanel(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  modelSpecs: FusionModelSpec[];
  config: FusionCouncilConfig;
  modelRunner: ModelRunner;
  panelMode?: PanelMode;
  promptVerbosity?: PromptVerbosity;
  timeoutMs?: number;
  maxAttempts?: number;
  repairMaxAttempts?: number;
  repairTimeoutMs?: number;
  keepPanelSessions?: boolean;
}): Promise<PanelResponse[]> {
  const concurrency = Math.max(1, input.config.defaults.maxPanelConcurrency);
  const results: PanelResponse[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < input.modelSpecs.length) {
      const index = cursor;
      const modelSpec = input.modelSpecs[cursor++];
      results.push(await runOnePanel({ ...input, modelSpec, panelIndex: index }));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, input.modelSpecs.length) }, () => worker()));
  return results.sort((a, b) => input.modelSpecs.findIndex((spec) => spec.modelId === a.modelId) - input.modelSpecs.findIndex((spec) => spec.modelId === b.modelId));
}

async function runOnePanel(input: Parameters<typeof runPanel>[0] & { modelSpec: FusionModelSpec; panelIndex: number }): Promise<PanelResponse> {
  const modelId = input.modelSpec.modelId;
  const provider = providerLabelForModel(modelId, input.config, input.modelRunner);
  const identity = modelIdentity(modelId, input.config, input.modelRunner);
  const effortFields = {
    reasoningEffort: input.modelSpec.reasoningEffort,
    reasoningEffortApplied: effortApplication(input.modelSpec),
    rawModelSpec: input.modelSpec.raw,
  };
  const started = Date.now();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 1);
  let lastFailure: Omit<PanelResponse, "latencyMs"> | undefined;
  const prompt = buildPanelPrompt({
    task: input.task,
    mode: input.mode,
    context: input.context,
    panelMode: input.panelMode,
    promptVerbosity: input.promptVerbosity,
  });
  let sessionId: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? input.config.defaults.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const content = await input.modelRunner.generate(
        modelId,
        prompt,
        {
          signal: controller.signal,
          timeoutMs,
          sessionTitle: panelSessionTitle(input.panelIndex, modelId, "panel"),
          keepSession: input.keepPanelSessions,
          onSessionCreated: (id) => { sessionId = id; },
          reasoningEffort: input.modelSpec.reasoningEffort,
        },
      );
      if (input.panelMode === "candidate_build") {
        const validation = validateCandidateOutput(content);
        if (validation.status === "failed") {
          const repaired = shouldAttemptCandidateRepair(content, validation)
            ? await attemptCandidateRepair({
              input,
              initialContent: content,
              sessionTitle: panelSessionTitle(input.panelIndex, modelId, "panel"),
              onSessionCreated: (id) => { sessionId = id; },
            })
            : undefined;
          if (repaired) {
            return buildCandidateSuccessResponse({
              modelId,
              provider,
              content: repaired.content,
              started,
              attempt,
              prompt,
              sessionId,
              identity,
              effortFields,
              validation: repaired.validation,
              repairAttempted: true,
            });
          }
          lastFailure = {
            modelId,
            provider,
            success: false,
            error: `Candidate output failed validation${repaired === undefined && shouldAttemptCandidateRepair(content, validation) ? " after repair attempt" : ""}. Missing: ${validation.missingSections.join(", ") || "complete candidate implementation"}`,
            errorType: "validation",
            attempts: attempt,
            prompt,
            repairAttempted: shouldAttemptCandidateRepair(content, validation),
            candidateValidationPassed: false,
            candidateValidationStatus: validation.status,
            candidateValidationScore: validation.score,
            candidateValidationWarnings: validation.warnings,
            candidateValidationMissingItems: validation.missingSections,
            sessionId,
            ...identity,
            ...effortFields,
          };
          break;
        }
        return buildCandidateSuccessResponse({
          modelId,
          provider,
          content,
          started,
          attempt,
          prompt,
          sessionId,
          identity,
          effortFields,
          validation,
          repairAttempted: false,
        });
      }
      return {
        modelId,
        provider,
        success: true,
        content,
        latencyMs: Date.now() - started,
        attempts: attempt,
        prompt,
        sessionId,
        ...identity,
        ...effortFields,
      };
    } catch (error) {
      const failure = classifyModelError(error, controller.signal);
      lastFailure = {
        modelId,
        provider,
        success: false,
        error: failure.message,
        errorType: failure.type,
        attempts: attempt,
        prompt,
        sessionId,
        ...identity,
        ...effortFields,
      };
      if (attempt >= maxAttempts || !shouldRetry(failure.type)) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    ...(lastFailure ?? {
      modelId,
      provider,
      success: false,
      error: "unknown error",
      errorType: "unknown" as const,
      attempts: maxAttempts,
      prompt,
      sessionId,
      ...identity,
      ...effortFields,
    }),
    latencyMs: Date.now() - started,
  };
}

function buildCandidateSuccessResponse(input: {
  modelId: string;
  provider: string;
  content: string;
  started: number;
  attempt: number;
  prompt: string;
  sessionId?: string;
  identity: { providerID?: string; modelID?: string };
  effortFields: {
    reasoningEffort?: FusionModelSpec["reasoningEffort"];
    reasoningEffortApplied: ReturnType<typeof getReasoningEffortApplication>;
    rawModelSpec?: string;
  };
  validation: ReturnType<typeof validateCandidateOutput>;
  repairAttempted: boolean;
}): PanelResponse {
  return {
    modelId: input.modelId,
    provider: input.provider,
    success: true,
    content: input.content,
    latencyMs: Date.now() - input.started,
    attempts: input.attempt,
    prompt: input.prompt,
    repairAttempted: input.repairAttempted,
    candidateValidationPassed: input.validation.status === "passed",
    candidateValidationStatus: input.validation.status,
    candidateValidationScore: input.validation.score,
    candidateValidationWarnings: input.validation.warnings,
    candidateValidationMissingItems: input.validation.missingSections,
    sessionId: input.sessionId,
    ...input.identity,
    ...input.effortFields,
  };
}

function effortApplication(modelSpec: FusionModelSpec) {
  return getReasoningEffortApplication(modelSpec);
}

async function attemptCandidateRepair(input: {
  input: Parameters<typeof runPanel>[0] & { modelSpec: FusionModelSpec; panelIndex: number };
  initialContent: string;
  sessionTitle: string;
  onSessionCreated?: (sessionId: string) => void;
}): Promise<{ content: string; validation: ReturnType<typeof validateCandidateOutput> } | undefined> {
  const repairMaxAttempts = Math.max(1, input.input.repairMaxAttempts ?? 1);
  const repairTimeoutMs = input.input.repairTimeoutMs ?? input.input.timeoutMs ?? input.input.config.defaults.timeoutMs;

  for (let attempt = 1; attempt <= repairMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), repairTimeoutMs);
    try {
      const repairPrompt = buildCandidateRepairPrompt({ task: input.input.task, previousOutput: input.initialContent });
      const repairedContent = await input.input.modelRunner.generate(
        input.input.modelSpec.modelId,
        repairPrompt,
        {
          signal: controller.signal,
          timeoutMs: repairTimeoutMs,
          sessionTitle: `${input.sessionTitle} (repair)`,
          keepSession: input.input.keepPanelSessions,
          onSessionCreated: input.onSessionCreated,
          reasoningEffort: input.input.modelSpec.reasoningEffort,
        },
      );
      const validation = validateCandidateOutput(repairedContent);
      if (validation.status !== "failed") return { content: repairedContent, validation };
    } catch {
      // Try next repair attempt if configured.
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

function shouldRetry(type: ModelErrorType): boolean {
  return type !== "validation" && type !== "model_not_found";
}

function classifyModelError(error: unknown, signal?: AbortSignal): { type: ModelErrorType; message: string } {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (signal?.aborted || lower.includes("abort") || lower.includes("timeout") || lower.includes("timed out")) return { type: "timeout", message };
  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("429")) return { type: "rate_limit", message };
  if (lower.includes("providermodelnotfound") || lower.includes("model not found") || lower.includes("model does not exist") || lower.includes("not configured for direct provider")) return { type: "model_not_found", message };
  if (lower.includes("must use provider/model format") || lower.includes("invalid fusion council config") || lower.includes("candidate output failed validation")) return { type: "validation", message };
  if (lower.includes("returned no text") || lower.includes("empty response") || lower.includes("no text content")) return { type: "empty_response", message };
  if (lower.includes("failed to return a response") || lower.includes("provider") || lower.includes("unavailable")) return { type: "provider_error", message };
  return { type: "unknown", message };
}

function modelIdentity(modelId: string, config: FusionCouncilConfig, runner: ModelRunner): { providerID?: string; modelID?: string } {
  const slash = modelId.indexOf("/");
  if (slash > 0 && slash < modelId.length - 1) return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
  const directModel = config.models[modelId];
  if (directModel) return { providerID: directModel.provider, modelID: directModel.model };
  return runner.source === "opencode" ? { modelID: modelId } : { providerID: runner.source, modelID: modelId };
}
