import { useMemo, useRef, useState } from "react";
import { Check, Eye, FileText, FolderOpen, Info, Loader2, LogIn, Paperclip, Quote, Search, Trash2, Upload, X } from "lucide-react";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["text/plain", "text/markdown", "application/pdf"]);
const DEFAULT_REFERENCE_TOKENS = 500;
const MIN_REFERENCE_TOKENS = 100;
const MAX_REFERENCE_TOKENS = 1200;
const MAX_TOTAL_TOKENS = 2400;

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",", 2)[1] ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}

function readableSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type AttachedReferenceContext = {
  context: string;
  sources: Array<{ id: number; originalName: string; citation: string; tokenBudget: number; estimatedTokens: number }>;
};

type PreparedSource = AttachedReferenceContext["sources"][number] & { preview: string };
type PreparedContext = { sources: PreparedSource[]; totalBudget: number };
type SearchResult = { id: number; originalName: string; matches: Array<{ excerpt: string; offset: number }> };
type SearchResponse = { query: string; results: SearchResult[]; totalMatches: number };

export function PromptReferenceVault({ onContextChange }: { onContextChange: (value: AttachedReferenceContext) => void }) {
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [budgets, setBudgets] = useState<Record<number, number>>({});
  const [prepared, setPrepared] = useState<PreparedContext | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);

  const assets = trpc.assets.list.useQuery(undefined, { enabled: isAuthenticated });
  const upload = trpc.assets.upload.useMutation({
    onSuccess: () => {
      setNotice("Reference saved to your private vault.");
      void utils.assets.list.invalidate();
    },
    onError: (error) => setNotice(error.message),
  });
  const remove = trpc.assets.remove.useMutation({
    onSuccess: () => {
      setNotice("Reference removed from the vault. The storage object is no longer reachable from this app.");
      setSelected((current) => current.filter((id) => id !== remove.variables?.id));
      setPrepared(null);
      setActivePreviewId(null);
      onContextChange({ context: "", sources: [] });
      void utils.assets.list.invalidate();
    },
    onError: (error) => setNotice(error.message),
  });
  const previewContext = trpc.assets.previewContext.useMutation({
    onSuccess: (value) => {
      setPrepared(value);
      setActivePreviewId((current) => current && value.sources.some((source) => source.id === current) ? current : value.sources[0]?.id ?? null);
      setNotice("Review the extracted excerpts, then attach the sources to the next compile run.");
    },
    onError: (error) => setNotice(error.message),
  });
  const compileContext = trpc.assets.compileContext.useMutation({
    onSuccess: (value) => {
      onContextChange(value);
      setPrepared(null);
      setActivePreviewId(null);
      setNotice(`${value.sources.length} source${value.sources.length === 1 ? "" : "s"} attached to the next compilation run.`);
    },
    onError: (error) => setNotice(error.message),
  });
  const referenceSearch = trpc.assets.search.useMutation({
    onSuccess: (value) => setSearchResults(value),
    onError: (error) => setNotice(error.message),
  });

  const selection = useMemo(
    () => selected.map((assetId) => ({ assetId, tokenBudget: budgets[assetId] ?? DEFAULT_REFERENCE_TOKENS })),
    [selected, budgets],
  );
  const totalBudget = selection.reduce((total, source) => total + source.tokenBudget, 0);
  const activePreview = prepared?.sources.find((source) => source.id === activePreviewId) ?? prepared?.sources[0];

  const clearPrepared = () => {
    setPrepared(null);
    setActivePreviewId(null);
    setSearchResults(null);
    onContextChange({ context: "", sources: [] });
    setNotice("");
  };

  const toggleSelected = (id: number) => {
    if (!selected.includes(id) && selected.length >= 4) {
      setNotice("Select up to four references for one compilation run.");
      return;
    }
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    clearPrepared();
  };

  const updateBudget = (id: number, rawValue: string) => {
    const tokenBudget = Math.max(MIN_REFERENCE_TOKENS, Math.min(MAX_REFERENCE_TOKENS, Number(rawValue.replace(/\D/g, "")) || MIN_REFERENCE_TOKENS));
    setBudgets((current) => ({ ...current, [id]: tokenBudget }));
    clearPrepared();
  };

  const openSearchResult = (assetId: number) => {
    setActivePreviewId(assetId);
    if (prepared) return;
    previewContext.mutate({ sources: selection });
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type) || file.size > MAX_UPLOAD_BYTES) {
      setNotice("Choose a TXT, Markdown, or PDF reference that is 2 MB or smaller.");
      return;
    }
    try {
      const base64 = await toBase64(file);
      upload.mutate({ originalName: file.name, contentType: file.type as "text/plain" | "text/markdown" | "application/pdf", base64 });
      setNotice("Uploading reference…");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The selected file could not be prepared.");
    }
  };

  return (
    <section className="sl-reference-vault" aria-labelledby="reference-vault-title">
      <div className="sl-reference-vault-head">
        <div>
          <p className="sl-section-label">REFERENCE VAULT / PRIVATE STORAGE</p>
          <h3 id="reference-vault-title">Source files</h3>
        </div>
        <FolderOpen size={19} aria-hidden="true" />
      </div>
      <p className="sl-reference-vault-copy">Keep supporting notes, specs, and PDFs available to your signed-in workspace. Files are stored separately from prompt text.</p>
      {!loading && !isAuthenticated ? (
        <button className="sl-reference-login" type="button" onClick={startLogin}><LogIn size={13} /> SIGN IN TO USE STORAGE</button>
      ) : loading ? <p className="sl-reference-status"><Loader2 className="sl-reference-spin" size={13} /> Checking workspace access…</p> : (
        <>
          <input ref={fileInput} type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" className="sl-reference-input" onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = ""; }} />
          <button className="sl-reference-upload" type="button" disabled={upload.isPending} onClick={() => fileInput.current?.click()}><Upload size={13} /> {upload.isPending ? "UPLOADING" : "UPLOAD REFERENCE"}</button>
          {notice && <p className="sl-reference-status" role="status">{notice}</p>}
          {assets.isLoading ? <p className="sl-reference-status"><Loader2 className="sl-reference-spin" size={13} /> Loading stored files…</p> : assets.data?.length ? <>
            <ul className="sl-reference-list">
              {assets.data.map((asset) => <li key={asset.id} className={selected.includes(asset.id) ? "is-selected" : ""}>
                <label className="sl-reference-select">
                  <input type="checkbox" checked={selected.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
                  <span aria-hidden="true">{selected.includes(asset.id) && <Check size={10} />}</span>
                </label>
                <a href={asset.url} target="_blank" rel="noreferrer"><FileText size={13} /><span>{asset.originalName}</span><small>{readableSize(asset.byteSize)}</small></a>
                {selected.includes(asset.id) && <label className="sl-reference-budget"><span>TK</span><input aria-label={`Token budget for ${asset.originalName}`} inputMode="numeric" value={budgets[asset.id] ?? DEFAULT_REFERENCE_TOKENS} onChange={(event) => updateBudget(asset.id, event.target.value)} /></label>}
                <button type="button" aria-label={`Remove ${asset.originalName}`} disabled={remove.isPending} onClick={() => remove.mutate({ id: asset.id })}><Trash2 size={13} /></button>
              </li>)}
            </ul>
            {selected.length > 0 && <p className="sl-reference-total">{selected.length} source{selected.length === 1 ? "" : "s"} / {totalBudget} of {MAX_TOTAL_TOKENS} input tokens</p>}
            {selected.length > 0 && <section className="sl-reference-search" aria-labelledby="reference-search-title">
              <p className="sl-section-label" id="reference-search-title">FULL-DOCUMENT SEARCH / SELECTED SOURCES</p>
              <div className="sl-reference-search-controls">
                <input aria-label="Search the full text of selected private references" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchResults(null); }} onKeyDown={(event) => { if (event.key === "Enter" && searchQuery.trim().length >= 2) referenceSearch.mutate({ assetIds: selected, query: searchQuery.trim() }); }} placeholder="Find a phrase in selected sources" />
                <button type="button" disabled={searchQuery.trim().length < 2 || referenceSearch.isPending} onClick={() => referenceSearch.mutate({ assetIds: selected, query: searchQuery.trim() })}><Search size={12} /> {referenceSearch.isPending ? "SEARCHING" : "SEARCH"}</button>
              </div>
              <p className="sl-reference-search-note">Search runs server-side against the complete extracted text of your selected private sources.</p>
              {searchResults && <div className="sl-reference-search-results" role="status">
                <p>{searchResults.totalMatches ? `${searchResults.totalMatches} match${searchResults.totalMatches === 1 ? "" : "es"} for “${searchResults.query}”` : `No matches for “${searchResults.query}”.`}</p>
                {searchResults.results.map((result) => <article key={result.id}>
                  <header><strong>{result.originalName}</strong><button type="button" onClick={() => openSearchResult(result.id)}>OPEN IN PREVIEW</button></header>
                  {result.matches.map((match) => <pre key={`${result.id}-${match.offset}`}>{match.excerpt}</pre>)}
                </article>)}
              </div>}
            </section>}
            <button className="sl-reference-preview" type="button" disabled={!selected.length || totalBudget > MAX_TOTAL_TOKENS || previewContext.isPending} onClick={() => previewContext.mutate({ sources: selection })}><Eye size={13} /> {previewContext.isPending ? "READING SOURCES" : "PREVIEW EXCERPTS"}</button>
            {prepared && activePreview && <section className="sl-reference-preview-panel" aria-labelledby="reference-preview-title">
              <div className="sl-reference-preview-head">
                <div><p className="sl-section-label">EXCERPTS / PRE-ATTACHMENT REVIEW</p><h4 id="reference-preview-title">Inspect before attach</h4></div>
                <button type="button" onClick={clearPrepared} aria-label="Return to reference selection"><X size={13} /> EDIT</button>
              </div>
              <p className="sl-reference-preview-note"><Info size={12} /> Extracted source data is untrusted and will be used only as factual grounding.</p>
              <div className="sl-reference-preview-tabs" role="tablist" aria-label="Selected reference excerpts">
                {prepared.sources.map((source) => <button key={source.id} type="button" role="tab" aria-selected={activePreview.id === source.id} onClick={() => setActivePreviewId(source.id)}><strong>[{source.citation}]</strong> {source.originalName}</button>)}
              </div>
              <article className="sl-reference-preview-document" aria-live="polite">
                <div><div><p className="sl-section-label">{activePreview.originalName}</p><span>[{activePreview.citation}] / {activePreview.tokenBudget} TK budget / {activePreview.estimatedTokens} available</span></div><Quote size={17} aria-hidden="true" /></div>
                <pre>{activePreview.preview}</pre>
              </article>
              <div className="sl-reference-preview-actions"><button className="sl-reference-attach" type="button" disabled={compileContext.isPending} onClick={() => compileContext.mutate({ sources: selection })}>{compileContext.isPending ? "ATTACHING" : "ATTACH REVIEWED SOURCES"}</button><span>{prepared.totalBudget} TK will enter the next compilation run.</span></div>
            </section>}
          </> : <p className="sl-reference-empty"><Paperclip size={14} /> No files stored yet.</p>}
        </>
      )}
    </section>
  );
}
