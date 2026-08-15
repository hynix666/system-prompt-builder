import { describe, expect, it } from "vitest";
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
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "local-a" }, { id: "local-b" }] }), { status: 200 });
    await expect(probeLocalServer("ollama", { baseUrl: "localhost:11434/v1", model: "" })).resolves.toMatchObject({ status: "healthy", modelCount: 2, latencyMs: expect.any(Number) });
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
