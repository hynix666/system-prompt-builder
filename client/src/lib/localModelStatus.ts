import type { LocalServerHealth } from "./promptBuilderTransport";

export type LocalModelLoadStatus = {
  tone: "loaded" | "unloaded" | "unknown" | "unavailable";
  label: string;
  detail: string;
};

function normalized(value: string) {
  return value.trim().toLowerCase();
}

export function localModelLoadStatus(health: LocalServerHealth | null, selectedModel: string): LocalModelLoadStatus {
  if (!health) return { tone: "unknown", label: "LOAD STATUS UNKNOWN", detail: "Check the local server to verify the selected model state." };
  if (health.status === "unavailable" && health.errorKind === "provider" && /model_not_loaded|no model (?:is )?loaded|model .*not loaded|not loaded in memory/i.test(health.detail)) {
    return { tone: "unloaded", label: "MODEL UNLOADED", detail: health.detail };
  }
  if (health.status === "unavailable") return { tone: "unavailable", label: "LOCAL SERVER UNAVAILABLE", detail: health.detail };
  const selected = normalized(selectedModel);
  const loadedModels = health.telemetry?.models ?? [];
  if (!health.telemetry) return { tone: "unknown", label: "LOAD STATUS UNKNOWN", detail: "The local API did not report loaded-model state." };
  if (!loadedModels.length) return { tone: "unloaded", label: "MODEL UNLOADED", detail: health.telemetry.note ?? "The local API reported no loaded model." };
  if (!selected) return { tone: "unknown", label: "LOAD STATUS UNKNOWN", detail: "Choose a model to compare with the local runtime status." };
  if (loadedModels.some((model) => normalized(model.id) === selected)) return { tone: "loaded", label: "MODEL LOADED", detail: `${selectedModel} is reported in local runtime telemetry.` };
  return { tone: "unloaded", label: "MODEL UNLOADED", detail: `${selectedModel} is not reported as loaded by the local runtime.` };
}
