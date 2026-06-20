import type { ModelClient, ModelConfig } from "../types.js";
import { FusionCouncilError } from "../utils/errors.js";
import { anthropicProvider } from "./anthropic.js";
import { googleProvider } from "./google.js";
import { openAICompatibleProvider } from "./openaiCompatible.js";
import type { ProviderAdapter } from "./types.js";

const adapters: Record<ModelConfig["provider"], ProviderAdapter> = {
  "openai-compatible": openAICompatibleProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

export function createModelClient(model: ModelConfig): ModelClient {
  return {
    async generate(prompt, options) {
      const apiKey = process.env[model.apiKeyEnv];
      if (!apiKey) throw new FusionCouncilError(`Missing API key environment variable ${model.apiKeyEnv}.`);
      return adapters[model.provider].generate({
        prompt,
        model: model.model,
        apiKey,
        baseUrl: model.baseUrl,
        temperature: options.temperature ?? model.temperature,
        maxTokens: options.maxTokens ?? model.maxTokens,
        signal: options.signal,
      });
    },
  };
}

export { anthropicProvider, googleProvider, openAICompatibleProvider };
