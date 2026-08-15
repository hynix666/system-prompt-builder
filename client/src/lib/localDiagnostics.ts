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

export function redactLocalEndpoint(value: string) {
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`;
    const url = new URL(candidate);
    return url.origin;
  } catch {
    return "<invalid-local-endpoint>";
  }
}

function diagnosticHealthCategory(health: LocalServerHealth) {
  if (health.status === "healthy") return "healthy";
  if (health.errorKind === "provider") return "provider-reported-error";
  if (health.errorKind === "network") return "network-unreachable";
  if (health.errorKind === "timeout") return "request-timeout";
  if (health.errorKind === "configuration") return "configuration-error";
  if (health.errorKind === "http") return "http-error";
  if (health.errorKind === "parse") return "unsupported-response";
  if (health.errorKind === "abort") return "request-cancelled";
  return "local-server-unavailable";
}

export function buildLocalDiagnosticSnapshot(snapshot: LocalDiagnosticSnapshot) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: snapshot.provider,
    endpoint: redactLocalEndpoint(snapshot.endpoint),
    modelConfigured: Boolean(snapshot.model.trim()),
    health: snapshot.health
      ? {
          status: snapshot.health.status,
          category: diagnosticHealthCategory(snapshot.health),
          modelCount: snapshot.health.modelCount ?? null,
          latencyMs: snapshot.health.latencyMs ?? null,
          errorKind: snapshot.health.errorKind ?? null,
          telemetry: snapshot.health.telemetry
            ? {
                source: snapshot.health.telemetry.source,
                loadedModelCount: snapshot.health.telemetry.models.length,
                resourceReports: snapshot.health.telemetry.models.map((model) => ({
                  memoryBytes: model.memoryBytes ?? null,
                  gpuMemoryBytes: model.gpuMemoryBytes ?? null,
                  gpuOffload: model.gpuOffload ?? null,
                })),
              }
            : null,
        }
      : null,
    recoveryActions: snapshot.recovery.map(({ id, label }) => ({ id, label })),
    modelOptionsCount: snapshot.modelOptionsCount,
    modelNoticePresent: Boolean(snapshot.modelNotice),
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
