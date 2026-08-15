/**
 * Signal Ledger design reminder: a precise editorial workbench using warm paper,
 * ink, Ledger Blue proof marks, visible pipeline traceability, and semantic controls.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Clipboard,
  Download,
  FileJson,
  FileText,
  FlaskConical,
  History,
  LockKeyhole,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { formatLint, lintPrompt } from "@/lib/promptLint";
import { promptSummary, shortPromptHash, unifiedPromptDiff } from "@/lib/promptDiff";
import { formatProviderError, callLocalOpenAICompatible, listLocalModels } from "@/lib/promptBuilderTransport";
import { mockStageResponse, stageInstruction } from "@/lib/mockProvider";
import { appendReferenceCitations } from "@/lib/referenceCitations";
import { PromptDraftAudit } from "@/components/PromptDraftAudit";
import { PromptReferenceVault, type AttachedReferenceContext } from "@/components/PromptReferenceVault";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import type {
  LocalProviderConfig,
  LocalProviderId,
  HostedProviderId,
  ProviderId,
  PromptContext,
  RevisionEntry,
  SavedPrompt,
  StageId,
  StageOutput,
  StageStatus,
  Stakes,
  ReferenceCitation,
  Verdict,
} from "@/lib/promptBuilderTypes";

const PAPER = "#F7F2E8";
const INK = "#141A22";
const BLUE = "#175CFF";
const RED = "#B9382B";
const MOSS = "#277751";
const SAND = "#E8DEC9";
const DEFAULT_BRIEF =
  "A support assistant for a small indie video-game studio. Helps players troubleshoot bugs, explains confirmed features, stays friendly and a little playful, never promises unreleased features, and escalates refund requests to a human.";
const DEFAULT_TEST = "My game crashes every time I open the map. What do I do?";

type StageDefinition = {
  id: StageId;
  label: string;
  summary: string;
  kind: "build" | "verify" | "preview";
};

const STAGES: StageDefinition[] = [
  { id: "deconstruct", label: "Deconstruct", summary: "Extract purpose, edge cases, and intake", kind: "build" },
  { id: "calibrate", label: "Calibrate", summary: "Choose constrained operating posture", kind: "build" },
  { id: "compile", label: "Compile", summary: "Assemble a complete instruction set", kind: "build" },
  { id: "harden", label: "Harden", summary: "Bind guardrails to the real domain", kind: "build" },
  { id: "critique", label: "Critique", summary: "Surface material instruction defects", kind: "verify" },
  { id: "refine", label: "Refine", summary: "Resolve grounded critique findings", kind: "build" },
  { id: "lint", label: "Lint", summary: "Run deterministic local gates", kind: "verify" },
  { id: "critic", label: "Critic", summary: "Second-pass verdict at high stakes", kind: "verify" },
  { id: "preview", label: "Preview", summary: "Exercise the assembled behavior", kind: "preview" },
];

const DEPTH: Record<Stakes, StageId[]> = {
  LOW: ["deconstruct", "calibrate", "compile", "lint", "preview"],
  MEDIUM: ["deconstruct", "calibrate", "compile", "harden", "lint", "preview"],
  HIGH: ["deconstruct", "calibrate", "compile", "harden", "critique", "refine", "lint", "critic", "preview"],
  "SAFETY-CRITICAL": ["deconstruct", "calibrate", "compile", "harden", "critique", "refine", "lint", "critic", "preview"],
};

const EMPTY_CONTEXT: PromptContext = { spec: "", calibration: "", prompt: "", critique: "", lint: "", critic: "" };
const LOCAL_PROVIDER_IDS: LocalProviderId[] = ["ollama", "lmstudio"];
const HOSTED_PROVIDER_IDS: HostedProviderId[] = ["openai", "anthropic", "gemini", "compatible"];

function isLocalProvider(provider: ProviderId): provider is LocalProviderId {
  return LOCAL_PROVIDER_IDS.includes(provider as LocalProviderId);
}

function isHostedProvider(provider: ProviderId): provider is HostedProviderId {
  return HOSTED_PROVIDER_IDS.includes(provider as HostedProviderId);
}

type PipelineState = {
  context: PromptContext;
  outputs: Partial<Record<StageId, StageOutput>>;
  active: StageId;
  revision: number;
  lintRevision: number | null;
  criticRevision: number | null;
  history: RevisionEntry[];
  sources: ReferenceCitation[];
};

type PipelineAction =
  | { type: "reset" }
  | { type: "start"; stage: StageId }
  | { type: "result"; stage: StageId; output: StageOutput; context: PromptContext; promptChanged: boolean; sources: ReferenceCitation[] }
  | { type: "error"; stage: StageId; message: string }
  | { type: "select"; stage: StageId };

function initialState(): PipelineState {
  return { context: EMPTY_CONTEXT, outputs: {}, active: "deconstruct", revision: 0, lintRevision: null, criticRevision: null, history: [], sources: [] };
}

function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  if (action.type === "reset") return initialState();
  if (action.type === "select") return { ...state, active: action.stage };
  if (action.type === "start") {
    return { ...state, active: action.stage, outputs: { ...state.outputs, [action.stage]: { text: "", status: "running" } } };
  }
  if (action.type === "error") {
    return { ...state, active: action.stage, outputs: { ...state.outputs, [action.stage]: { text: `Error: ${action.message}`, status: "error" } } };
  }

  const outputs = { ...state.outputs, [action.stage]: action.output };
  let revision = state.revision;
  let history = state.history;
  let lintRevision = state.lintRevision;
  let criticRevision = state.criticRevision;
  let sources = state.sources;
  const context = action.context;

  if (action.promptChanged && context.prompt !== state.context.prompt) {
    if (state.context.prompt) {
      history = [
        {
          revision: state.revision,
          prompt: state.context.prompt,
          summary: promptSummary(state.context.prompt),
          hash: shortPromptHash(state.context.prompt),
          stage: STAGES.find((stage) => stage.id === action.stage)?.label ?? action.stage,
          at: Date.now(),
          sources: state.sources,
        },
        ...state.history,
      ].slice(0, 8);
    }
    revision += 1;
    sources = action.sources;
    lintRevision = null;
    criticRevision = null;
    context.lint = "";
    context.critic = "";
    delete outputs.lint;
    delete outputs.critic;
  }

  if (action.stage === "lint" && context.lint) lintRevision = revision;
  if (action.stage === "critic" && context.critic) criticRevision = revision;
  return { context, outputs, active: action.stage, revision, lintRevision, criticRevision, history, sources };
}

function statusForVerdict(verdict: Verdict | "") {
  if (verdict === "PASS") return { label: "PASS", color: MOSS };
  if (verdict === "DEGRADED") return { label: "DEGRADED", color: "#8A6100" };
  if (verdict === "GATE_FAIL") return { label: "GATE FAIL", color: RED };
  return { label: "PENDING", color: "#667080" };
}

function download(filename: string, body: string, mime: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const element = document.createElement("a");
  element.href = url;
  element.download = filename;
  element.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function deriveVerdict(state: PipelineState, stakes: Stakes): Verdict {
  if (!state.context.prompt || state.lintRevision !== state.revision) return "PENDING";
  const criticRequired = stakes === "HIGH" || stakes === "SAFETY-CRITICAL";
  if (criticRequired && state.criticRevision !== state.revision) return "PENDING";
  if (state.context.lint === "GATE_FAIL" || state.context.critic === "GATE_FAIL") return "GATE_FAIL";
  if (state.context.lint === "DEGRADED" || state.context.critic === "DEGRADED") return "DEGRADED";
  return "PASS";
}

function isStageReady(stage: StageId, context: PromptContext, stakes: Stakes) {
  if (stage === "deconstruct") return true;
  if (stage === "calibrate") return Boolean(context.spec);
  if (stage === "compile") return Boolean(context.spec && context.calibration);
  if (stage === "harden") return Boolean(context.prompt);
  if (stage === "critique" || stage === "lint" || stage === "preview") return Boolean(context.prompt);
  if (stage === "refine") return Boolean(context.prompt && context.critique);
  if (stage === "critic") return Boolean(context.prompt && context.lint) && (stakes === "HIGH" || stakes === "SAFETY-CRITICAL");
  return false;
}

function stageStatusIcon(status: StageStatus | undefined) {
  if (status === "done") return <Check size={14} />;
  if (status === "running") return <span className="sl-spinner" />;
  if (status === "error") return <X size={14} />;
  return <ChevronRight size={14} />;
}

function Button({ children, onClick, disabled, tone = "ink", title, type = "button" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: "ink" | "blue" | "red" | "paper"; title?: string; type?: "button" | "submit" }) {
  return (
    <button className={`sl-button sl-button-${tone}`} type={type} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function VerdictStamp({ value, subtle = false }: { value: Verdict | ""; subtle?: boolean }) {
  const meta = statusForVerdict(value);
  return <span className={`sl-stamp ${subtle ? "sl-stamp-subtle" : ""}`} style={{ "--stamp": meta.color } as React.CSSProperties}>{meta.label}</span>;
}

export default function SystemPromptBuilderPipeline() {
  const { isAuthenticated } = useAuth();
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST);
  const [stakes, setStakes] = useState<Stakes>("MEDIUM");
  const [provider, setProvider] = useState<ProviderId>("mock");
  const [localConfigs, setLocalConfigs] = useState<Record<LocalProviderId, LocalProviderConfig>>({
    ollama: { model: "", baseUrl: "http://localhost:11434/v1" },
    lmstudio: { model: "", baseUrl: "http://localhost:1234/v1" },
  });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [hostedModels, setHostedModels] = useState<Record<HostedProviderId, string>>({ openai: "", anthropic: "", gemini: "", compatible: "" });
  const [modelNotice, setModelNotice] = useState("");
  const [tokenBudget, setTokenBudget] = useState("2000");
  const [running, setRunning] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [comparison, setComparison] = useState<RevisionEntry | null>(null);
  const [saved, setSaved] = useState<SavedPrompt[]>(() => {
    try { return JSON.parse(window.localStorage.getItem("signal-ledger-vault-v1") ?? "[]") as SavedPrompt[]; } catch { return []; }
  });
  const [copied, setCopied] = useState(false);
  const [attachedReferences, setAttachedReferences] = useState<AttachedReferenceContext>({ context: "", sources: [] });
  const hostedCapabilities = trpc.hosted.capabilities.useQuery(undefined, { enabled: isAuthenticated && isHostedProvider(provider) });
  const hostedGenerate = trpc.hosted.generate.useMutation();
  const [state, dispatch] = useReducer(pipelineReducer, undefined, initialState);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);

  const activeStage = STAGES.find((stage) => stage.id === state.active) ?? STAGES[0];
  const selectedStages = DEPTH[stakes];
  const finalVerdict = deriveVerdict(state, stakes);
  const canSave = finalVerdict === "PASS";
  const comparisonDiff = useMemo(() => (comparison ? unifiedPromptDiff(comparison.prompt, state.context.prompt) : []), [comparison, state.context.prompt]);

  useEffect(() => {
    window.localStorage.setItem("signal-ledger-vault-v1", JSON.stringify(saved.slice(0, 20)));
  }, [saved]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowSecurity(false);
        setShowHistory(false);
        setComparison(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !running) {
        event.preventDefault();
        void runAll();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const updateConfig = (key: keyof LocalProviderConfig, value: string) => {
    if (!isLocalProvider(provider)) return;
    setLocalConfigs((current) => ({ ...current, [provider]: { ...current[provider], [key]: value } }));
  };

  const activeHostedCapability = isHostedProvider(provider) ? hostedCapabilities.data?.find((capability) => capability.id === provider) : undefined;
  const hostedReady = !isHostedProvider(provider) || Boolean(isAuthenticated && activeHostedCapability?.available && hostedModels[provider]);

  useEffect(() => {
    if (!isHostedProvider(provider) || !activeHostedCapability?.available || !activeHostedCapability.models.length) return;
    setHostedModels((current) => current[provider] && activeHostedCapability.models.includes(current[provider]) ? current : { ...current, [provider]: activeHostedCapability.models[0] });
  }, [provider, activeHostedCapability?.available, activeHostedCapability?.models.join(",")]);

  const runStage = async (stageId: StageId, working: PromptContext, signal: AbortSignal): Promise<PromptContext> => {
    dispatch({ type: "start", stage: stageId });
    try {
      let outputText = "";
      let next = { ...working };
      let usage: StageOutput["usage"];
      let finishReason: string | undefined;
      const safetyTier = stakes === "SAFETY-CRITICAL";
      const recursiveTarget = /meta.?compiler|prompt (?:compiler|architect)|compiles? prompts?/i.test(brief);

      if (stageId === "lint") {
        const lint = lintPrompt(working.prompt, { tokenBudget: Number(tokenBudget) || undefined, safetyTier, recursiveTarget });
        outputText = formatLint(lint);
        next.lint = lint.verdict;
      } else {
        const instruction = stageInstruction(stageId, brief, working, testMessage, attachedReferences.context);
        const systemPrompt = "You are one stage in a safe prompt-compilation workflow. Output only what the stage asks for.";
        const result = provider === "mock"
          ? mockStageResponse(stageId, brief, working, testMessage)
          : isLocalProvider(provider)
            ? await callLocalOpenAICompatible(provider, localConfigs[provider], systemPrompt, instruction, signal)
            : await hostedGenerate.mutateAsync({ provider, model: hostedModels[provider], system: systemPrompt, user: instruction, temperature: 0.2 });
        outputText = result.text;
        usage = result.usage;
        finishReason = result.finishReason;
        if (stageId === "deconstruct") next.spec = outputText;
        if (stageId === "calibrate") next.calibration = outputText;
        if (stageId === "compile" || stageId === "harden" || stageId === "refine") {
          next.prompt = appendReferenceCitations(outputText, attachedReferences.sources);
          outputText = next.prompt;
        }
        if (stageId === "critique") next.critique = outputText;
        if (stageId === "critic") next.critic = /VERDICT:\s*GATE_FAIL/i.test(outputText) ? "GATE_FAIL" : /VERDICT:\s*DEGRADED/i.test(outputText) ? "DEGRADED" : "PASS";
      }

      const promptChanged = ["compile", "harden", "refine"].includes(stageId) && next.prompt !== working.prompt;
      if (promptChanged) {
        next = { ...next, lint: "", critic: "" };
      }
      dispatch({ type: "result", stage: stageId, context: next, promptChanged, sources: attachedReferences.sources, output: { text: outputText, status: "done", usage, finishReason } });
      return next;
    } catch (error) {
      dispatch({ type: "error", stage: stageId, message: formatProviderError(error) });
      throw error;
    }
  };

  const runAll = async () => {
    if (!brief.trim() || running) return;
    const identity = ++runRef.current;
    abortRef.current = new AbortController();
    setRunning(true);
    dispatch({ type: "reset" });
    let working = { ...EMPTY_CONTEXT };
    try {
      for (const stage of selectedStages) {
        if (identity !== runRef.current) return;
        working = await runStage(stage, working, abortRef.current.signal);
      }
    } catch {
      // Stage-specific message remains visible in the ledger.
    } finally {
      if (identity === runRef.current) setRunning(false);
    }
  };

  const runOne = async () => {
    if (running) return;
    if (!isStageReady(activeStage.id, state.context, stakes)) {
      dispatch({ type: "error", stage: activeStage.id, message: "This stage needs a current upstream result. Run the required earlier stage or compile the full selected path." });
      return;
    }
    const identity = ++runRef.current;
    abortRef.current = new AbortController();
    setRunning(true);
    try {
      await runStage(activeStage.id, state.context, abortRef.current.signal);
    } catch {
      // Stage-specific error appears in the active output.
    } finally {
      if (identity === runRef.current) setRunning(false);
    }
  };

  const stop = () => {
    runRef.current += 1;
    abortRef.current?.abort();
    setRunning(false);
  };

  const fetchModels = async () => {
    if (!isLocalProvider(provider)) return;
    setModelNotice("Checking local server…");
    try {
      const models = await listLocalModels(provider, localConfigs[provider]);
      setModelOptions(models);
      setModelNotice(models.length ? `${models.length} local model${models.length === 1 ? "" : "s"} available.` : "No models were reported by this local server.");
    } catch (error) {
      setModelOptions([]);
      setModelNotice(formatProviderError(error));
    }
  };

  const copyPrompt = async () => {
    if (!state.context.prompt) return;
    await navigator.clipboard?.writeText(state.context.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const savePrompt = () => {
    if (!canSave) return;
    const entry: SavedPrompt = {
      id: crypto.randomUUID(), brief: brief.slice(0, 92), prompt: state.context.prompt, stakes, verdict: finalVerdict, provider,
      model: provider === "mock" ? "local demonstration" : isLocalProvider(provider) ? localConfigs[provider].model : hostedModels[provider], at: Date.now(), sources: state.sources,
    };
    setSaved((current) => [entry, ...current].slice(0, 20));
  };

  const exportPrompt = (format: "txt" | "json" | "md") => {
    const base = `signal-ledger-r${state.revision || "draft"}`;
    if (format === "txt") download(`${base}.txt`, state.context.prompt, "text/plain;charset=utf-8");
    if (format === "json") download(`${base}.json`, JSON.stringify({ brief, prompt: state.context.prompt, stakes, verdict: finalVerdict, revision: state.revision, provider, sources: state.sources, exportedAt: new Date().toISOString() }, null, 2), "application/json;charset=utf-8");
    if (format === "md") download(`${base}.md`, `---\nrevision: ${state.revision}\nstakes: ${stakes}\nverdict: ${finalVerdict}\nsources: ${state.sources.map((source) => source.citation).join(", ") || "none"}\n---\n\n${state.context.prompt}`, "text/markdown;charset=utf-8");
  };

  return (
    <div className="sl-app">
      <style>{styles + auditStyles + referenceVaultStyles + referencePreviewStyles + referenceSearchStyles}</style>
      <header className="sl-header">
        <div className="sl-header-rule" />
        <div className="sl-brand">
          <img src="/manus-storage/signal-ledger-logo_b24959a5.png" alt="Signal Ledger logo" className="sl-logo" />
          <div>
            <p className="sl-kicker">Signal Ledger / instruction workbench</p>
            <h1>System Prompt Builder</h1>
          </div>
        </div>
        <div className="sl-header-actions">
          <button className="sl-security-link" onClick={() => setShowSecurity(true)}><LockKeyhole size={14} /> STATIC-SAFE MODE</button>
          {running ? <Button tone="red" onClick={stop}><CircleStop size={14} /> STOP</Button> : <Button tone="blue" onClick={() => void runAll()} disabled={!brief.trim() || !hostedReady}><Play size={14} /> COMPILE <span className="sl-shortcut">⌘↵</span></Button>}
        </div>
      </header>

      <main className="sl-layout">
        <aside className="sl-ledger" aria-label="Pipeline controls">
          <section className="sl-control-section">
            <p className="sl-section-label">01 / RAW INTENT</p>
            <textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={6} aria-label="Raw intent" />
          </section>

          <section className="sl-control-section">
            <p className="sl-section-label">02 / PROVIDER</p>
            <div className="sl-choice-grid" role="radiogroup" aria-label="Local model provider">
              {(["mock", "ollama", "lmstudio"] as ProviderId[]).map((id) => (
                <button key={id} className={`sl-choice ${provider === id ? "is-selected" : ""}`} role="radio" aria-checked={provider === id} onClick={() => { setProvider(id); setModelOptions([]); setModelNotice(""); }}>
                  {id === "mock" ? "DEMO" : id === "ollama" ? "OLLAMA" : "LM STUDIO"}
                </button>
              ))}
            </div>
            <p className="sl-section-label sl-hosted-label">HOSTED MODELS / SERVER ADAPTER</p>
            <div className="sl-choice-grid sl-hosted-choice-grid" role="radiogroup" aria-label="Hosted model provider">
              {HOSTED_PROVIDER_IDS.map((id) => <button key={id} className={`sl-choice ${provider === id ? "is-selected" : ""}`} role="radio" aria-checked={provider === id} onClick={() => { setProvider(id); setModelOptions([]); setModelNotice(""); }}>
                {id === "openai" ? "OPENAI" : id === "anthropic" ? "CLAUDE" : id === "gemini" ? "GEMINI" : "COMPATIBLE"}
              </button>)}
            </div>
            {provider === "mock" ? <p className="sl-field-note"><FlaskConical size={13} /> Local sample outputs only. No network request.</p> : isLocalProvider(provider) ? (
              <div className="sl-provider-fields">
                <label>LOCAL ENDPOINT<input value={localConfigs[provider].baseUrl} onChange={(event) => updateConfig("baseUrl", event.target.value)} /></label>
                <label>MODEL<input list="local-models" value={localConfigs[provider].model} onChange={(event) => updateConfig("model", event.target.value)} placeholder="choose a loaded local model" /></label>
                <datalist id="local-models">{modelOptions.map((model) => <option value={model} key={model} />)}</datalist>
                <Button tone="paper" onClick={() => void fetchModels}><RotateCcw size={13} /> DISCOVER LOCAL MODELS</Button>
                {modelNotice && <p className="sl-field-note">{modelNotice}</p>}
              </div>
            ) : !isAuthenticated ? <div className="sl-provider-fields"><p className="sl-field-note"><LockKeyhole size={13} /> Sign in to use the server-side hosted provider adapter.</p><Button tone="paper" onClick={startLogin}>SIGN IN</Button></div> : hostedCapabilities.isLoading ? <p className="sl-field-note"><span className="sl-spinner" /> Checking server provider access…</p> : !activeHostedCapability?.available ? <div className="sl-provider-fields"><p className="sl-field-note"><AlertTriangle size={13} /> {activeHostedCapability?.reason ?? "This hosted provider is not configured on the server."}</p><p className="sl-field-note">Provider credentials and allowlisted models are server-only. Local endpoint fields remain restricted to localhost.</p></div> : (
              <div className="sl-provider-fields">
                <label>APPROVED MODEL<select value={hostedModels[provider]} onChange={(event) => setHostedModels((current) => ({ ...current, [provider]: event.target.value }))}>{activeHostedCapability.models.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
                <p className="sl-field-note"><LockKeyhole size={13} /> Hosted requests run through the authenticated server adapter. No API key or endpoint is stored in this browser.</p>
              </div>
            )}
          </section>

          <section className="sl-control-section">
            <p className="sl-section-label">03 / REVIEW DEPTH</p>
            <div className="sl-stakes" role="radiogroup" aria-label="Review depth">
              {(Object.keys(DEPTH) as Stakes[]).map((level) => <button key={level} role="radio" aria-checked={stakes === level} className={stakes === level ? "is-selected" : ""} onClick={() => setStakes(level)}>{level === "SAFETY-CRITICAL" ? "SAFETY" : level}</button>)}
            </div>
            <p className="sl-field-note"><ShieldCheck size={13} /> {selectedStages.length} selected stages. Critic required at HIGH and SAFETY.</p>
          </section>

          <section className="sl-control-section sl-test-section">
            <p className="sl-section-label">04 / PREVIEW MESSAGE</p>
            <textarea value={testMessage} onChange={(event) => setTestMessage(event.target.value)} rows={3} aria-label="Preview message" />
            <label className="sl-budget">TOKEN BUDGET<input value={tokenBudget} inputMode="numeric" onChange={(event) => setTokenBudget(event.target.value.replace(/\D/g, ""))} /></label>
          </section>
          <PromptReferenceVault onContextChange={(value) => { setAttachedReferences(value); dispatch({ type: "reset" }); setComparison(null); }} />
        </aside>

        <section className="sl-workspace" aria-label="Pipeline workspace">
          <div className="sl-hero-image"><img src="/manus-storage/signal-ledger-workbench_821ab81a.png" alt="Editorial workbench with paper, pencil, and proof marks" /></div>
          <div className="sl-workspace-head">
            <div>
              <p className="sl-kicker">Selected process / {stakes.toLowerCase()}{attachedReferences.sources.length ? ` / ${attachedReferences.sources.length} source${attachedReferences.sources.length === 1 ? "" : "s"} attached` : ""}</p>
              <h2>Build an instruction set you can inspect.</h2>
            </div>
            <div className="sl-process-meta"><span>{selectedStages.length} STAGES</span><span>R{state.revision}</span></div>
          </div>
          <nav className="sl-stages" aria-label="Pipeline stages">
            {STAGES.map((stage, index) => {
              const selected = selectedStages.includes(stage.id);
              const output = state.outputs[stage.id];
              const active = state.active === stage.id;
              return <button key={stage.id} disabled={!selected} onClick={() => dispatch({ type: "select", stage: stage.id })} className={`sl-stage ${active ? "is-active" : ""} ${!selected ? "is-off" : ""}`}>
                <span className="sl-stage-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="sl-stage-title">{stage.label}</span>
                <span className="sl-stage-icon">{stageStatusIcon(output?.status)}</span>
              </button>;
            })}
          </nav>
          <section className="sl-active-panel" aria-live="polite">
            <div className="sl-active-head">
              <div>
                <p className="sl-section-label">ACTIVE STAGE / {activeStage.kind.toUpperCase()}</p>
                <h3>{activeStage.label}</h3>
                <p>{activeStage.summary}</p>
              </div>
              <Button tone="ink" onClick={() => void runOne()} disabled={running || !selectedStages.includes(activeStage.id) || !hostedReady}><Play size={14} /> RUN THIS</Button>
            </div>
            <div className={`sl-output ${state.outputs[activeStage.id]?.status === "error" ? "is-error" : ""}`}>
              {state.outputs[activeStage.id]?.text ? <pre>{state.outputs[activeStage.id]?.text}</pre> : <div className="sl-empty"><Sparkles size={22} /><p>{selectedStages.includes(activeStage.id) ? "Select this stage and run it once its required context exists." : "This stage is omitted at the selected review depth."}</p></div>}
            </div>
          </section>
        </section>

        <aside className="sl-proof" aria-label="Compiled prompt and proof">
          <div className="sl-proof-head">
            <div><p className="sl-section-label">PROOF / COMPILED PROMPT</p><h2>Revision {state.revision || "—"}</h2></div>
            <VerdictStamp value={finalVerdict} />
          </div>
          <div className="sl-validation-row">
            <span>LINT <VerdictStamp subtle value={state.lintRevision === state.revision ? state.context.lint : ""} /></span>
            <span>CRITIC <VerdictStamp subtle value={(stakes === "HIGH" || stakes === "SAFETY-CRITICAL") && state.criticRevision === state.revision ? state.context.critic : stakes === "HIGH" || stakes === "SAFETY-CRITICAL" ? "" : "PASS"} /></span>
          </div>
          <div className="sl-proof-document">
            {state.context.prompt ? <pre>{state.context.prompt}</pre> : <div className="sl-proof-empty"><FileText size={24} /><p>The compiled system prompt will appear here after the first build stage.</p></div>}
          </div>
          {state.sources.length > 0 && <section className="sl-source-ledger" aria-label="Sources persisted with this revision"><p className="sl-section-label">SOURCE LEDGER / THIS REVISION</p>{state.sources.map((source) => <p key={source.id}><strong>[{source.citation}]</strong> {source.originalName} <span>{source.tokenBudget} TK / {source.estimatedTokens} available</span></p>)}</section>}
          <PromptDraftAudit draft={state.context.prompt} revision={state.revision} provider={provider} tokenBudget={Number(tokenBudget) || 0} />
          <div className="sl-proof-actions">
            <Button tone="paper" onClick={() => void copyPrompt()} disabled={!state.context.prompt}><Clipboard size={13} /> {copied ? "COPIED" : "COPY"}</Button>
            <Button tone="paper" onClick={savePrompt} disabled={!canSave}><Save size={13} /> SAVE</Button>
            <Button tone="paper" onClick={() => exportPrompt("txt")} disabled={!state.context.prompt}><Download size={13} /> TXT</Button>
            <Button tone="paper" onClick={() => exportPrompt("json")} disabled={!state.context.prompt}><FileJson size={13} /> JSON</Button>
            <Button tone="paper" onClick={() => exportPrompt("md")} disabled={!state.context.prompt}><FileText size={13} /> MD</Button>
          </div>
          <div className="sl-proof-footer">
            <button onClick={() => setShowHistory(true)}><History size={14} /> REVISION LEDGER ({state.history.length})</button>
            <button onClick={() => dispatch({ type: "reset" })}><RotateCcw size={14} /> RESET RUN</button>
          </div>
          {saved.length > 0 && <section className="sl-vault"><p className="sl-section-label">SAVED VAULT</p>{saved.slice(0, 3).map((entry) => <div className="sl-vault-item" key={entry.id}><p>{entry.brief}</p><span>{new Date(entry.at).toLocaleDateString()} / {entry.stakes} / {entry.sources?.length ?? 0} source{(entry.sources?.length ?? 0) === 1 ? "" : "s"}</span></div>)}</section>}
        </aside>
      </main>

      {showSecurity && <div className="sl-modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setShowSecurity(false)}><section className="sl-modal" role="dialog" aria-modal="true" aria-labelledby="security-title"><button className="sl-close" onClick={() => setShowSecurity(false)} aria-label="Close security details"><X size={18} /></button><LockKeyhole size={24} color={BLUE} /><p className="sl-section-label">STATIC-SAFE MODE</p><h2 id="security-title">Hosted credentials never enter this browser.</h2><p>This static build intentionally supports only the offline demonstration and explicitly configured local Ollama or LM Studio servers. Anthropic, OpenAI, and Gemini require a server-side adapter with server-only credentials, model allowlists, request-size controls, and usage policies before they can be enabled.</p><Button tone="blue" onClick={() => setShowSecurity(false)}>UNDERSTOOD</Button></section></div>}

      {showHistory && <div className="sl-modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setShowHistory(false)}><section className="sl-modal sl-history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title"><button className="sl-close" onClick={() => setShowHistory(false)} aria-label="Close revision ledger"><X size={18} /></button><History size={24} color={BLUE} /><p className="sl-section-label">REVISION LEDGER</p><h2 id="history-title">Earlier prompt states</h2>{state.history.length ? <div className="sl-history-list">{state.history.map((entry) => <article key={`${entry.revision}-${entry.hash}`}><div><strong>R{entry.revision}</strong><code>{entry.hash}</code></div><p>{entry.summary}</p><button onClick={() => { setComparison(entry); setShowHistory(false); }}>COMPARE WITH CURRENT <ChevronRight size={13} /></button></article>)}</div> : <p>No earlier compiled revision exists in this run.</p>}</section></div>}

      {comparison && <div className="sl-modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setComparison(null)}><section className="sl-modal sl-comparison-modal" role="dialog" aria-modal="true" aria-labelledby="comparison-title"><button className="sl-close" onClick={() => setComparison(null)} aria-label="Close comparison"><X size={18} /></button><p className="sl-section-label">COMPARE / R{comparison.revision} → R{state.revision}</p><h2 id="comparison-title">Proof differences</h2><div className="sl-diff">{comparisonDiff.map((row, index) => <pre className={`sl-diff-${row.type}`} key={`${row.type}-${index}`}>{row.type === "added" ? "+" : row.type === "removed" ? "−" : "·"} {row.text}</pre>)}</div></section></div>}
    </div>
  );
}

const styles = `
  .sl-app{--paper:${PAPER};--ink:${INK};--blue:${BLUE};--red:${RED};--moss:${MOSS};--sand:${SAND};min-height:100vh;background:var(--paper);color:var(--ink);font-family:"DM Mono",ui-monospace,monospace;letter-spacing:-.02em}.sl-app *{box-sizing:border-box}.sl-app button,.sl-app textarea,.sl-app input{font:inherit}.sl-header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 26px;border-bottom:1px solid #cfc6b6;background:rgba(247,242,232,.95);backdrop-filter:blur(14px)}.sl-header-rule{position:absolute;bottom:-1px;left:26px;width:17%;height:3px;background:var(--blue)}.sl-brand{display:flex;align-items:center;gap:12px}.sl-logo{width:39px;height:39px;object-fit:contain}.sl-kicker,.sl-section-label{margin:0;color:#6f6d67;font-size:10px;letter-spacing:.11em;font-weight:500}.sl-brand h1,.sl-header h2,.sl-workspace h2,.sl-proof h2,.sl-active-panel h3,.sl-modal h2{margin:3px 0 0;font-family:"Source Serif 4",Georgia,serif;letter-spacing:-.045em}.sl-brand h1{font-size:21px}.sl-header-actions{display:flex;align-items:center;gap:10px}.sl-security-link{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:#3d4350;font-size:10px;letter-spacing:.08em;cursor:pointer}.sl-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ink);min-height:35px;padding:8px 10px;background:var(--ink);color:var(--paper);font-size:10px;letter-spacing:.06em;cursor:pointer;transition:transform .15s ease,background .15s ease,color .15s ease}.sl-button:hover:not(:disabled){transform:translateY(-1px)}.sl-button:active:not(:disabled){transform:scale(.98)}.sl-button:disabled{cursor:not-allowed;opacity:.38}.sl-button-blue{border-color:var(--blue);background:var(--blue);color:#fff}.sl-button-red{border-color:var(--red);background:var(--red);color:#fff}.sl-button-paper{background:transparent;color:var(--ink);border-color:#c8bead}.sl-shortcut{padding-left:4px;opacity:.7}.sl-layout{display:grid;grid-template-columns:minmax(255px,22vw) minmax(390px,1fr) minmax(300px,25vw);min-height:calc(100vh - 70px)}.sl-ledger{border-right:1px solid #cfc6b6;background:#ece5d7;overflow:auto}.sl-control-section{padding:19px 18px;border-bottom:1px solid #cfc6b6}.sl-control-section textarea{width:100%;margin-top:9px;padding:10px;border:1px solid #beb5a6;background:rgba(255,255,255,.48);color:var(--ink);font-size:11px;line-height:1.6;resize:vertical;outline:none}.sl-control-section textarea:focus,.sl-provider-fields input:focus,.sl-budget input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(23,92,255,.12)}.sl-choice-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.sl-choice{border:1px solid #c8bead;background:transparent;padding:8px 6px;color:#4f514e;font-size:9px;letter-spacing:.06em;cursor:pointer}.sl-choice.is-selected,.sl-stakes button.is-selected{border-color:var(--blue);background:var(--blue);color:#fff}.sl-field-note{display:flex;align-items:flex-start;gap:6px;margin:9px 0 0;color:#59616a;font-size:10px;line-height:1.5}.sl-provider-fields{display:grid;gap:8px;margin-top:10px}.sl-provider-fields label,.sl-budget{display:grid;gap:5px;color:#686861;font-size:9px;letter-spacing:.07em}.sl-provider-fields input,.sl-budget input{width:100%;border:1px solid #beb5a6;background:#f8f4ea;padding:8px;color:var(--ink);font-size:10px;outline:none}.sl-stakes{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:9px}.sl-stakes button{min-height:30px;border:1px solid #c8bead;background:transparent;color:#4f514e;font-size:9px;letter-spacing:.05em;cursor:pointer}.sl-test-section{background:rgba(255,255,255,.2)}.sl-budget{margin-top:10px}.sl-workspace{position:relative;display:flex;min-width:0;flex-direction:column;overflow:auto;background:linear-gradient(90deg,rgba(23,92,255,.035) 1px,transparent 1px),#fdfbf6;background-size:48px 48px}.sl-hero-image{height:112px;overflow:hidden;border-bottom:1px solid #cfc6b6}.sl-hero-image img{width:100%;height:100%;object-fit:cover;object-position:center 55%;filter:grayscale(.2) contrast(.96)}.sl-workspace-head{display:flex;justify-content:space-between;gap:20px;padding:23px 28px 17px;border-bottom:1px solid #d9d2c6}.sl-workspace h2{font-size:30px;max-width:620px}.sl-process-meta{display:flex;align-items:flex-start;gap:8px;color:#535a68;font-size:10px}.sl-process-meta span{padding:5px 6px;border:1px solid #d1c7b6}.sl-stages{display:grid;grid-template-columns:repeat(9,1fr);padding:0 20px;border-bottom:1px solid #d9d2c6}.sl-stage{position:relative;display:flex;min-width:0;min-height:90px;flex-direction:column;align-items:flex-start;justify-content:space-between;border:0;border-right:1px solid #dfd8cd;background:transparent;padding:12px 8px;color:#303540;text-align:left;cursor:pointer}.sl-stage:last-child{border-right:0}.sl-stage:after{position:absolute;bottom:0;left:0;width:100%;height:3px;background:transparent;content:""}.sl-stage.is-active{background:rgba(23,92,255,.065);color:var(--blue)}.sl-stage.is-active:after{background:var(--blue)}.sl-stage.is-off{cursor:not-allowed;opacity:.3}.sl-stage-number{font-size:9px;color:#838079}.sl-stage-title{overflow:hidden;max-width:100%;font-size:10px;line-height:1.25;letter-spacing:.02em}.sl-stage-icon{display:flex;min-height:15px;align-items:center}.sl-spinner{display:block;width:12px;height:12px;border:2px solid rgba(23,92,255,.25);border-top-color:var(--blue);border-radius:50%;animation:sl-spin 700ms linear infinite}.sl-active-panel{padding:28px;flex:1}.sl-active-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.sl-active-panel h3{font-size:27px}.sl-active-panel h3+p{margin:5px 0 0;color:#636968;font-size:11px}.sl-output{min-height:340px;margin-top:20px;border:1px solid #d4ccbf;background:rgba(247,242,232,.76);box-shadow:10px 10px 0 rgba(23,92,255,.055)}.sl-output.is-error{border-color:#d58d86;background:#fff6f4}.sl-output pre,.sl-proof-document pre,.sl-diff pre{margin:0;white-space:pre-wrap;word-break:break-word}.sl-output pre{padding:19px;color:#263140;font-size:11px;line-height:1.75}.sl-empty,.sl-proof-empty{display:grid;place-items:center;min-height:300px;padding:28px;color:#75736e;text-align:center;font-size:11px;line-height:1.6}.sl-empty p{max-width:270px}.sl-proof{display:flex;min-width:0;flex-direction:column;border-left:1px solid #cfc6b6;background:#f1eadc;padding:18px;overflow:auto}.sl-proof-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.sl-proof h2{font-size:23px}.sl-stamp{display:inline-flex;align-items:center;border:1px solid var(--stamp);padding:4px 6px;color:var(--stamp);font-size:8px;font-weight:500;letter-spacing:.1em;white-space:nowrap}.sl-stamp-subtle{padding:2px 4px;font-size:7px}.sl-validation-row{display:flex;gap:7px;flex-wrap:wrap;margin:13px 0;color:#62676d;font-size:9px}.sl-validation-row span{display:flex;align-items:center;gap:4px}.sl-proof-document{min-height:360px;max-height:min(52vh,630px);overflow:auto;border:1px solid #cbc1b0;background:#fffdf8;box-shadow:7px 7px 0 rgba(20,26,34,.07)}.sl-proof-document pre{padding:16px;color:#2d3743;font-size:10px;line-height:1.65}.sl-proof-empty{min-height:360px}.sl-proof-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.sl-proof-actions .sl-button{min-height:30px;padding:6px 7px;font-size:8px}.sl-proof-footer{display:flex;justify-content:space-between;gap:8px;margin-top:13px;border-top:1px solid #d4cbbe;padding-top:12px}.sl-proof-footer button,.sl-history-list button{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;padding:0;color:#47505c;font-size:9px;letter-spacing:.05em;cursor:pointer}.sl-vault{margin-top:20px;border-top:1px solid #d4cbbe;padding-top:15px}.sl-vault-item{margin-top:7px;border-left:2px solid var(--blue);background:#f9f5eb;padding:7px 8px}.sl-vault-item p{overflow:hidden;margin:0;color:#353b44;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.sl-vault-item span{color:#777873;font-size:8px}.sl-modal-backdrop{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(20,26,34,.62);padding:18px;backdrop-filter:blur(3px)}.sl-modal{position:relative;width:min(530px,100%);border-top:4px solid var(--blue);background:var(--paper);padding:27px;box-shadow:16px 16px 0 rgba(20,26,34,.28)}.sl-modal h2{max-width:460px;font-size:31px;line-height:1.04}.sl-modal>p:not(.sl-section-label){margin:16px 0 22px;color:#4f555e;font-family:"Source Serif 4",Georgia,serif;font-size:17px;line-height:1.5}.sl-close{position:absolute;top:12px;right:12px;border:0;background:transparent;color:#474d57;cursor:pointer}.sl-history-modal{width:min(680px,100%)}.sl-history-list{display:grid;gap:8px;margin-top:16px;max-height:52vh;overflow:auto}.sl-history-list article{border:1px solid #d0c7b9;background:#fffdf7;padding:11px}.sl-history-list article>div{display:flex;justify-content:space-between;gap:10px}.sl-history-list strong{color:var(--blue);font-size:11px}.sl-history-list code{color:#727781;font-size:9px}.sl-history-list p{margin:8px 0;color:#4e5660;font-size:10px;line-height:1.5}.sl-history-list button{color:var(--blue)}.sl-comparison-modal{width:min(920px,100%)}.sl-diff{max-height:60vh;overflow:auto;margin-top:18px;border:1px solid #d0c7b9;background:#fffdf7}.sl-diff pre{padding:4px 10px;font-size:10px;line-height:1.5}.sl-diff-added{background:#e6f5ec;color:#165b3b}.sl-diff-removed{background:#fff0ee;color:#8e2c23}.sl-diff-context{color:#767a7f}@keyframes sl-spin{to{transform:rotate(360deg)}}@media (max-width:1120px){.sl-layout{grid-template-columns:245px 1fr}.sl-proof{grid-column:1/-1;display:grid;grid-template-columns:1fr 2fr;gap:14px;border-top:1px solid #cfc6b6;border-left:0}.sl-proof-document{grid-column:2;grid-row:1/4}.sl-stages{grid-template-columns:repeat(5,1fr)}.sl-stage:nth-child(5){border-right:0}}@media (max-width:760px){.sl-header{align-items:flex-start;padding:13px}.sl-header-actions{gap:6px}.sl-security-link{display:none}.sl-layout{display:block}.sl-ledger{border-right:0;border-bottom:1px solid #cfc6b6}.sl-workspace-head,.sl-active-panel{padding:18px}.sl-workspace h2{font-size:26px}.sl-proof{display:block;padding:14px}.sl-proof-document{margin-top:12px}.sl-stages{grid-template-columns:repeat(3,1fr);padding:0}.sl-stage{min-height:73px}.sl-stage:nth-child(3n){border-right:0}.sl-header-rule{left:13px}.sl-brand h1{font-size:18px}.sl-logo{width:32px;height:32px}}@media (prefers-reduced-motion:reduce){.sl-app *{animation-duration:1ms!important;transition-duration:1ms!important}}
`;

const auditStyles = `
  .sl-draft-audit{margin-top:12px;border:1px solid #cbc1b0;background:#f9f4e9;padding:11px}.sl-draft-audit-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.sl-draft-audit h3{margin:3px 0 0;font-family:"Source Serif 4",Georgia,serif;font-size:19px;letter-spacing:-.04em}.sl-audit-verdict{border:1px solid #69717b;padding:4px 5px;color:#69717b;font-size:7px;letter-spacing:.07em}.sl-audit-verdict.is-pass{border-color:var(--moss);color:var(--moss)}.sl-audit-verdict.is-degraded{border-color:#8a6100;color:#8a6100}.sl-audit-verdict.is-gate-fail{border-color:var(--red);color:var(--red)}.sl-draft-audit-summary{margin:9px 0 0;color:#565d65;font-size:9px}.sl-draft-audit-signals{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;color:#495563;font-size:8px}.sl-draft-audit-signals span{display:inline-flex;align-items:center;gap:4px}.sl-draft-audit-actions{display:flex;gap:7px;margin-top:10px}.sl-draft-audit-actions button{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:0;color:var(--blue);font-size:8px;letter-spacing:.05em;cursor:pointer}.sl-draft-audit-actions button:disabled{color:#888a86;cursor:not-allowed}.sl-draft-audit-findings{margin-top:10px;border-top:1px solid #ded5c7;padding-top:8px}.sl-draft-audit-findings p{margin:0 0 5px;color:#4c5560;font-size:8px;line-height:1.5}.sl-draft-audit-findings strong{color:var(--red)}
`;

const referenceVaultStyles = `
  .sl-reference-vault{border-bottom:1px solid #cfc6b6;background:#e8e0d1;padding:18px}.sl-reference-vault-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;color:var(--blue)}.sl-reference-vault h3{margin:3px 0 0;color:var(--ink);font-family:"Source Serif 4",Georgia,serif;font-size:21px;letter-spacing:-.04em}.sl-reference-vault-copy{margin:8px 0 11px;color:#59616a;font-size:9px;line-height:1.5}.sl-reference-input{display:none}.sl-reference-upload,.sl-reference-login,.sl-reference-attach,.sl-reference-preview{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--blue);background:var(--blue);padding:8px 9px;color:#fff;font-size:9px;letter-spacing:.06em;cursor:pointer}.sl-reference-upload:disabled,.sl-reference-attach:disabled,.sl-reference-preview:disabled{opacity:.55;cursor:not-allowed}.sl-reference-login,.sl-reference-preview,.sl-reference-attach{background:transparent;color:var(--blue)}.sl-reference-attach{margin-top:10px}.sl-reference-status,.sl-reference-empty,.sl-reference-total{display:flex;align-items:center;gap:5px;margin:9px 0 0;color:#5c6060;font-size:8px;line-height:1.45}.sl-reference-total{color:#394e6b}.sl-reference-spin{animation:sl-spin 700ms linear infinite}.sl-reference-list{display:grid;gap:5px;margin:10px 0 0;padding:0;list-style:none}.sl-reference-list li{display:flex;align-items:center;gap:4px;border-top:1px solid #d3c8b7;padding-top:6px}.sl-reference-list li.is-selected{background:rgba(23,92,255,.05)}.sl-reference-select{position:relative;display:grid;place-items:center;width:13px;height:13px;border:1px solid #89909a;color:#fff}.sl-reference-select input{position:absolute;opacity:0;inset:0;cursor:pointer}.sl-reference-select:has(input:checked){border-color:var(--blue);background:var(--blue)}.sl-reference-select:has(input:focus-visible){outline:2px solid var(--blue);outline-offset:2px}.sl-reference-list a{display:flex;min-width:0;flex:1;align-items:center;gap:5px;color:#273442;font-size:8px;text-decoration:none}.sl-reference-list a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sl-reference-list a small{margin-left:auto;color:#777873;font-size:7px}.sl-reference-list button{display:grid;place-items:center;border:0;background:transparent;color:var(--red);cursor:pointer}.sl-reference-budget{display:flex;align-items:center;gap:2px;color:#576270;font-size:7px}.sl-reference-budget input{width:39px;border:1px solid #bcb29f;background:#fffdf7;padding:3px;color:var(--ink);font-size:8px;outline:none}.sl-reference-budget input:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(23,92,255,.12)}.sl-reference-preview-panel{margin-top:10px;border-top:1px solid #c5baa8;padding-top:9px}.sl-reference-preview-panel details{margin-top:6px;border:1px solid #d5cbba;background:#fffdf7}.sl-reference-preview-panel summary{cursor:pointer;padding:6px;color:#303b48;font-size:8px}.sl-reference-preview-panel summary span{float:right;color:#6d737b;font-size:7px}.sl-reference-preview-panel pre{max-height:150px;overflow:auto;margin:0;border-top:1px solid #e1d8ca;padding:7px;white-space:pre-wrap;color:#525b65;font:8px/1.55 "DM Mono",monospace}.sl-source-ledger{margin-top:12px;border-left:2px solid var(--blue);background:#f6f1e6;padding:9px}.sl-source-ledger p:not(.sl-section-label){margin:6px 0 0;color:#3e4854;font-size:8px;line-height:1.45}.sl-source-ledger strong{color:var(--blue)}.sl-source-ledger span{color:#737672}
`;

const referencePreviewStyles = `
  .sl-reference-preview-panel{margin-top:12px;border-top:2px solid var(--blue);background:#f4eee1;padding:10px;box-shadow:5px 5px 0 rgba(23,92,255,.08)}.sl-reference-preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.sl-reference-preview-head h4{margin:3px 0 0;color:var(--ink);font-family:"Source Serif 4",Georgia,serif;font-size:18px;letter-spacing:-.04em}.sl-reference-preview-head button{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:2px;color:var(--blue);font-size:8px;letter-spacing:.06em;cursor:pointer}.sl-reference-preview-note{display:flex;align-items:flex-start;gap:5px;margin:8px 0;color:#59616a;font-size:8px;line-height:1.45}.sl-reference-preview-tabs{display:flex;gap:4px;overflow:auto;margin:9px -2px 0;padding:0 2px}.sl-reference-preview-tabs button{min-width:0;max-width:150px;overflow:hidden;border:1px solid #c8bead;background:#fffdf7;padding:5px 6px;color:#5e6264;font-size:8px;line-height:1.35;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.sl-reference-preview-tabs button[aria-selected="true"]{border-color:var(--blue);background:var(--blue);color:#fff}.sl-reference-preview-tabs button:focus-visible,.sl-reference-preview-head button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.sl-reference-preview-document{margin-top:8px;border:1px solid #cbc1b0;background:#fffdf8}.sl-reference-preview-document>div{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 9px;border-bottom:1px solid #ded5c7;color:var(--blue)}.sl-reference-preview-document span{display:block;margin-top:3px;color:#697079;font-size:7px}.sl-reference-preview-document pre{max-height:185px;overflow:auto;margin:0;padding:10px;white-space:pre-wrap;color:#3f4a56;font:9px/1.6 "DM Mono",monospace}.sl-reference-preview-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}.sl-reference-preview-actions .sl-reference-attach{margin-top:0}.sl-reference-preview-actions span{color:#646a70;font-size:7px;line-height:1.4;text-align:right}@media (max-width:760px){.sl-reference-preview-tabs button{max-width:120px}.sl-reference-preview-actions{align-items:flex-start;flex-direction:column}.sl-reference-preview-actions span{text-align:left}}
`;

const referenceSearchStyles = `
  .sl-reference-search{margin-top:12px;border-top:1px solid #c7bba8;padding-top:9px}.sl-reference-search-controls{display:flex;gap:5px;margin-top:6px}.sl-reference-search-controls input{min-width:0;flex:1;border:1px solid #bcb29f;background:#fffdf7;padding:7px;color:var(--ink);font-size:8px;outline:none}.sl-reference-search-controls input:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(23,92,255,.12)}.sl-reference-search-controls button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--blue);background:var(--blue);padding:6px 7px;color:#fff;font-size:8px;letter-spacing:.05em;cursor:pointer}.sl-reference-search-controls button:disabled{opacity:.55;cursor:not-allowed}.sl-reference-search-note{margin:6px 0 0;color:#70736f;font-size:7px;line-height:1.4}.sl-reference-search-results{display:grid;gap:7px;margin-top:9px}.sl-reference-search-results>p{margin:0;color:#3c4e68;font-size:8px}.sl-reference-search-results article{border:1px solid #d4cab9;background:#fffdf7}.sl-reference-search-results header{display:flex;align-items:center;justify-content:space-between;gap:7px;padding:6px 7px;color:#3c4651;font-size:8px}.sl-reference-search-results header strong{overflow:hidden;max-width:150px;text-overflow:ellipsis;white-space:nowrap}.sl-reference-search-results header button{border:0;background:transparent;padding:0;color:var(--blue);font-size:7px;letter-spacing:.04em;cursor:pointer}.sl-reference-search-results pre{max-height:100px;overflow:auto;margin:0;border-top:1px solid #e1d8ca;padding:7px;white-space:pre-wrap;color:#505b65;font:8px/1.55 "DM Mono",monospace}.sl-reference-search-results button:focus-visible,.sl-reference-search-controls button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}@media (max-width:760px){.sl-reference-search-controls{align-items:stretch;flex-direction:column}.sl-reference-search-controls button{justify-content:center}.sl-reference-search-results header strong{max-width:170px}}
`;
