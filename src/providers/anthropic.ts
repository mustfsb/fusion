import type { ProviderAdapter } from "./types.js";

export const anthropicProvider: ProviderAdapter = {
  async generate(request) {
    const baseUrl = (request.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    if (!response.ok) throw new Error(`Anthropic provider failed with HTTP ${response.status}: ${await response.text()}`);
    const json = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const content = json.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    if (!content) throw new Error("Anthropic provider returned no text content.");
    return content;
  },
};
