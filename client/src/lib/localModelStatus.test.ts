import { describe, expect, it } from "vitest";
import { localModelLoadStatus } from "./localModelStatus";

describe("local model load status", () => {
  it("reports loaded only when runtime telemetry matches the selected model", () => {
    expect(localModelLoadStatus({ status: "healthy", endpoint: "http://localhost", detail: "ready", telemetry: { source: "ollama-ps", models: [{ id: "qwen" }] } }, "qwen").label).toBe("MODEL LOADED");
    expect(localModelLoadStatus({ status: "healthy", endpoint: "http://localhost", detail: "ready", telemetry: { source: "ollama-ps", models: [{ id: "other" }] } }, "qwen").label).toBe("MODEL UNLOADED");
  });

  it("does not infer loaded state when telemetry is absent or unavailable", () => {
    expect(localModelLoadStatus({ status: "healthy", endpoint: "http://localhost", detail: "ready" }, "qwen").label).toBe("LOAD STATUS UNKNOWN");
    expect(localModelLoadStatus({ status: "unavailable", endpoint: "http://localhost", detail: "offline", errorKind: "network" }, "qwen").label).toBe("LOCAL SERVER UNAVAILABLE");
    expect(localModelLoadStatus({ status: "unavailable", endpoint: "http://localhost", detail: "Local server error [model_not_loaded]: model not loaded in memory", errorKind: "provider" }, "qwen").label).toBe("MODEL UNLOADED");
  });
});
