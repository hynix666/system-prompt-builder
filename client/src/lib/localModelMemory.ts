import type { LocalProviderId } from "./promptBuilderTypes";

export const LOCAL_MODEL_MEMORY_KEY = "signal-ledger-last-local-models-v1";

export type LocalModelMemory = Record<LocalProviderId, string>;

const EMPTY_LOCAL_MODEL_MEMORY: LocalModelMemory = { ollama: "", lmstudio: "" };

export function parseLocalModelMemory(value: string | null): LocalModelMemory {
  try {
    const parsed = JSON.parse(value ?? "{}") as Partial<Record<LocalProviderId, unknown>>;
    return {
      ollama: typeof parsed.ollama === "string" ? parsed.ollama : "",
      lmstudio: typeof parsed.lmstudio === "string" ? parsed.lmstudio : "",
    };
  } catch {
    return { ...EMPTY_LOCAL_MODEL_MEMORY };
  }
}

export function rememberLocalModel(memory: LocalModelMemory, provider: LocalProviderId, model: string): LocalModelMemory {
  const normalizedModel = model.trim();
  if (!normalizedModel || memory[provider] === normalizedModel) return memory;
  return { ...memory, [provider]: normalizedModel };
}
