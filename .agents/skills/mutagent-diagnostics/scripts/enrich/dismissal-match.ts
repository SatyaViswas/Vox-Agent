/**
 * scripts/enrich/dismissal-match.ts
 * DISMISSAL FINAL-CHECK — semantic suppression of previously-dismissed findings.
 * Type A — Pure Script (deterministic; the reasoning VERDICT is INJECTED, not computed here).
 *
 * THE MATCH (operator decision): a new finding is the SAME failure mode as a dismissed
 * one when BOTH hold:
 *   1. entitySlug EXACT match (same diagnosed entity), AND
 *   2. SEMANTIC OVERLAP of the (what, why, where) failure-mode triple.
 *
 * The (what, why, where) prose is LLM-generated and will NEVER string-match run-to-run,
 * so it is NOT exact-matched. Instead a PINNED host-runtime reasoning check (temperature 0,
 * C-PIN) compares the triples and returns { overlap, confidence }. That reasoning runs
 * OUTSIDE this module (the orchestrator dispatches it at the enrich final-check step — see
 * references/workflows/orchestrator-protocol.md), keeping build-render-input's "no LLM, no
 * network, no random" contract intact. This module owns the DETERMINISTIC half:
 *   - buildSemanticMatchRequest() — the pinned, reproducible request the orchestrator sends;
 *   - decideSuppress()            — the ONE deterministic decision fed by the reasoning verdict;
 *   - partitionByDismissal()      — splits findings into active / suppressed, applying the
 *                                   severity-escalation HARD GUARD *before* the semantic match.
 *
 * CONSERVATIVE / FAIL-SAFE: suppress ONLY on high-confidence overlap. When the reasoning
 * check is unsure (missing verdict, low/medium confidence, or overlap:false) the finding is
 * NOT suppressed — it shows. A dismissed finding is hidden only when we are confident it is
 * the same not-an-issue; otherwise the operator sees it.
 */

import type { Finding } from "../normalize/trace.ts";
import type { VerdictLedgerEntry, VerdictSeverity } from "../library/types.ts";

// ── Pinned reasoning envelope (RC-LLM-PIN parity) ────────────────────────────
//
// Mirrors the analyzer/orchestrator inference pin (orchestrator-protocol.md §W13-C):
// model claude-sonnet-4-6 default, temperature 0 unconditional. The C-PIN string binds
// {promptVersion, model, temperature} so the request is byte-identical run-to-run →
// reproducible verdicts. Honors feedback_model_intent_sacred — declared intent, no swap.

/** Default pinned model for the semantic-match reasoning check. */
export const SEMANTIC_MATCH_MODEL = "claude-sonnet-4-6";
/** Temperature is PINNED to 0 (deterministic sampling) — never overridden. */
export const SEMANTIC_MATCH_TEMPERATURE = 0;
/** Prompt version — bump to invalidate cached verdicts when the prompt changes. */
export const SEMANTIC_MATCH_PROMPT_VERSION = "v1";

/**
 * C-PIN — the reproducibility tag binding the pinned inference envelope. A stable,
 * human-readable string so two runs with the same inputs produce byte-identical requests.
 */
export function semanticMatchCPin(model: string = SEMANTIC_MATCH_MODEL): string {
  return `dismissal-semantic-match@${SEMANTIC_MATCH_PROMPT_VERSION}|${model}|t${SEMANTIC_MATCH_TEMPERATURE}`;
}

/** A single failure-mode triple (what / why / where) + optional narration. */
export interface FailureTriple {
  what: string;
  why: string;
  where: string;
  whatHappened?: string;
}

/** The pinned, reproducible request the orchestrator sends to the host-runtime reasoning check. */
export interface SemanticMatchRequest {
  /** Pinned model (RC-LLM-PIN). */
  model: string;
  /** PINNED to 0. */
  temperature: number;
  /** Reproducibility tag (binds prompt-version + model + temperature). */
  cPin: string;
  /** The new finding's failure-mode triple. */
  candidate: FailureTriple;
  /** The dismissed ledger entry's failure-mode triple. */
  dismissed: FailureTriple;
  /** The entity slug both must share (EXACT-match half of the check). */
  entitySlug: string;
  /** The critique-before-verdict instruction (deterministic given the triples). */
  prompt: string;
}

/** The verdict the reasoning check returns — overlap yes/no + confidence. */
export interface SemanticMatchVerdict {
  /** True when the reasoning check judges the two failure modes the SAME. */
  overlap: boolean;
  /** How confident that judgment is. Only "high" + overlap suppresses. */
  confidence: "high" | "medium" | "low";
  /** Optional critique/rationale (audit — not used by the deterministic decision). */
  rationale?: string;
}

/** Build the deterministic critique-before-verdict prompt for one triple pair. */
function buildPrompt(candidate: FailureTriple, dismissed: FailureTriple, entitySlug: string): string {
  const fmt = (t: FailureTriple): string =>
    `  what:  ${t.what}\n  why:   ${t.why}\n  where: ${t.where}` +
    (t.whatHappened ? `\n  whatHappened: ${t.whatHappened}` : "");
  return [
    `You are comparing two agent-diagnostics findings for the SAME entity (${entitySlug}).`,
    `A prior finding was DISMISSED by the operator as "not an issue". A new finding was just produced.`,
    `Decide whether the NEW finding describes the SAME underlying failure mode as the DISMISSED one.`,
    ``,
    `DISMISSED finding (failure-mode triple):`,
    fmt(dismissed),
    ``,
    `NEW finding (failure-mode triple):`,
    fmt(candidate),
    ``,
    `First CRITIQUE the comparison (what matches, what differs — surface wording differs run-to-run,`,
    `so judge the MEANING, not the phrasing). Then return a verdict:`,
    `- overlap: true ONLY if it is the same failure mode (same what happening for the same reason at the same place).`,
    `- confidence: "high" | "medium" | "low".`,
    `Be CONSERVATIVE: reserve "high" for an unambiguous same-failure-mode match. When unsure, do NOT claim high.`,
  ].join("\n");
}

/**
 * Build the pinned, reproducible semantic-match request for one (candidate, dismissed) pair.
 * Deterministic — same inputs ⇒ byte-identical request (the reproducibility guarantee).
 */
export function buildSemanticMatchRequest(
  candidate: FailureTriple,
  dismissed: FailureTriple,
  entitySlug: string,
  model: string = SEMANTIC_MATCH_MODEL
): SemanticMatchRequest {
  return {
    model,
    temperature: SEMANTIC_MATCH_TEMPERATURE,
    cPin: semanticMatchCPin(model),
    candidate,
    dismissed,
    entitySlug,
    prompt: buildPrompt(candidate, dismissed, entitySlug),
  };
}

/**
 * THE ONE deterministic decision fed by the reasoning verdict. CONSERVATIVE / fail-safe:
 * suppress ONLY on high-confidence overlap. Anything else (no verdict, overlap:false,
 * medium/low confidence) → do NOT suppress (the finding shows).
 */
export function decideSuppress(verdict: SemanticMatchVerdict | undefined): boolean {
  if (!verdict) return false;
  return verdict.overlap === true && verdict.confidence === "high";
}

// ── Severity-escalation HARD GUARD ───────────────────────────────────────────

/** Severity rank (crit > high > med > info) — same order the renderer's badges use. */
const SEVERITY_RANK: Readonly<Record<VerdictSeverity, number>> = {
  crit: 3,
  high: 2,
  med: 1,
  info: 0,
};

/** Rank a severity; an unknown/undefined severity ranks lowest (info). */
export function severityRank(sev: VerdictSeverity | undefined): number {
  return sev ? (SEVERITY_RANK[sev] ?? 0) : 0;
}

/**
 * True when a finding's CURRENT severity materially EXCEEDS the severity it was dismissed
 * at — a dismissed-but-now-worse finding. When escalated, the finding is NEVER suppressed
 * (it re-surfaces) regardless of any semantic overlap. This is the HARD GUARD and it runs
 * BEFORE the semantic match.
 */
export function isSeverityEscalated(
  current: VerdictSeverity | undefined,
  atDismissal: VerdictSeverity
): boolean {
  return severityRank(current) > severityRank(atDismissal);
}

// ── VerdictLookup — the injected reasoning-verdict map ────────────────────────

/** Stable key identifying one dismissed ledger entry (matches store.ts verdictKey). */
export function dismissalEntryKey(entry: VerdictLedgerEntry): string {
  return `${entry.verdict}:${entry.runId}:${entry.findingId}`;
}

/** Lookup key for the verdict of (this new finding × this dismissed entry). */
export function verdictLookupKey(findingId: string, entry: VerdictLedgerEntry): string {
  return `${findingId}::${dismissalEntryKey(entry)}`;
}

/** The injected map of reasoning verdicts, keyed by verdictLookupKey(). */
export type VerdictLookup = Readonly<Record<string, SemanticMatchVerdict>>;

// ── The partition (pure, deterministic) ──────────────────────────────────────

/** One suppressed finding + the dismissed entry + verdict that suppressed it (audit). */
export interface SuppressionRecord {
  finding: Finding;
  matchedEntry: VerdictLedgerEntry;
  verdict: SemanticMatchVerdict;
}

export interface DismissalPartitionResult {
  /** Findings that SHOW in the report (not suppressed). */
  active: Finding[];
  /** Findings REMOVED from the report (matched a valid dismissal at high confidence). */
  suppressed: SuppressionRecord[];
}

export interface PartitionOptions {
  /** The diagnosed entity's slug — the EXACT-match gate for the final-check. */
  entitySlug: string;
}

/**
 * Split findings into active (shown) vs suppressed (removed from the report), applying the
 * dismissal final-check DETERMINISTICALLY given the injected reasoning verdicts.
 *
 * Per finding, for each dismissed entry of the SAME entity (entitySlug EXACT):
 *   1. HARD GUARD FIRST — if the finding's current severity escalated beyond the entry's
 *      severityAtDismissal, this entry can NEVER suppress it (skip the entry). A
 *      dismissed-but-now-worse finding always re-surfaces, regardless of overlap.
 *   2. else consult the injected reasoning verdict; suppress iff decideSuppress() (high-
 *      confidence overlap). The FIRST qualifying entry suppresses the finding.
 *
 * Fail-safe: `dismissedEntries` empty (no library / no dismissals) ⇒ every finding is
 * active (a no-op). Deterministic: input order is preserved; no clock, no random.
 */
export function partitionByDismissal(
  findings: Finding[],
  dismissedEntries: VerdictLedgerEntry[],
  verdicts: VerdictLookup,
  opts: PartitionOptions
): DismissalPartitionResult {
  const candidates = dismissedEntries.filter((e) => e.entitySlug === opts.entitySlug);
  const active: Finding[] = [];
  const suppressed: SuppressionRecord[] = [];

  for (const finding of findings) {
    let hit: SuppressionRecord | undefined;
    for (const entry of candidates) {
      // 1. Severity-escalation HARD GUARD — runs BEFORE the semantic match.
      if (isSeverityEscalated(finding.severity, entry.severityAtDismissal)) continue;
      // 2. Semantic overlap (injected reasoning verdict), conservative decision.
      const verdict = verdicts[verdictLookupKey(finding.findingId, entry)];
      if (decideSuppress(verdict)) {
        // decideSuppress guarantees verdict is defined here.
        hit = { finding, matchedEntry: entry, verdict: verdict as SemanticMatchVerdict };
        break;
      }
    }
    if (hit) suppressed.push(hit);
    else active.push(finding);
  }

  return { active, suppressed };
}

/** Extract a finding's failure-mode triple (for building a match request). */
export function findingTriple(finding: Finding): FailureTriple {
  return {
    what: finding.failureOrigin.what,
    why: finding.failureOrigin.why,
    where: finding.failureOrigin.where,
    whatHappened: finding.failureOrigin.whatHappened,
  };
}

/** Extract a dismissed ledger entry's failure-mode triple. */
export function entryTriple(entry: VerdictLedgerEntry): FailureTriple {
  return {
    what: entry.what,
    why: entry.why,
    where: entry.where,
    whatHappened: entry.whatHappened,
  };
}
