/**
 * Signal Ledger design reminder: compact proof-sheet styling, calm editorial hierarchy,
 * Ledger Blue for active inspection, and semantic controls for all draft-audit actions.
 */
import { useMemo, useReducer } from "react";
import { Check, Clipboard, FileWarning, ShieldCheck } from "lucide-react";
import { lintPrompt } from "@/lib/promptLint";
import type { ProviderId, Verdict } from "@/lib/promptBuilderTypes";

type AuditState = { copied: boolean; expanded: boolean };
type AuditAction = { type: "copy" } | { type: "clear-copy" } | { type: "toggle" };

function reducer(state: AuditState, action: AuditAction): AuditState {
  if (action.type === "copy") return { ...state, copied: true };
  if (action.type === "clear-copy") return { ...state, copied: false };
  return { ...state, expanded: !state.expanded };
}

function verdictLabel(value: Verdict) {
  if (value === "PASS") return "READY FOR PROOF";
  if (value === "DEGRADED") return "NEEDS REVIEW";
  if (value === "GATE_FAIL") return "GATE FAILED";
  return "NO DRAFT";
}

export function PromptDraftAudit({ draft, revision, provider, tokenBudget }: { draft: string; revision: number; provider: ProviderId; tokenBudget: number }) {
  const [state, dispatch] = useReducer(reducer, { copied: false, expanded: false });
  const audit = useMemo(() => lintPrompt(draft, { tokenBudget: tokenBudget || undefined }), [draft, tokenBudget]);
  const hostedProvider = provider !== "mock" && provider !== "ollama" && provider !== "lmstudio";

  const copyFindings = async () => {
    const text = audit.findings.length ? audit.findings.map((finding) => `${finding.severity} · ${finding.gate}: ${finding.detail}`).join("\n") : "PASS · No deterministic audit findings.";
    await navigator.clipboard?.writeText(text);
    dispatch({ type: "copy" });
    window.setTimeout(() => dispatch({ type: "clear-copy" }), 1200);
  };

  return (
    <section className="sl-draft-audit" aria-labelledby="draft-audit-title">
      <div className="sl-draft-audit-head">
        <div>
          <p className="sl-section-label">LOCAL PREFLIGHT / R{revision || "—"}</p>
          <h3 id="draft-audit-title">Draft audit</h3>
        </div>
        <span className={`sl-audit-verdict is-${audit.verdict.toLowerCase().replace("_", "-")}`}>{verdictLabel(draft ? audit.verdict : "PENDING")}</span>
      </div>
      <p className="sl-draft-audit-summary">
        {draft ? `${audit.estimatedTokens} estimated tokens · ${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"}` : "Run a build stage to create a draft for local inspection."}
      </p>
      <div className="sl-draft-audit-signals">
        <span><ShieldCheck size={13} /> {hostedProvider ? "Hosted adapter required" : provider === "mock" ? "Offline demonstration" : "Local endpoint mode"}</span>
        <span>{audit.verdict === "PASS" ? <Check size={13} /> : <FileWarning size={13} />} deterministic lint</span>
      </div>
      <div className="sl-draft-audit-actions">
        <button type="button" onClick={() => dispatch({ type: "toggle" })} disabled={!draft} aria-expanded={state.expanded}>{state.expanded ? "HIDE FINDINGS" : "VIEW FINDINGS"}</button>
        <button type="button" onClick={() => void copyFindings()} disabled={!draft}><Clipboard size={12} /> {state.copied ? "COPIED" : "COPY FINDINGS"}</button>
      </div>
      {state.expanded && <div className="sl-draft-audit-findings" role="status">{audit.findings.length ? audit.findings.map((finding) => <p key={finding.gate}><strong>{finding.severity}</strong> · {finding.gate}: {finding.detail}</p>) : <p><strong>PASS</strong> · No deterministic audit findings.</p>}</div>}
    </section>
  );
}
