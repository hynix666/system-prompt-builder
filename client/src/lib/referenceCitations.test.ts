import { describe, expect, it } from "vitest";
import { appendReferenceCitations } from "./referenceCitations";

const sources = [{ id: 1, originalName: "release-notes.md", citation: "S1", tokenBudget: 400, estimatedTokens: 620 }];

describe("appendReferenceCitations", () => {
  it("adds a concise, machine-readable source ledger to a compiled prompt", () => {
    const prompt = appendReferenceCitations("# System prompt", sources);
    expect(prompt).toContain("## Source citations");
    expect(prompt).toContain("[S1] release-notes.md");
    expect(prompt).toContain("400 input-token budget");
  });

  it("replaces a prior source ledger instead of duplicating citations", () => {
    const prompt = appendReferenceCitations("# System prompt\n\n## Source citations\n- stale", sources);
    expect(prompt.match(/## Source citations/g)).toHaveLength(1);
    expect(prompt).not.toContain("stale");
  });
});
