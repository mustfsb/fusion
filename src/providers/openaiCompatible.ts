import type { ProviderAdapter } from "./types.js";

export const openAICompatibleProvider: ProviderAdapter = {
  async generate(request) {
    const baseUrl = (request.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI-compatible provider failed with HTTP ${response.status}: ${await response.text()}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI-compatible provider returned no message content.");
    return content;
  },
};
