import type { PluginInput } from "@opencode-ai/plugin";
import type { ModelRunner } from "../types.js";
import { FusionCouncilError } from "../utils/errors.js";
import { parseOpenCodeModelId } from "./modelRunner.js";

type OpenCodeClient = PluginInput["client"];

const disabledMutationTools = {
  write: false,
  edit: false,
  bash: false,
  patch: false,
  task: false,
};

/**
 * Verified against @opencode-ai/sdk@1.17.4 SessionPromptData.body.model:
 * only { providerID, modelID } are supported. No reasoningEffort field exists.
 */
export const OPENCODE_SDK_SUPPORTS_REASONING_EFFORT = false;

export function createOpenCodeModelRunner(input: { client: OpenCodeClient; directory: string; agent?: string }): ModelRunner {
  return {
    source: "opencode",
    async generate(modelId, prompt, options) {
      const model = parseOpenCodeModelId(modelId);
      if (options.reasoningEffort && !OPENCODE_SDK_SUPPORTS_REASONING_EFFORT) {
        // Effort is preserved in config/trace only until OpenCode SDK exposes a typed option.
      }
      const session = await input.client.session.create({
        query: { directory: input.directory },
        body: { title: options.sessionTitle ?? `Fusion Council: ${modelId}` },
      });
      if (session.error || !session.data) throw new FusionCouncilError(`Failed to create temporary OpenCode session for '${modelId}'.`);

      options.onSessionCreated?.(session.data.id);

      try {
        const response = await input.client.session.prompt({
          signal: options.signal,
          path: { id: session.data.id },
          query: { directory: input.directory },
          body: {
            agent: input.agent ?? "plan",
            model,
            tools: disabledMutationTools,
            parts: [{ type: "text", text: prompt }],
          },
        });
        if (response.error || !response.data) throw new FusionCouncilError(`OpenCode model '${modelId}' failed to return a response. providerID=${model.providerID}; modelID=${model.modelID}; provider error: ${formatOpenCodeError(response.error)}`);
        const text = response.data.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (!text) throw new FusionCouncilError(`OpenCode model '${modelId}' returned no text content. providerID=${model.providerID}; modelID=${model.modelID}; empty response.`);
        return text;
      } finally {
        if (!options.keepSession) {
          await input.client.session.delete({ path: { id: session.data.id }, query: { directory: input.directory } }).catch(() => undefined);
        }
      }
    },
  };
}

function formatOpenCodeError(error: unknown): string {
  if (!error) return "unknown";
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
