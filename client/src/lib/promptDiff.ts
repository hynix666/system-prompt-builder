export interface DiffRow {
  type: "added" | "removed" | "context";
  text: string;
}

export function shortPromptHash(prompt: string) {
  let hash = 2166136261;
  for (const char of prompt) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function promptSummary(prompt: string) {
  const summary = prompt.replace(/\s+/g, " ").trim();
  return summary.length > 136 ? `${summary.slice(0, 133)}…` : summary || "No prompt content recorded.";
}

export function unifiedPromptDiff(before: string, after: string): DiffRow[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const rows: DiffRow[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) rows.push({ type: "context", text: oldLine ?? "" });
    else {
      if (oldLine !== undefined) rows.push({ type: "removed", text: oldLine });
      if (newLine !== undefined) rows.push({ type: "added", text: newLine });
    }
  }
  return rows;
}
