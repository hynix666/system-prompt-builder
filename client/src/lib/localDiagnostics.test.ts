import { describe, expect, it } from "vitest";
import { buildLocalDiagnosticSnapshot, redactLocalEndpoint, serializeLocalDiagnostics } from "./localDiagnostics";

const recovery = [{ id: "show-reload-steps", label: "SHOW RELOAD STEPS", detail: "Load the model." }];

describe("local diagnostics", () => {
  it("redacts credentials, paths, and query strings while retaining a useful local origin", () => {
    expect(redactLocalEndpoint("http://user:secret@localhost:11434/private/prompt?token=never-export")).toBe("http://localhost:11434");
  });

  it("exports fixed support categories without prompt-like provider errors or UI notices", () => {
    const input = {
      provider: "lmstudio" as const,
      endpoint: "localhost:1234/private-prompt?prompt=secret",
      model: "qwen-local",
      health: { status: "unavailable" as const, endpoint: "http://localhost:1234/v1", latencyMs: 42, detail: "Provider echoed: SYSTEM PROMPT private user request", errorKind: "provider" as const },
      recovery,
      modelOptionsCount: 2,
      modelNotice: "Provider echoed: SYSTEM PROMPT private user request",
      retryAttempt: 1,
    };
    const snapshot = buildLocalDiagnosticSnapshot(input);
    const serialized = serializeLocalDiagnostics(input);

    expect(snapshot.endpoint).toBe("http://localhost:1234");
    expect(snapshot.health?.category).toBe("provider-reported-error");
    expect(serialized).toContain('"promptContent": "excluded"');
    expect(serialized).toContain('"modelNoticePresent": true');
    expect(serialized).not.toContain("prompt=secret");
    expect(serialized).not.toContain("private-prompt");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("SYSTEM PROMPT");
    expect(serialized).not.toContain("private user request");
  });
});
