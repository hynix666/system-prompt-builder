import type { LocalProviderConfig, LocalProviderId, ProviderResult } from "./promptBuilderTypes";

export const LOCAL_PROVIDER_PRESETS: Record<LocalProviderId, LocalProviderConfig> = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "" },
};

export class ProviderError extends Error {
  constructor(
    public readonly kind: "network" | "timeout" | "abort" | "http" | "parse" | "configuration" | "provider",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type LocalServerHealth = {
  status: "healthy" | "unavailable";
  endpoint: string;
  modelCount?: number;
  latencyMs?: number;
  telemetry?: LocalRuntimeTelemetry;
  detail: string;
  errorKind?: ProviderError["kind"];
};

export type LocalRuntimeModel = {
  id: string;
  memoryBytes?: number;
  gpuMemoryBytes?: number;
  gpuOffload?: boolean;
  quantization?: string;
};

export type LocalRuntimeTelemetry = {
  source: "ollama-ps" | "lmstudio-v0-models";
  models: LocalRuntimeModel[];
  note?: string;
};

export type LocalCorsSetupGuide = {
  title: string;
  steps: string[];
  command: string;
  note: string;
  docsUrl: string;
};

function normalizeLocalInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const ipv4 = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

export function assertLocalEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(normalizeLocalInput(value));
  } catch {
    throw new ProviderError("configuration", "Enter a valid local server URL, such as http://localhost:11434/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("configuration", "Local endpoint must use http or https.");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new ProviderError("configuration", "Static mode permits only localhost endpoints. Hosted providers require a server-side adapter.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError("configuration", "Local endpoint must not include credentials, query parameters, or fragments.");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal, timeoutMs = 90_000) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
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
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

function asNonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function getLocalRuntimeTelemetry(provider: LocalProviderId, baseUrl: string, signal?: AbortSignal): Promise<LocalRuntimeTelemetry | undefined> {
  const serverRoot = new URL(baseUrl).origin;
  try {
    if (provider === "ollama") {
      const response = await fetchWithTimeout(`${serverRoot}/api/ps`, {}, signal, 4_000);
      const data = await response.json().catch(() => {
        throw new ProviderError("parse", "The Ollama runtime endpoint returned non-JSON data.");
      });
      const models = Array.isArray(data?.models) ? data.models : [];
      return {
        source: "ollama-ps",
        models: models.flatMap((model: { name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown; details?: { quantization_level?: unknown } }) => {
          const id = typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "";
          return id ? [{ id, memoryBytes: asNonNegativeNumber(model.size), gpuMemoryBytes: asNonNegativeNumber(model.size_vram), quantization: typeof model.details?.quantization_level === "string" ? model.details.quantization_level : undefined }] : [];
        }),
      };
    }

    const response = await fetchWithTimeout(`${serverRoot}/api/v0/models`, {}, signal, 4_000);
    const data = await response.json().catch(() => {
      throw new ProviderError("parse", "The LM Studio telemetry endpoint returned non-JSON data.");
    });
    const models = Array.isArray(data?.data) ? data.data : [];
    const loadedModels = models.filter((model: { state?: unknown }) => model.state === "loaded");
    return {
      source: "lmstudio-v0-models",
      models: loadedModels.flatMap((model: { id?: unknown; size?: unknown; size_vram?: unknown; gpu_memory_bytes?: unknown; offload_kv_cache_to_gpu?: unknown; quantization?: unknown }) => typeof model.id === "string" ? [{ id: model.id, memoryBytes: asNonNegativeNumber(model.size), gpuMemoryBytes: asNonNegativeNumber(model.size_vram) ?? asNonNegativeNumber(model.gpu_memory_bytes), gpuOffload: typeof model.offload_kv_cache_to_gpu === "boolean" ? model.offload_kv_cache_to_gpu : undefined, quantization: typeof model.quantization === "string" ? model.quantization : undefined }] : []),
      note: loadedModels.length ? "LM Studio reported loaded model state. Memory and GPU fields appear only when this local API returns them." : "LM Studio did not report a loaded model through its local REST endpoint.",
    };
  } catch {
    return undefined;
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
  const data: unknown = await response.json().catch(() => {
    throw new ProviderError("parse", "The local model returned a non-JSON response.");
  });
  return normalizeLocalCompletion(data);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    const entry = asRecord(part);
    if (!entry || (entry.type !== "text" && entry.type !== "output_text") || typeof entry.text !== "string") return [];
    return entry.text.trim() ? [entry.text] : [];
  });
  return parts.length ? parts.join("") : undefined;
}

function asTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedProviderMessage(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 360) : undefined;
}

function localApiError(payload: Record<string, unknown>) {
  const error = payload.error;
  const structuredError = asRecord(error);
  const message = boundedProviderMessage(error)
    ?? boundedProviderMessage(structuredError?.message)
    ?? boundedProviderMessage(structuredError?.detail)
    ?? boundedProviderMessage(payload.detail);
  const code = boundedProviderMessage(structuredError?.code) ?? boundedProviderMessage(structuredError?.type);
  if (error === undefined && !message) return undefined;
  const detail = message ?? code ?? "The local server returned an error without a message.";
  return `Local server error${code && message ? ` [${code}]` : ""}: ${detail} Check that the selected model is loaded and that the endpoint matches this provider.`;
}

export function normalizeLocalCompletion(data: unknown): ProviderResult {
  const payload = asRecord(data);
  if (!payload) throw new ProviderError("parse", "The local model returned a JSON value that was not an object.");
  const providerError = localApiError(payload);
  if (providerError) throw new ProviderError("provider", providerError);

  const firstChoice = Array.isArray(payload.choices) ? asRecord(payload.choices[0]) : null;
  const choiceMessage = asRecord(firstChoice?.message);
  const nativeMessage = asRecord(payload.message);
  const responseOutput = Array.isArray(payload.output)
    ? payload.output.flatMap((entry) => textFromContent(asRecord(entry)?.content)).join("")
    : undefined;
  const text = textFromContent(choiceMessage?.content)
    ?? textFromContent(firstChoice?.text)
    ?? textFromContent(nativeMessage?.content)
    ?? textFromContent(payload.response)
    ?? textFromContent(payload.output_text)
    ?? (responseOutput?.trim() ? responseOutput : undefined);

  if (!text) {
    const receivedKeys = Object.keys(payload).slice(0, 6).join(", ") || "none";
    throw new ProviderError("parse", `The local model returned no supported generated text (received keys: ${receivedKeys}). Use an OpenAI-compatible /v1 endpoint, or verify that the server returns a completed chat response rather than tools-only or streaming data.`);
  }

  const usage = asRecord(payload.usage);
  const inputTokens = asTokenCount(usage?.prompt_tokens) ?? asTokenCount(usage?.input_tokens) ?? asTokenCount(payload.prompt_eval_count);
  const outputTokens = asTokenCount(usage?.completion_tokens) ?? asTokenCount(usage?.output_tokens) ?? asTokenCount(payload.eval_count);
  const totalTokens = asTokenCount(usage?.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return {
    text,
    usage: inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined ? { inputTokens, outputTokens, totalTokens } : undefined,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : typeof payload.done_reason === "string" ? payload.done_reason : typeof payload.status === "string" ? payload.status : undefined,
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

export async function probeLocalServer(provider: LocalProviderId, cfg: LocalProviderConfig, signal?: AbortSignal): Promise<LocalServerHealth> {
  const baseUrl = assertLocalEndpoint(cfg.baseUrl);
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  try {
    const response = await fetchWithTimeout(`${baseUrl}/models`, {}, signal, 8_000);
    const data = await response.json().catch(() => ({}));
    const modelCount = Array.isArray(data?.data) ? data.data.length : undefined;
    const latencyMs = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt));
    const telemetry = await getLocalRuntimeTelemetry(provider, baseUrl, signal);
    return { status: "healthy", endpoint: baseUrl, modelCount, latencyMs, telemetry, detail: modelCount === undefined ? "Local endpoint responded." : `${modelCount} local model${modelCount === 1 ? "" : "s"} reported.` };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("network", "Could not reach the local model.");
    const latencyMs = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt));
    return { status: "unavailable", endpoint: baseUrl, latencyMs, detail: providerError.message, errorKind: providerError.kind };
  }
}

export function localCorsGuidance(provider: LocalProviderId) {
  if (provider === "ollama") return "The browser could not reach Ollama. Confirm `ollama serve` is running and allow this app origin through Ollama's OLLAMA_ORIGINS setting before restarting Ollama.";
  return "The browser could not reach LM Studio. Confirm the local server is started, then add this app origin to the server's CORS allowed origins in LM Studio before retrying.";
}

export function localCorsSetupGuide(provider: LocalProviderId, origin: string): LocalCorsSetupGuide {
  if (provider === "ollama") {
    return {
      title: "Ollama browser access",
      steps: ["Keep Ollama bound to localhost.", `Allow only ${origin} through OLLAMA_ORIGINS.`, "Restart Ollama, then check this server again."],
      command: `OLLAMA_ORIGINS="${origin}" ollama serve`,
      note: "On desktop installations, set OLLAMA_ORIGINS as an environment variable and restart the Ollama app. Avoid wildcard origins.",
      docsUrl: "https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama",
    };
  }
  return {
    title: "LM Studio browser access",
    steps: ["Start the Local Server from the Developer tab.", "Enable CORS in Server Settings, or start the CLI server with the command below.", "Keep network serving off unless you deliberately need it."],
    command: "lms server start --cors",
    note: "CORS permits browser access. Keep the server on 127.0.0.1 and enable authentication if you ever expose it beyond localhost.",
    docsUrl: "https://lmstudio.ai/docs/cli/serve/server-start",
  };
}

export function formatProviderError(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  return error instanceof Error ? error.message : "Unexpected provider error.";
}
