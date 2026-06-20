export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type FusionModelSpec = {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  raw?: string;
};

export type ReasoningEffortApplication = "not_configured" | "unsupported";

export const MODEL_FORMAT_HELP =
  "Expected model format: provider/model or provider/model/effort.\nAllowed efforts: none, minimal, low, medium, high, xhigh.";

export const MODEL_REGISTRY_DISCLAIMER =
  "Model IDs are not registry-validated; confirm with /models if a model fails at runtime.";

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function validateModelId(modelId: string): void {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash >= modelId.length - 1) {
    throw new Error(`Invalid model ID "${modelId}": must be in provider/model format`);
  }
}

export function parseModelSpec(raw: string): FusionModelSpec {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Empty model entry. ${MODEL_FORMAT_HELP}`);
  }

  const segments = trimmed.split("/");
  if (segments.length === 2) {
    const [provider, model] = segments;
    if (!provider || !model) {
      throw new Error(`Invalid model "${raw}". ${MODEL_FORMAT_HELP}`);
    }
    const modelId = `${provider}/${model}`;
    validateModelId(modelId);
    return { modelId, raw: trimmed };
  }

  if (segments.length === 3) {
    const [provider, model, effort] = segments;
    if (!provider || !model || !effort) {
      throw new Error(`Invalid model "${raw}". ${MODEL_FORMAT_HELP}`);
    }
    if (!isReasoningEffort(effort)) {
      throw new Error(
        `Invalid reasoning effort "${effort}" in "${raw}". ${MODEL_FORMAT_HELP}`,
      );
    }
    const modelId = `${provider}/${model}`;
    validateModelId(modelId);
    return { modelId, reasoningEffort: effort, raw: trimmed };
  }

  throw new Error(`Invalid model "${raw}". ${MODEL_FORMAT_HELP}`);
}

export function toModelSpec(value: string | FusionModelSpec): FusionModelSpec {
  if (typeof value === "string") return parseModelSpec(value);
  return value;
}

export function normalizeModelSpecEntry(value: unknown): FusionModelSpec {
  if (typeof value === "string") {
    return { modelId: value };
  }
  if (value && typeof value === "object" && "modelId" in value && typeof value.modelId === "string") {
    const entry = value as FusionModelSpec;
    validateModelId(entry.modelId);
    if (entry.reasoningEffort && !isReasoningEffort(entry.reasoningEffort)) {
      throw new Error(`Invalid saved reasoning effort "${entry.reasoningEffort}". ${MODEL_FORMAT_HELP}`);
    }
    return {
      modelId: entry.modelId,
      reasoningEffort: entry.reasoningEffort,
      raw: entry.raw,
    };
  }
  throw new Error("Invalid saved model entry: expected string or { modelId, reasoningEffort? }");
}

export function formatModelSpecDisplay(spec: FusionModelSpec, index?: number): string {
  const effort = spec.reasoningEffort ? ` (effort: ${spec.reasoningEffort})` : "";
  const label = index !== undefined ? `${index}. ` : "";
  return `${label}${spec.modelId}${effort}`;
}

export function formatModelSpecExact(spec: FusionModelSpec): string {
  if (spec.raw) return spec.raw;
  return spec.reasoningEffort ? `${spec.modelId}/${spec.reasoningEffort}` : spec.modelId;
}

export function getSuspiciousModelWarning(spec: FusionModelSpec): string | undefined {
  const exact = formatModelSpecExact(spec);
  const lower = exact.toLowerCase();
  if (lower.startsWith("openai/qwen")) {
    return `Suspicious model ID: ${exact}. Did you mean opencode-go/${exact.slice("openai/".length)}?`;
  }
  if (lower.startsWith("openai/kimi")) {
    return `Suspicious model ID: ${exact}. Did you mean opencode-go/${exact.slice("openai/".length)}?`;
  }
  if (lower.startsWith("openai/minimax")) {
    return `Suspicious model ID: ${exact}. Did you mean opencode-go/${exact.slice("openai/".length)}?`;
  }
  return undefined;
}

export function formatModelSpecTraceLine(spec: FusionModelSpec, role: string, application?: ReasoningEffortApplication): string {
  const effort = spec.reasoningEffort ? ` (effort: ${spec.reasoningEffort})` : "";
  const applied = application === "unsupported" && spec.reasoningEffort
    ? " — configured effort not applied (unsupported by current OpenCode SDK session.prompt)"
    : "";
  return `${role}: ${spec.modelId}${effort}${applied}`;
}

export function getReasoningEffortApplication(spec: FusionModelSpec): ReasoningEffortApplication {
  return spec.reasoningEffort ? "unsupported" : "not_configured";
}
