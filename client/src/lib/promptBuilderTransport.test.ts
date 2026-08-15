import { describe, expect, it } from "vitest";
import { assertLocalEndpoint, ProviderError } from "./promptBuilderTransport";

describe("local provider endpoint policy", () => {
  it("accepts an explicitly local OpenAI-compatible endpoint", () => {
    expect(assertLocalEndpoint("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  it("keeps hosted endpoints out of the browser-local transport", () => {
    expect(() => assertLocalEndpoint("https://api.openai.com/v1")).toThrow(ProviderError);
    expect(() => assertLocalEndpoint("https://api.openai.com/v1")).toThrow("Hosted providers require a server-side adapter.");
  });
});
