export type ProviderRequest = {
  prompt: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type ProviderAdapter = {
  generate(request: ProviderRequest): Promise<string>;
};
