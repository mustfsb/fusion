import type { ProviderAdapter } from "./types.js";

export const googleProvider: ProviderAdapter = {
  async generate(request) {
    const baseUrl = (request.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
        },
      }),
    });

    if (!response.ok) throw new Error(`Google provider failed with HTTP ${response.status}: ${await response.text()}`);
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim();
    if (!content) throw new Error("Google provider returned no text content.");
    return content;
  },
};
