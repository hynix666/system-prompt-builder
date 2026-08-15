import { describe, expect, it, vi } from "vitest";
import { createHostedProviderGateway, HostedProviderError } from "./hostedProviders";

const request = { model: "gpt-4.1-mini", system: "System instruction", user: "User instruction", temperature: 0.2, userId: 9 };

describe("hosted provider gateway", () => {
  it("exposes only server-configured providers and their allowlisted models", () => {
    const gateway = createHostedProviderGateway({ OPENAI_API_KEY: "server-key", OPENAI_MODELS: "gpt-4.1-mini,gpt-4.1" }, vi.fn());
    const capabilities = gateway.capabilities();
    expect(capabilities.find((provider) => provider.id === "openai")).toMatchObject({ available: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    expect(capabilities.find((provider) => provider.id === "anthropic")?.available).toBe(false);
  });

  it("normalizes an OpenAI response without accepting a browser-supplied endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: "Normalized stage output", usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }, status: "completed" }), { status: 200 }));
    const gateway = createHostedProviderGateway({ OPENAI_API_KEY: "server-key" }, fetchMock);
    await expect(gateway.generate({ provider: "openai", ...request })).resolves.toEqual({ text: "Normalized stage output", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, finishReason: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-key" }) }));
  });

  it("rejects models outside the server allowlist before any provider call", async () => {
    const fetchMock = vi.fn();
    const gateway = createHostedProviderGateway({ OPENAI_API_KEY: "server-key" }, fetchMock);
    await expect(gateway.generate({ provider: "openai", ...request, model: "unapproved-model" })).rejects.toMatchObject({ kind: "configuration" } satisfies Partial<HostedProviderError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses provider-specific Anthropic and Gemini response parsers", async () => {
    const anthropicFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "Claude result" }], usage: { input_tokens: 3, output_tokens: 5 }, stop_reason: "end_turn" }), { status: 200 }));
    const anthropic = createHostedProviderGateway({ ANTHROPIC_API_KEY: "anthropic-key" }, anthropicFetch);
    await expect(anthropic.generate({ provider: "anthropic", ...request, model: "claude-sonnet-4-5" })).resolves.toMatchObject({ text: "Claude result", finishReason: "end_turn" });

    const geminiFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Gemini result" }] }], usage: { total_input_tokens: 4, total_output_tokens: 6, total_tokens: 10 } }), { status: 200 }));
    const gemini = createHostedProviderGateway({ GEMINI_API_KEY: "gemini-key" }, geminiFetch);
    await expect(gemini.generate({ provider: "gemini", ...request, model: "gemini-3.6-flash" })).resolves.toMatchObject({ text: "Gemini result", usage: { totalTokens: 10 }, finishReason: "completed" });
    expect(geminiFetch).toHaveBeenCalledWith("https://generativelanguage.googleapis.com/v1beta/interactions", expect.objectContaining({ body: expect.stringContaining('"store":false') }));
  });
});
