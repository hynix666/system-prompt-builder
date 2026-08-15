import { describe, expect, it } from "vitest";
import { assertLocalEndpoint, ProviderError } from "./promptBuilderTransport";

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
});
