import type { FusionCouncilConfig, ModelClient, ModelConfig, ModelRunner, ModelSource } from "../types.js";
import { getDefaultFusionConfig } from "../config.js";
import { createModelClient } from "../providers/index.js";
import { FusionCouncilError } from "../utils/errors.js";

export function parseOpenCodeModelId(modelId: string): { providerID: string; modelID: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new FusionCouncilError(`Model ID '${modelId}' must use provider/model format, for example openai/gpt-5.5.`);
  }
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

export function providerLabelForModel(modelId: string, config: FusionCouncilConfig, runner: ModelRunner): string {
  if (runner.source === "opencode") return parseOpenCodeModelId(modelId).providerID;
  return config.models[modelId]?.provider ?? parseProviderPrefix(modelId) ?? runner.source;
}

export function createDirectModelRunner(
  config: FusionCouncilConfig = getDefaultFusionConfig(),
  modelClientFactory?: (modelId: string, model: ModelConfig) => ModelClient,
): ModelRunner {
  return {
    source: "direct",
    async generate(modelId, prompt, options) {
      const model = config.models[modelId];
      if (!model) {
        throw new FusionCouncilError(
          `Model '${modelId}' is not configured for direct provider mode. Add it to fusion-council.config.jsonc under models, or use modelSource 'opencode' inside OpenCode.`,
        );
      }
      const client = modelClientFactory?.(modelId, model) ?? createModelClient(model);
      return client.generate(prompt, { ...options, model });
    },
  };
}

export function resolveModelRunner(input: {
  modelSource?: ModelSource;
  config?: FusionCouncilConfig;
  opencodeRunner?: ModelRunner;
  directRunner?: ModelRunner;
  modelClientFactory?: (modelId: string, model: ModelConfig) => ModelClient;
}): ModelRunner {
  const source = input.modelSource ?? "auto";
  if (source === "opencode") {
    if (!input.opencodeRunner) throw new FusionCouncilError("OpenCode-native model runner is unavailable. This mode only works inside the OpenCode plugin with SDK client support.");
    return input.opencodeRunner;
  }
  if (source === "auto" && input.opencodeRunner) return input.opencodeRunner;
  return input.directRunner ?? createDirectModelRunner(input.config, input.modelClientFactory);
}

function parseProviderPrefix(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : undefined;
}
