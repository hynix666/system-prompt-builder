import type { LocalRecoveryAction, LocalServerHealth } from "./promptBuilderTransport";
import type { LocalProviderId } from "./promptBuilderTypes";

export type LocalDiagnosticSnapshot = {
  provider: LocalProviderId;
  endpoint: string;
  model: string;
  health: LocalServerHealth | null;
  recovery: LocalRecoveryAction[];
  modelOptionsCount: number;
  modelNotice: string;
  retryAttempt: number;
};

function sanitize(value: string | undefined, fallback = "") {
  if (!value) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 360);
}

export function redactLocalEndpoint(value: string) {
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`;
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/{2,}/g, "/")}`;
  } catch {
    return "<invalid-local-endpoint>";
  }
}

export function buildLocalDiagnosticSnapshot(snapshot: LocalDiagnosticSnapshot) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: snapshot.provider,
    endpoint: redactLocalEndpoint(snapshot.endpoint),
    model: snapshot.model.trim() || "<not-selected>",
    health: snapshot.health
      ? {
          status: snapshot.health.status,
          modelCount: snapshot.health.modelCount ?? null,
          latencyMs: snapshot.health.latencyMs ?? null,
          errorKind: snapshot.health.errorKind ?? null,
          detail: sanitize(snapshot.health.detail),
          telemetry: snapshot.health.telemetry
            ? {
                source: snapshot.health.telemetry.source,
                loadedModels: snapshot.health.telemetry.models.map((model) => ({
                  id: sanitize(model.id, "<unknown-model>"),
                  memoryBytes: model.memoryBytes ?? null,
                  gpuMemoryBytes: model.gpuMemoryBytes ?? null,
                  gpuOffload: model.gpuOffload ?? null,
                  quantization: sanitize(model.quantization) || null,
                })),
                note: sanitize(snapshot.health.telemetry.note) || null,
              }
            : null,
        }
      : null,
    recoveryActions: snapshot.recovery.map(({ id, label }) => ({ id, label })),
    modelOptionsCount: snapshot.modelOptionsCount,
    modelNotice: sanitize(snapshot.modelNotice) || null,
    retryAttempt: snapshot.retryAttempt,
    redaction: {
      promptContent: "excluded",
      credentials: "excluded",
      queryStrings: "excluded",
      rawUpstreamPayloads: "excluded",
    },
  };
}

export function serializeLocalDiagnostics(snapshot: LocalDiagnosticSnapshot) {
  return JSON.stringify(buildLocalDiagnosticSnapshot(snapshot), null, 2);
}
