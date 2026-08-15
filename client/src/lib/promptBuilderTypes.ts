export type ProviderId = "mock" | "ollama" | "lmstudio";

export type Stakes = "LOW" | "MEDIUM" | "HIGH" | "SAFETY-CRITICAL";

export type StageId =
  | "deconstruct"
  | "calibrate"
  | "compile"
  | "harden"
  | "critique"
  | "refine"
  | "lint"
  | "critic"
  | "preview";

export type StageStatus = "idle" | "running" | "done" | "error" | "skipped";
export type Verdict = "PASS" | "DEGRADED" | "GATE_FAIL" | "PENDING";

export interface PromptContext {
  spec: string;
  calibration: string;
  prompt: string;
  critique: string;
  lint: Verdict | "";
  critic: Verdict | "";
}

export interface StageOutput {
  text: string;
  status: StageStatus;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
}

export interface RevisionEntry {
  revision: number;
  prompt: string;
  summary: string;
  hash: string;
  stage: string;
  at: number;
  sources: ReferenceCitation[];
}

export interface ReferenceCitation {
  id: number;
  originalName: string;
  citation: string;
  tokenBudget: number;
  estimatedTokens: number;
}

export interface SavedPrompt {
  id: string;
  brief: string;
  prompt: string;
  stakes: Stakes;
  verdict: Verdict;
  provider: ProviderId;
  model: string;
  at: number;
  sources: ReferenceCitation[];
}

export interface LocalProviderConfig {
  model: string;
  baseUrl: string;
}

export interface ProviderResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
}
