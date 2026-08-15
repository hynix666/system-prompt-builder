import { describe, expect, it, vi } from "vitest";
import { assertLocalEndpoint, localCorsGuidance, localCorsSetupGuide, probeLocalServer, ProviderError } from "./promptBuilderTransport";

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
