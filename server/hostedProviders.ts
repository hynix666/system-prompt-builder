export type HostedProviderId = "openai" | "anthropic" | "gemini" | "compatible";

export type HostedProviderResult = {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
};

export type HostedProviderCapability = {
  id: HostedProviderId;
  label: string;
  models: string[];
  available: boolean;
  reason?: string;
};

export class HostedProviderError extends Error {
  constructor(
    public readonly kind: "configuration" | "rate_limit" | "network" | "timeout" | "http" | "parse",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HostedProviderError";
  }
}

type ServerEnvironment = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type HostedRequest = { provider: HostedProviderId; model: string; system: string; user: string; temperature: number; userId: number };
type ProviderConfig = { label: string; apiKey: string; baseUrl: string; models: string[]; configured: boolean; reason?: string };

const DEFAULT_MODELS: Record<HostedProviderId, string[]> = {
  openai: ["gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-5"],
  gemini: ["gemini-2.5-flash"],
  compatible: [],
};
const REQUEST_WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 12;
const MAX_SYSTEM_CHARS = 48_000;
const MAX_USER_CHARS = 48_000;

function readModels(value: string | undefined, fallback: string[]) {
  const parsed = value?.split(",").map((model) => model.trim()).filter(Boolean) ?? [];
  return parsed.length ? Array.from(new Set(parsed)) : fallback;
}

function validCompatibleBaseUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function providerConfigs(env: ServerEnvironment): Record<HostedProviderId, ProviderConfig> {
  const compatibleBaseUrl = validCompatibleBaseUrl(env.COMPATIBLE_OPENAI_BASE_URL);
  const configs: Record<HostedProviderId, ProviderConfig> = {
    openai: { label: "OPENAI", apiKey: env.OPENAI_API_KEY?.trim() ?? "", baseUrl: "https://api.openai.com/v1", models: readModels(env.OPENAI_MODELS, DEFAULT_MODELS.openai), configured: false },
    anthropic: { label: "ANTHROPIC", apiKey: env.ANTHROPIC_API_KEY?.trim() ?? "", baseUrl: "https://api.anthropic.com/v1", models: readModels(env.ANTHROPIC_MODELS, DEFAULT_MODELS.anthropic), configured: false },
    gemini: { label: "GEMINI", apiKey: env.GEMINI_API_KEY?.trim() ?? "", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: readModels(env.GEMINI_MODELS, DEFAULT_MODELS.gemini), configured: false },
    compatible: { label: "COMPATIBLE", apiKey: env.COMPATIBLE_OPENAI_API_KEY?.trim() ?? "", baseUrl: compatibleBaseUrl, models: readModels(env.COMPATIBLE_OPENAI_MODELS, DEFAULT_MODELS.compatible), configured: false },
  };
  for (const [id, config] of Object.entries(configs) as Array<[HostedProviderId, ProviderConfig]>) {
    config.configured = Boolean(config.apiKey && config.baseUrl && config.models.length);
    if (!config.configured) {
      config.reason = id === "compatible" && !compatibleBaseUrl
        ? "A fixed compatible endpoint, key, and allowlisted model are required."
        : "This provider is not configured on the server.";
    }
  }
  return configs;
}

function extractOpenAIText(data: any) {
  const outputText = typeof data?.output_text === "string" ? data.output_text : "";
  if (outputText.trim()) return outputText;
  const message = data?.choices?.[0]?.message?.content;
  if (typeof message === "string" && message.trim()) return message;
  const nested = Array.isArray(data?.output) ? data.output.flatMap((item: any) => item?.content ?? []).filter((item: any) => item?.type === "output_text").map((item: any) => item.text).filter(Boolean).join("\n") : "";
  return nested;
}

function extractAnthropicText(data: any) {
  return Array.isArray(data?.content) ? data.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n") : "";
}

function extractGeminiText(data: any) {
  const parts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part: any) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n") : "";
}

async function responseJson(response: Response) {
  return response.json().catch(() => ({}));
}

async function callWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const data = await responseJson(response);
    if (!response.ok) {
      const message = data?.error?.message ?? data?.error?.status ?? data?.message ?? `Provider request failed with HTTP ${response.status}.`;
      const kind = response.status === 429 ? "rate_limit" : "http";
      throw new HostedProviderError(kind, kind === "rate_limit" ? "The hosted provider rate limit was reached. Please try again shortly." : `Hosted provider request failed: ${String(message).slice(0, 300)}`, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof HostedProviderError) throw error;
    if ((error as DOMException)?.name === "AbortError") throw new HostedProviderError("timeout", "The hosted provider did not respond before the 90-second timeout.");
    throw new HostedProviderError("network", "The hosted provider could not be reached. Please try again shortly.");
  } finally {
    clearTimeout(timer);
  }
}

export function createHostedProviderGateway(env: ServerEnvironment = process.env, fetchImpl: FetchLike = fetch) {
  const callsByUser = new Map<number, number[]>();

  const capabilities = (): HostedProviderCapability[] => Object.entries(providerConfigs(env)).map(([id, config]) => ({
    id: id as HostedProviderId,
    label: config.label,
    models: config.configured ? config.models : [],
    available: config.configured,
    reason: config.reason,
  }));

  const enforceRateLimit = (userId: number) => {
    const now = Date.now();
    const recent = (callsByUser.get(userId) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_WINDOW) throw new HostedProviderError("rate_limit", "Hosted generation is temporarily limited for this workspace. Please wait a minute and try again.");
    recent.push(now);
    callsByUser.set(userId, recent);
  };

  const generate = async (request: HostedRequest): Promise<HostedProviderResult> => {
    if (request.system.length > MAX_SYSTEM_CHARS || request.user.length > MAX_USER_CHARS) throw new HostedProviderError("configuration", "The hosted generation input exceeds the allowed size.");
    const config = providerConfigs(env)[request.provider];
    if (!config.configured) throw new HostedProviderError("configuration", config.reason ?? "This hosted provider is not configured on the server.");
    if (!config.models.includes(request.model)) throw new HostedProviderError("configuration", "This model is not approved for the selected hosted provider.");
    enforceRateLimit(request.userId);

    if (request.provider === "openai") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: request.model, input: [{ role: "system", content: request.system }, { role: "user", content: request.user }], temperature: request.temperature }) });
      const text = extractOpenAIText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "OpenAI returned no usable text output.");
      return { text, usage: data?.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, totalTokens: data.usage.total_tokens } : undefined, finishReason: data?.status };
    }
    if (request.provider === "compatible") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: request.model, temperature: request.temperature, messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }] }) });
      const text = extractOpenAIText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "The compatible provider returned no usable text output.");
      return { text, usage: data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : undefined, finishReason: data?.choices?.[0]?.finish_reason };
    }
    if (request.provider === "anthropic") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: request.model, system: request.system, messages: [{ role: "user", content: request.user }], max_tokens: 4096, temperature: request.temperature }) });
      const text = extractAnthropicText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "Anthropic returned no usable text output.");
      return { text, usage: data?.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) } : undefined, finishReason: data?.stop_reason };
    }
    const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: "user", parts: [{ text: request.user }] }], generationConfig: { temperature: request.temperature } }) });
    const text = extractGeminiText(data);
    if (!text.trim()) throw new HostedProviderError("parse", "Gemini returned no usable text output.");
    return { text, usage: data?.usageMetadata ? { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount, totalTokens: data.usageMetadata.totalTokenCount } : undefined, finishReason: data?.candidates?.[0]?.finishReason };
  };

  return { capabilities, generate };
}
