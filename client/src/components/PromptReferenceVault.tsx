import { useRef, useState } from "react";
import { Check, FileText, FolderOpen, Loader2, LogIn, Paperclip, Trash2, Upload } from "lucide-react";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["text/plain", "text/markdown", "application/pdf"]);

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

export type AttachedReferenceContext = { context: string; sources: Array<{ id: number; originalName: string }> };

export function PromptReferenceVault({ onContextChange }: { onContextChange: (value: AttachedReferenceContext) => void }) {
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
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
      onContextChange({ context: "", sources: [] });
      void utils.assets.list.invalidate();
    },
    onError: (error) => setNotice(error.message),
  });
  const compileContext = trpc.assets.compileContext.useMutation({
    onSuccess: (value) => {
      onContextChange(value);
      setNotice(`${value.sources.length} source${value.sources.length === 1 ? "" : "s"} attached to the next compilation run.`);
    },
    onError: (error) => setNotice(error.message),
  });

  const toggleSelected = (id: number) => {
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length >= 4 ? current : [...current, id]);
    onContextChange({ context: "", sources: [] });
    setNotice("");
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
          {assets.isLoading ? <p className="sl-reference-status"><Loader2 className="sl-reference-spin" size={13} /> Loading stored files…</p> : assets.data?.length ? <><ul className="sl-reference-list">{assets.data.map((asset) => <li key={asset.id}><label className="sl-reference-select"><input type="checkbox" checked={selected.includes(asset.id)} onChange={() => toggleSelected(asset.id)} /><span aria-hidden="true">{selected.includes(asset.id) && <Check size={10} />}</span></label><a href={asset.url} target="_blank" rel="noreferrer"><FileText size={13} /><span>{asset.originalName}</span><small>{readableSize(asset.byteSize)}</small></a><button type="button" aria-label={`Remove ${asset.originalName}`} disabled={remove.isPending} onClick={() => remove.mutate({ id: asset.id })}><Trash2 size={13} /></button></li>)}</ul><button className="sl-reference-attach" type="button" disabled={!selected.length || compileContext.isPending} onClick={() => compileContext.mutate({ assetIds: selected })}>{compileContext.isPending ? "PREPARING SOURCES" : `ATTACH ${selected.length || ""} TO COMPILE`}</button></> : <p className="sl-reference-empty"><Paperclip size={14} /> No files stored yet.</p>}
        </>
      )}
    </section>
  );
}
