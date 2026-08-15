import { describe, expect, it } from "vitest";
import { buildLocalDiagnosticSnapshot, redactLocalEndpoint, serializeLocalDiagnostics } from "./localDiagnostics";

const recovery = [{ id: "show-reload-steps", label: "SHOW RELOAD STEPS", detail: "Load the model." }];

describe("local diagnostics", () => {
  it("redacts credentials and query strings while retaining a useful local endpoint", () => {
    expect(redactLocalEndpoint("http://user:secret@localhost:11434/v1?token=never-export")).toBe("http://localhost:11434/v1");
  });

  it("exports support state without prompt content or raw provider payloads", () => {
    const snapshot = buildLocalDiagnosticSnapshot({
      provider: "lmstudio",
      endpoint: "localhost:1234/v1?prompt=secret",
      model: "qwen-local",
      health: { status: "unavailable", endpoint: "http://localhost:1234/v1", latencyMs: 42, detail: "model unloaded\ncheck again", errorKind: "provider" },
      recovery,
      modelOptionsCount: 2,
      modelNotice: "retry this model",
      retryAttempt: 1,
    });
    const serialized = serializeLocalDiagnostics({
      provider: "lmstudio",
      endpoint: "localhost:1234/v1?prompt=secret",
      model: "qwen-local",
      health: { status: "unavailable", endpoint: "http://localhost:1234/v1", latencyMs: 42, detail: "model unloaded\ncheck again", errorKind: "provider" },
      recovery,
      modelOptionsCount: 2,
      modelNotice: "retry this model",
      retryAttempt: 1,
    });

    expect(snapshot.endpoint).toBe("http://localhost:1234/v1");
    expect(snapshot.health?.detail).toBe("model unloaded check again");
    expect(serialized).toContain('"promptContent": "excluded"');
    expect(serialized).not.toContain("prompt=secret");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("system prompt");
  });
});
