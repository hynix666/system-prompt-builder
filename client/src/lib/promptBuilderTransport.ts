import type { LocalProviderConfig, LocalProviderId, ProviderResult } from "./promptBuilderTypes";

export class ProviderError extends Error {
  constructor(
    public readonly kind: "network" | "timeout" | "abort" | "http" | "parse" | "configuration",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const LOCAL_ONLY_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function assertLocalEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("configuration", "Enter a valid local server URL, such as http://localhost:11434/v1.");
  }
  if (!LOCAL_ONLY_HOSTS.has(url.hostname)) {
    throw new ProviderError("configuration", "Static mode permits only localhost endpoints. Hosted providers require a server-side adapter.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("configuration", "Local endpoint must use http or https.");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal, timeoutMs = 90_000) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new ProviderError("http", detail?.error?.message ?? detail?.message ?? `HTTP ${response.status}`, response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (externalSignal?.aborted) throw new ProviderError("abort", "Request cancelled.");
    if ((error as DOMException)?.name === "AbortError") throw new ProviderError("timeout", "The local model did not respond before the 90-second timeout.");
    throw new ProviderError("network", "Could not reach the local model. Check that it is running and its CORS policy permits this origin.");
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function callLocalOpenAICompatible(
  provider: LocalProviderId,
  cfg: LocalProviderConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const baseUrl = assertLocalEndpoint(cfg.baseUrl);
  if (!cfg.model.trim()) throw new ProviderError("configuration", "Choose or enter a local model name before running.");
  const response = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    signal,
  );
  const data = await response.json().catch(() => {
    throw new ProviderError("parse", "The local model returned a non-JSON response.");
  });
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new ProviderError("parse", "The local model response did not include choices[0].message.content.");
  }
  const usage = data?.usage;
  return {
    text,
    usage: usage
      ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
      : undefined,
    finishReason: data?.choices?.[0]?.finish_reason,
  };
}

export async function listLocalModels(provider: LocalProviderId, cfg: LocalProviderConfig, signal?: AbortSignal) {
  void provider;
  const baseUrl = assertLocalEndpoint(cfg.baseUrl);
  const response = await fetchWithTimeout(`${baseUrl}/models`, {}, signal, 12_000);
  const data = await response.json().catch(() => {
    throw new ProviderError("parse", "The local model server returned a non-JSON model list.");
  });
  return Array.isArray(data?.data)
    ? data.data.map((model: { id?: string }) => model.id).filter((model: unknown): model is string => typeof model === "string")
    : [];
}

export function formatProviderError(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  return error instanceof Error ? error.message : "Unexpected provider error.";
}
