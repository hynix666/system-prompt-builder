import type { Verdict } from "./promptBuilderTypes";

export interface LintFinding {
  gate: string;
  severity: "FAIL" | "WARN";
  detail: string;
}

export interface LintResult {
  verdict: Verdict;
  findings: LintFinding[];
  estimatedTokens: number;
}

const REQUIRED_GUARDS = ["anti-override", "scope", "fact-grounding"];
const PLACEHOLDER_BRACKET = /\[([A-Z][A-Z0-9_ -]{2,}|DYNAMIC_[^\]]+|SPECIFIC_[^\]]+)\]/g;

function stripFencedCode(text: string) {
  return text.replace(/```[\s\S]*?```/g, "");
}

function declaredRuntimeVariables(text: string) {
  const section = text.match(/##\s*Runtime Variables[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
  return new Set(Array.from(section.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_:-]*)\}\}/g)).map((match) => match[1]));
}

export function lintPrompt(
  text: string,
  options: { tokenBudget?: number; safetyTier?: boolean; recursiveTarget?: boolean } = {},
): LintResult {
  const findings: LintFinding[] = [];
  const audit = stripFencedCode(text);
  const declared = declaredRuntimeVariables(audit);
  const runtimeUsed = Array.from(audit.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_:-]*)\}\}/g)).map((match) => match[1]);
  const undeclaredRuntime = Array.from(new Set(runtimeUsed.filter((key) => !declared.has(key))));

  if (undeclaredRuntime.length) {
    findings.push({
      gate: "RUNTIME_VARIABLE_DECLARATION",
      severity: "FAIL",
      detail: `undeclared {{…}} variable(s): ${undeclaredRuntime.join(", ")}`,
    });
  }

  const bracketed = Array.from(new Set(Array.from(audit.matchAll(PLACEHOLDER_BRACKET)).map((match) => match[0])));
  const angle = Array.from(new Set(audit.match(/<<[^<>]+>>/g) ?? []));
  if (bracketed.length || angle.length) {
    findings.push({
      gate: "PLACEHOLDER_AUDIT",
      severity: "FAIL",
      detail: [...bracketed, ...angle].join(", "),
    });
  }

  const lower = audit.toLowerCase();
  const missingGuards = REQUIRED_GUARDS.filter((guard) => !lower.includes(guard));
  if (missingGuards.length) {
    findings.push({
      gate: "GUARDRAIL_COMPLETENESS",
      severity: options.safetyTier ? "FAIL" : "WARN",
      detail: `missing ${missingGuards.join(", ")}`,
    });
  }

  if (options.recursiveTarget && /meta-compiler|compilation depth|\[mem_state\]/i.test(audit)) {
    findings.push({
      gate: "RECURSION_MACHINERY",
      severity: "FAIL",
      detail: "recursive control machinery remains in the prompt",
    });
  }

  if (/\bguarantee[sd]?\b|100% (?:safe|accurate|deterministic)/i.test(audit)) {
    findings.push({
      gate: "CLAIM_DISCIPLINE",
      severity: "WARN",
      detail: "absolute reliability claim detected",
    });
  }

  const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
  if (options.tokenBudget && estimatedTokens > options.tokenBudget) {
    findings.push({
      gate: "TOKEN_BUDGET",
      severity: "FAIL",
      detail: `estimated ${estimatedTokens} exceeds budget ${options.tokenBudget}`,
    });
  }

  return {
    verdict: findings.some((finding) => finding.severity === "FAIL")
      ? "GATE_FAIL"
      : findings.length
        ? "DEGRADED"
        : "PASS",
    findings,
    estimatedTokens,
  };
}

export function formatLint(result: LintResult) {
  const lines = [`VERDICT: ${result.verdict}`, `TOKEN ESTIMATE: ${result.estimatedTokens}`];
  if (result.findings.length === 0) lines.push("All deterministic gates passed.");
  result.findings.forEach((finding) => lines.push(`${finding.severity} · ${finding.gate}: ${finding.detail}`));
  return lines.join("\n");
}
