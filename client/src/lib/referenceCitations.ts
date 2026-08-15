import type { ReferenceCitation } from "./promptBuilderTypes";

const CITATION_HEADING = "## Source citations";

export function appendReferenceCitations(prompt: string, sources: ReferenceCitation[]) {
  const withoutPriorCitations = prompt.replace(new RegExp(`\\n?${CITATION_HEADING}[\\s\\S]*$`, "i"), "").trim();
  if (!sources.length) return withoutPriorCitations;
  const lines = sources.map((source) => `- [${source.citation}] ${source.originalName} — ${source.tokenBudget} input-token budget; ${source.estimatedTokens} tokens available.`);
  return `${withoutPriorCitations}\n\n${CITATION_HEADING}\n${lines.join("\n")}`;
}
