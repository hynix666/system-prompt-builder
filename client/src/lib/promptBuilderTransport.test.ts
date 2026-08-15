import { describe, expect, it, vi } from "vitest";
import { assertLocalEndpoint, localCorsGuidance, localCorsSetupGuide, localRecoveryActions, normalizeLocalCompletion, probeLocalServer, ProviderError } from "./promptBuilderTransport";

describe("local provider endpoint policy", () => {
  it("accepts an explicitly local OpenAI-compatible endpoint", () => {
    expect(assertLocalEndpoint("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  it("normalizes common bare local addresses used by Ollama and LM Studio", () => {
    expect(assertLocalEndpoint("localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(assertLocalEndpoint(" 127.0.0.1:1234/v1 ")).toBe("http://127.0.0.1:1234/v1");
    expect(assertLocalEndpoint("http://127.10.20.30:1234/v1")).toBe("http://127.10.20.30:1234/v1");
  });

  it("keeps hosted endpoints out of the browser-local transport", () => {
    expect(() => assertLocalEndpoint("https://api.openai.com/v1")).toThrow(ProviderError);
    expect(() => assertLocalEndpoint("https://api.openai.com/v1")).toThrow("Hosted providers require a server-side adapter.");
  });

  it("rejects local-looking inputs that include an unsafe URL component", () => {
    expect(() => assertLocalEndpoint("http://user:pass@localhost:11434/v1")).toThrow("must not include credentials");
    expect(() => assertLocalEndpoint("http://localhost:11434/v1?target=remote")).toThrow("must not include credentials");
  });

  it("probes a local model endpoint before discovery and reports its model count", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "local-a" }, { id: "local-b" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "local-a", size: 5_137_025_024, size_vram: 3_221_225_472, details: { quantization_level: "Q4_0" } }] }), { status: 200 }));
    await expect(probeLocalServer("ollama", { baseUrl: "localhost:11434/v1", model: "" })).resolves.toMatchObject({ status: "healthy", modelCount: 2, latencyMs: expect.any(Number), telemetry: { source: "ollama-ps", models: [{ id: "local-a", memoryBytes: 5_137_025_024, gpuMemoryBytes: 3_221_225_472, quantization: "Q4_0" }] } });
    globalThis.fetch = originalFetch;
  });

  it("keeps LM Studio loaded-model state when its REST endpoint does not expose memory or GPU bytes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "local-a" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "lm-loaded", state: "loaded", quantization: "Q4_K_M" }, { id: "lm-idle", state: "not-loaded" }] }), { status: 200 }));
    await expect(probeLocalServer("lmstudio", { baseUrl: "localhost:1234/v1", model: "" })).resolves.toMatchObject({ status: "healthy", telemetry: { source: "lmstudio-v0-models", models: [{ id: "lm-loaded", quantization: "Q4_K_M" }] } });
    globalThis.fetch = originalFetch;
  });

  it("returns a safe CORS-oriented failure state when a local endpoint cannot be reached", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await expect(probeLocalServer("lmstudio", { baseUrl: "localhost:1234/v1", model: "" })).resolves.toMatchObject({ status: "unavailable", errorKind: "network" });
    expect(localCorsGuidance("lmstudio")).toContain("CORS");
    expect(localCorsSetupGuide("lmstudio", "https://promptbuild.example").command).toBe("lms server start --cors");
    expect(localCorsSetupGuide("ollama", "https://promptbuild.example").command).toContain("OLLAMA_ORIGINS=\"https://promptbuild.example\"");
    globalThis.fetch = originalFetch;
  });
});

describe("local completion response normalization", () => {
  it("accepts OpenAI-compatible string and text-part completion content", () => {
    expect(normalizeLocalCompletion({ choices: [{ message: { content: "Standard completion" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })).toEqual({ text: "Standard completion", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, finishReason: "stop" });
    expect(normalizeLocalCompletion({ choices: [{ message: { content: [{ type: "text", text: "Part one" }, { type: "output_text", text: " and two" }] } }] })).toMatchObject({ text: "Part one and two" });
  });

  it("accepts documented native Ollama and compatible fallback fields", () => {
    expect(normalizeLocalCompletion({ message: { content: "Native chat" }, prompt_eval_count: 7, eval_count: 3, done_reason: "stop" })).toEqual({ text: "Native chat", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, finishReason: "stop" });
    expect(normalizeLocalCompletion({ response: "Native generation" })).toMatchObject({ text: "Native generation" });
    expect(normalizeLocalCompletion({ output_text: "Responses-style output" })).toMatchObject({ text: "Responses-style output" });
  });

  it("rejects tool-only or malformed payloads with an actionable parse error", () => {
    expect(() => normalizeLocalCompletion({ choices: [{ message: { tool_calls: [{ type: "function" }] } }] })).toThrow("no supported generated text");
    expect(() => normalizeLocalCompletion([])).toThrow("not an object");
  });

  it("surfaces a bounded local API error payload before attempting completion parsing", () => {
    try {
      normalizeLocalCompletion({ error: { message: "model qwen3:8b is not loaded", code: "model_not_loaded" } });
      throw new Error("Expected a provider error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind: "provider" });
      expect((error as Error).message).toContain("Local server error [model_not_loaded]: model qwen3:8b is not loaded");
      expect((error as Error).message).toContain("selected model is loaded");
    }
  });

  it("rejects non-standard custom JSON without treating arbitrary nested data as model output", () => {
    expect(() => normalizeLocalCompletion({ data: { result: "untrusted custom shape" }, metadata: { provider: "custom" } })).toThrow("received keys: data, metadata");
    try {
      normalizeLocalCompletion({ error: { message: "local issue\nwith control characters", code: "custom_failure" } });
      throw new Error("Expected a provider error");
    } catch (error) {
      expect((error as Error).message).toContain("local issue with control characters");
      expect((error as Error).message).not.toContain("\n");
    }
  });
});

describe("local recovery actions", () => {
  it("offers provider-safe reload guidance when a model is unloaded", () => {
    expect(localRecoveryActions("ollama", new ProviderError("provider", "Local server error [model_not_loaded]: model qwen is not loaded"))).toMatchObject([
      { id: "show-reload-steps", label: "SHOW RELOAD STEPS" },
      { id: "discover-models" },
    ]);
  });

  it("maps common model, CORS, and network failures to tailored actions", () => {
    expect(localRecoveryActions("lmstudio", new ProviderError("provider", "Local server error [model_not_found]: unknown model"))[0]?.id).toBe("discover-models");
    expect(localRecoveryActions("ollama", new ProviderError("network", "Could not reach the local model. Check CORS."))[0]?.id).toBe("open-cors-guide");
    expect(localRecoveryActions("lmstudio", new ProviderError("provider", "unauthorized local API request"))[0]?.id).toBe("review-auth");
  });
});
