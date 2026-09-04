/**
 * scripts/merge-criteria.ts — the `*discover` near-duplicate MERGE (no data loss).
 * ---------------------------------------------------------------------------
 * Two mined categories can mean the SAME thing under different ids
 * (`send-integrity` vs `payload-well-formed-on-send`) and today both enter the
 * living suite, so the operator reads two recommendations for one behaviour.
 * This module collapses the provably-same ones and SURFACES the rest.
 *
 * It merges at the ANNOTATION level, not the criterion level. That is the whole
 * trick: rewriting an absorbed category's annotations onto the survivor lets
 * `deriveMinedCriteria` recompute support, prevalence, refs, grounding and
 * severity over the UNION set from real per-trace evidence — instead of
 * hand-recombining already-derived strings ("2/5 sampled" + "1/4 sampled" is not
 * a number you can add). Nothing is discarded anywhere in the path.
 *
 * ── WHY A TUNED THRESHOLD IS NOT ENOUGH (measured, 32 synthetic pairs) ───────
 * The inherited `dedupNearQueries` threshold of 0.8 does NOT transfer from
 * dataset queries to criterion statements: statements are longer, share a
 * `Pass = ` prefix and a large functional vocabulary, so genuine restatements
 * land at j≈0.33–0.75 and 0.8 catches only word-order permutations (2/16).
 *
 * Worse, the two distributions OVERLAP COMPLETELY — these all score at or above
 * a genuine restatement while being genuinely DIFFERENT criteria:
 *   consent before STORING ‖ before SHARING          j=0.714
 *   cites AT LEAST one doc ‖ AT MOST one doc         j=0.667
 *   payload INCLUDES acct  ‖ EXCLUDES acct           j=0.600
 *   escalation for BILLING ‖ for TECHNICAL           j=0.600
 *   tool called BEFORE     ‖ AFTER the summary       j=0.600
 * A bag of words cannot see a polarity, scope or noun inversion: the one word
 * that flips the meaning is a single token among many, and frequently a
 * stopword. At j≥0.5 plain Jaccard false-merges 3/16 of them — and a false merge
 * DESTROYS a real criterion, the exact data loss this work forbids.
 *
 * So similarity alone never decides. Two deterministic GUARDS do:
 *   1. contrastive-marker parity — NEG · BEFORE · AFTER · MIN · MAX · EXACT ·
 *      ALL · SOME. Differing marker sets ⇒ BLOCKED.
 *   2. no 1-for-1 substitution — each side holding exactly one content token the
 *      other lacks is a swapped noun/verb, not a rephrasing ⇒ BLOCKED.
 * With both guards: ZERO false merges at every threshold from 0.4 to 0.8 across
 * all 16 distinct pairs (incl. the 8 adversarial near-vocabulary ones).
 *
 * A blocked pair is NOT dropped and NOT merged — it is reported as a
 * `NearDuplicateFinding` so the reader sees the suspected redundancy and rules
 * on it. Per the operator: when merging would misrepresent the evidence, that is
 * a FINDING, never a silent merge.
 *
 * NO LLM anywhere in this path. PURE + deterministic — no clock, no random, no
 * network; the same annotations always yield the same plan (C-PIN).
 */
import { fnv1aHex, jaccard } from "./build-dataset.ts";
import type { TraceAnnotation } from "./discover-criteria.ts";
import {
  OutcomeVerdict,
  Severity,
  type DiscoveryRef,
  type MinedCriterion,
  type SeverityValue,
} from "./contracts/eval-types.ts";
import { assertMonotonicGrowth, type LivingSuite } from "./living-suite.ts";
import type { CodeEvalSpec } from "./code-eval.ts";

/**
 * The DEFAULT similarity floor for a merge candidate. Chosen at 0.4 — the
 * measured floor at which the two guards still hold false merges at ZERO while
 * recall of the safely-collapsible class is highest. The threshold is NOT what
 * makes the merge safe (the guards are); it only bounds how far down the
 * candidate band is worth reading. Below ~0.4 the findings list fills with
 * unrelated pairs without yielding further safe merges.
 */
export const DEFAULT_MERGE_THRESHOLD = 0.4;

/**
 * Stopwords for statement similarity. Deliberately EXCLUDES the contrastive
 * words (not/never/no/before/after/only/all/any…): those are load-bearing for
 * meaning and are handled by the marker guard, not thrown away here.
 */
const STATEMENT_STOPWORDS = new Set([
  "pass", "fail", "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "while", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "as", "that", "this", "these", "those", "it", "its", "has", "have",
  "had", "does", "do", "did", "so", "such", "than", "there", "their", "they", "he",
  "she", "we", "you", "i", "must", "should", "shall", "will", "can", "may", "when",
]);

/**
 * Canonical CONTRASTIVE MARKERS. Each bucket collects the surface forms that
 * mean the same thing (`before`/`prior`/`until`), so a true restatement that
 * swaps one for another still matches, while a genuine inversion does not.
 */
const CONTRASTIVE_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/\b(not|never|no|none|without|exclude|excludes|excluding|forbidden)\b/, "NEG"],
  [/\b(before|prior|preceding|until)\b/, "BEFORE"],
  [/\b(after|once|following|subsequent|subsequently)\b/, "AFTER"],
  [/\bat least\b|\bno fewer than\b/, "MIN"],
  [/\bat most\b|\bno more than\b|\bup to\b/, "MAX"],
  [/\b(only|exactly|solely)\b/, "EXACT"],
  [/\b(always|all|every)\b/, "ALL"],
  [/\b(any|some)\b/, "SOME"],
];

/** Strip the binary-statement preamble (`Pass = …`) + lowercase. PURE. */
function normalizeStatement(statement: string): string {
  return statement.toLowerCase().replace(/^\s*pass\s*[=:]\s*/, "");
}

/**
 * The content-token set of a criterion statement: normalized, stopword-filtered,
 * single characters dropped. Stripping the `Pass = ` prefix is MANDATORY — left
 * in, it inflates every pair by a shared constant and the restatement/distinct
 * separation measures NEGATIVE. PURE.
 */
export function statementTokens(statement: string): Set<string> {
  return new Set(
    normalizeStatement(statement)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STATEMENT_STOPWORDS.has(t)),
  );
}

/** The contrastive markers a statement carries (canonical buckets). PURE. */
export function contrastiveMarkers(statement: string): Set<string> {
  const padded = ` ${normalizeStatement(statement)} `;
  const out = new Set<string>();
  for (const [re, tag] of CONTRASTIVE_MARKERS) if (re.test(padded)) out.add(tag);
  return out;
}

/**
 * Token-Jaccard similarity of two criterion statements, in [0,1]. Reuses the
 * PROVEN `jaccard` primitive from the dataset near-dup filter — same maths, a
 * statement-tuned tokenizer. PURE.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  READ THIS BEFORE CHANGING THE THRESHOLD OR DELETING A GUARD.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The obvious change here is "just raise/lower the number". That is the exact
 * move that was measured and REJECTED. This score is NOT a decision function.
 *
 * MEASUREMENT — 32 hand-built synthetic pairs (16 genuine restatements of one
 * behaviour, 16 genuinely-distinct criteria, 8 of those adversarial look-alikes),
 * normalization = strip `Pass = ` + stopwords:
 *
 *   threshold 0.8 (inherited from dedupNearQueries) → 2/16 restatements caught.
 *     It does not transfer: dataset QUERIES are short and noun-heavy; criterion
 *     STATEMENTS are long, share a `Pass = ` preamble and a big functional
 *     vocabulary, so real restatements land at j≈0.33–0.75, not ≥0.8.
 *
 *   AND — the load-bearing result — the two distributions OVERLAP COMPLETELY.
 *   These are GENUINELY DIFFERENT criteria, scoring at or above real restatements:
 *
 *     "Pass = the payload INCLUDES the account number"
 *     "Pass = the payload EXCLUDES the account number"          j = 0.600
 *        ↑ two opposite checks — and 0.600 is ABOVE this real restatement:
 *     "Pass = a transient send failure schedules a retry"
 *     "Pass = a transient failure on send is retried"           j = 0.500
 *
 *     "…asks for consent before STORING data" ‖ "before SHARING"  j = 0.714
 *     "…cites AT LEAST one document"          ‖ "AT MOST one"     j = 0.667
 *     "…the tool is called BEFORE the summary"‖ "AFTER"           j = 0.600
 *
 *   There is therefore NO threshold at which similarity alone is safe. At j≥0.5
 *   plain Jaccard false-merges 3/16 of the distinct pairs — and a false merge
 *   DESTROYS a real criterion while the report asserts redundancy was handled.
 *   A bag of words cannot see a polarity/scope/noun inversion: the one word that
 *   flips the meaning is a single token among many, and often a stopword.
 *
 * WHAT ACTUALLY HOLDS THE LINE — the two guards below, not this number:
 *   GUARD 1 contrastive-marker parity  (NEG·BEFORE·AFTER·MIN·MAX·EXACT·ALL·SOME)
 *   GUARD 2 no 1-for-1 content substitution (billing↔technical, retried↔escalated)
 * With BOTH: ZERO false merges at EVERY threshold from 0.4 to 0.8, across all 16
 * distinct pairs including the 8 adversarial ones. The threshold only bounds how
 * far down the candidate band is worth reading; the guards decide.
 *
 * So: if you raise this number you lose safe merges and gain nothing. If you
 * lower it you gain findings-list noise. If you DELETE A GUARD you reintroduce
 * silent criterion destruction. Re-run the corpus in
 * `tests/merge-criteria.test.ts` (describe "NEGATIVE — genuinely different
 * criteria must NOT merge") before touching any of it.
 */
export function statementSimilarity(a: string, b: string): number {
  return jaccard(statementTokens(a), statementTokens(b));
}

/** Set equality over the marker buckets. PURE. */
function sameMarkers(a: string, b: string): boolean {
  const ma = contrastiveMarkers(a);
  const mb = contrastiveMarkers(b);
  if (ma.size !== mb.size) return false;
  for (const t of ma) if (!mb.has(t)) return false;
  return true;
}

/** The tokens each statement holds that the other does not. PURE. */
function tokenDelta(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const ta = statementTokens(a);
  const tb = statementTokens(b);
  return {
    onlyA: [...ta].filter((t) => !tb.has(t)),
    onlyB: [...tb].filter((t) => !ta.has(t)),
  };
}

/** Why a near-duplicate pair was NOT merged. Each kind is a real, surfaced finding. */
export const NearDuplicateKind = {
  /** the statements disagree on a polarity / ordering / quantifier marker. */
  ContrastiveMarkers: "contrastive-markers",
  /** exactly one content word was swapped on each side — a different subject. */
  OneForOneSubstitution: "one-for-one-substitution",
  /** the SAME trace is labelled differently by the two categories. */
  LabelConflict: "label-conflict",
  /** both carry an executable code-check and the two specs differ. */
  CodeEvalConflict: "code-eval-conflict",
} as const;
export type NearDuplicateKindValue = (typeof NearDuplicateKind)[keyof typeof NearDuplicateKind];

/**
 * One side of a near-duplicate pair, carried VERBATIM so a human can rule on the
 * pair without re-opening the run that produced it.
 */
export interface NearDuplicateSide {
  id: string;
  /** the binary statement, verbatim — never truncated, never re-worded. */
  statement: string;
  /** honest `k/n` over the traces this side annotated. */
  prevalence: string;
  /** the traces this side was seen on. */
  traceIds: string[];
  /** this side's structured grounding refs. */
  refs: DiscoveryRef[];
}

/** A pair that LOOKS redundant but was deliberately kept apart — reported, never dropped. */
export interface NearDuplicateFinding {
  /** the first-seen criterion id of the pair. */
  a: string;
  /** the later criterion id of the pair. */
  b: string;
  similarity: number;
  kind: NearDuplicateKindValue;
  /**
   * The crisp "which guard, on what" line — e.g. `marker parity: [BEFORE] vs
   * [AFTER]`. This is the part that tells a reader at a glance that the pair is
   * a REAL distinction rather than a wording accident.
   */
  guardSummary: string;
  /** the concrete evidence for the block (which markers, which tokens, which trace). */
  detail: string;
  /** BOTH sides verbatim + their evidence — what a human needs to rule. */
  sides: [NearDuplicateSide, NearDuplicateSide];
}

/** One applied merge: the surviving id + everything folded into it. */
export interface CriterionMerge {
  /** the FIRST-SEEN id — it survives (operator ruling). */
  survivor: string;
  /** absorbed ids, in first-seen order. Kept as aliases; never dropped. */
  absorbed: string[];
  /** per-absorbed similarity to the survivor, index-aligned with `absorbed`. */
  similarity: number[];
  /** the statement carried forward (the most specific of the group). */
  statement: string;
  /** the severity carried forward (the strongest present, else left to derivation). */
  severity?: SeverityValue;
}

export interface MergePlan {
  merges: CriterionMerge[];
  findings: NearDuplicateFinding[];
  threshold: number;
}

/** A category as seen across its annotations — the unit the plan reasons over. */
interface CategoryView {
  id: string;
  statement: string;
  severity?: SeverityValue;
  codeEval?: CodeEvalSpec;
  /** traceId → label, for the label-conflict guard. */
  labels: Map<string, string>;
  /** this category's structured refs, in first-seen order (deduped). */
  refs: DiscoveryRef[];
}

/** Project a category view into the verbatim side a pending decision carries. */
function sideOf(v: CategoryView): NearDuplicateSide {
  const fails = [...v.labels.values()].filter((l) => l === OutcomeVerdict.Fail).length;
  return {
    id: v.id,
    statement: v.statement,
    prevalence: `${fails}/${v.labels.size} sampled`,
    traceIds: [...v.labels.keys()],
    refs: v.refs,
  };
}

const SEVERITY_RANK: Record<string, number> = {
  [Severity.Crit]: 4,
  [Severity.High]: 3,
  [Severity.Med]: 2,
  [Severity.Low]: 1,
};

/** The stronger of two severities (absent loses to present). PURE. */
function strongerSeverity(a?: SeverityValue, b?: SeverityValue): SeverityValue | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b;
}

/**
 * The MORE SPECIFIC of two statements: more content tokens wins; ties break on
 * the longer string, then on the incumbent (the survivor's). Deterministic —
 * never a coin flip, never an LLM judgement. PURE.
 */
function moreSpecific(incumbent: string, challenger: string): string {
  const ni = statementTokens(incumbent).size;
  const nc = statementTokens(challenger).size;
  if (nc > ni) return challenger;
  if (nc < ni) return incumbent;
  return challenger.length > incumbent.length ? challenger : incumbent;
}

/** Collect one view per category, in FIRST-APPEARANCE order (the survivor order). */
function categoryViews(annotations: TraceAnnotation[]): CategoryView[] {
  const views = new Map<string, CategoryView>();
  for (const a of annotations) {
    if (a.category === undefined || a.category.length === 0) continue;
    let v = views.get(a.category);
    if (v === undefined) {
      v = { id: a.category, statement: a.statement ?? "", labels: new Map(), refs: [] };
      views.set(a.category, v);
    }
    if (v.statement.length === 0 && a.statement !== undefined) v.statement = a.statement;
    if (v.severity === undefined && a.severity !== undefined) v.severity = a.severity;
    if (v.codeEval === undefined && a.codeEval !== undefined) v.codeEval = a.codeEval;
    if (!v.labels.has(a.traceId)) v.labels.set(a.traceId, a.label);
    for (const r of a.refs ?? []) {
      if (!v.refs.some((x) => x.obs === r.obs && x.path === r.path && x.value === r.value)) v.refs.push(r);
    }
  }
  return [...views.values()];
}

/** The first trace the two categories label DIFFERENTLY, if any. PURE. */
function conflictingLabel(a: CategoryView, b: CategoryView): { traceId: string; a: string; b: string } | null {
  for (const [traceId, label] of a.labels) {
    const other = b.labels.get(traceId);
    if (other !== undefined && other !== label) return { traceId, a: label, b: other };
  }
  return null;
}

/** Stable structural equality for two code-eval specs (key order-insensitive). PURE. */
function sameCodeEval(a: CodeEvalSpec, b: CodeEvalSpec): boolean {
  const canon = (s: CodeEvalSpec): string =>
    JSON.stringify(
      Object.fromEntries(Object.entries(s as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))),
    );
  return canon(a) === canon(b);
}

/**
 * PLAN the near-duplicate merges over a batch of annotations. Compares every
 * not-yet-absorbed category against each surviving earlier one, in first-seen
 * order, so the FIRST-SEEN id always survives and the plan is order-stable.
 *
 * A pair at or above `threshold` is either MERGED (both guards clear, evidence
 * compatible) or recorded as a `NearDuplicateFinding` — never silently dropped
 * and never silently merged. Pairs below the threshold are simply unrelated.
 *
 * Comparison always uses the ORIGINAL survivor statement, not the merged-forward
 * one, so the plan does not depend on the order merges are applied. PURE.
 */
export function planCriterionMerges(
  annotations: TraceAnnotation[],
  opts: { threshold?: number } = {},
): MergePlan {
  const threshold = opts.threshold ?? DEFAULT_MERGE_THRESHOLD;
  const views = categoryViews(annotations);
  const absorbed = new Set<string>();
  const merges = new Map<string, CriterionMerge>();
  const findings: NearDuplicateFinding[] = [];

  for (let i = 0; i < views.length; i++) {
    const survivor = views[i]!;
    if (absorbed.has(survivor.id)) continue; // already folded into an earlier survivor
    for (let j = i + 1; j < views.length; j++) {
      const other = views[j]!;
      if (absorbed.has(other.id)) continue;
      // an empty statement carries no signal — never merge on nothing.
      if (survivor.statement.length === 0 || other.statement.length === 0) continue;
      const similarity = statementSimilarity(survivor.statement, other.statement);
      if (similarity < threshold) continue;

      // ── GUARD 1 — contrastive-marker parity (polarity / ordering / quantifier).
      if (!sameMarkers(survivor.statement, other.statement)) {
        const ma = [...contrastiveMarkers(survivor.statement)].sort();
        const mb = [...contrastiveMarkers(other.statement)].sort();
        findings.push({
          a: survivor.id,
          b: other.id,
          similarity,
          kind: NearDuplicateKind.ContrastiveMarkers,
          guardSummary: `marker parity: [${ma.join(", ") || "none"}] vs [${mb.join(", ") || "none"}]`,
          detail:
            `wording is ${Math.round(similarity * 100)}% alike but the statements disagree on a contrastive marker ` +
            `(${survivor.id}: [${ma.join(", ") || "none"}] vs ${other.id}: [${mb.join(", ") || "none"}]) — ` +
            "a negation / ordering / quantifier flip changes what is being checked, so these are kept apart.",
          sides: [sideOf(survivor), sideOf(other)],
        });
        continue;
      }

      // ── GUARD 2 — a 1-for-1 content-word swap is a different subject, not a rephrasing.
      const delta = tokenDelta(survivor.statement, other.statement);
      if (delta.onlyA.length === 1 && delta.onlyB.length === 1) {
        findings.push({
          a: survivor.id,
          b: other.id,
          similarity,
          kind: NearDuplicateKind.OneForOneSubstitution,
          guardSummary: `one word swapped: "${delta.onlyA[0]}" vs "${delta.onlyB[0]}"`,
          detail:
            `wording is ${Math.round(similarity * 100)}% alike but exactly one word is swapped ` +
            `("${delta.onlyA[0]}" vs "${delta.onlyB[0]}") — a single substituted term usually names a ` +
            "different subject, so these are kept apart for review rather than merged.",
          sides: [sideOf(survivor), sideOf(other)],
        });
        continue;
      }

      // ── GUARD 3 — the evidence itself disagrees: same trace, different label.
      const clash = conflictingLabel(survivor, other);
      if (clash !== null) {
        findings.push({
          a: survivor.id,
          b: other.id,
          similarity,
          kind: NearDuplicateKind.LabelConflict,
          guardSummary: `evidence disagrees on trace '${clash.traceId}': ${clash.a} vs ${clash.b}`,
          detail:
            `wording is ${Math.round(similarity * 100)}% alike but trace '${clash.traceId}' is labelled ` +
            `'${clash.a}' by ${survivor.id} and '${clash.b}' by ${other.id} — merging would claim one trace ` +
            "both passed and failed the same check, so the disagreement is surfaced instead.",
          sides: [sideOf(survivor), sideOf(other)],
        });
        continue;
      }

      // ── GUARD 4 — two DIFFERENT executable checks are not one check.
      if (
        survivor.codeEval !== undefined &&
        other.codeEval !== undefined &&
        !sameCodeEval(survivor.codeEval, other.codeEval)
      ) {
        findings.push({
          a: survivor.id,
          b: other.id,
          similarity,
          kind: NearDuplicateKind.CodeEvalConflict,
          guardSummary: `different code-checks: ${survivor.codeEval.primitive} vs ${other.codeEval.primitive}`,
          detail:
            `wording is ${Math.round(similarity * 100)}% alike but the two carry DIFFERENT executable ` +
            `code-checks (${survivor.codeEval.primitive} vs ${other.codeEval.primitive}) — merging would have to ` +
            "discard one runnable spec, so both are kept.",
          sides: [sideOf(survivor), sideOf(other)],
        });
        continue;
      }

      // ── MERGE: first-seen id survives; the pair is provably the same check.
      const existing = merges.get(survivor.id);
      const merge: CriterionMerge = existing ?? {
        survivor: survivor.id,
        absorbed: [],
        similarity: [],
        statement: survivor.statement,
        ...(survivor.severity !== undefined ? { severity: survivor.severity } : {}),
      };
      merge.absorbed.push(other.id);
      merge.similarity.push(similarity);
      merge.statement = moreSpecific(merge.statement, other.statement);
      const sev = strongerSeverity(merge.severity, other.severity);
      if (sev !== undefined) merge.severity = sev;
      merges.set(survivor.id, merge);
      absorbed.add(other.id);
    }
  }
  return { merges: [...merges.values()], findings, threshold };
}

/**
 * APPLY a merge plan to the annotations: absorbed categories are RELABELLED onto
 * their survivor, and the group's carried-forward statement / severity /
 * judgeKind are stamped on every member so `deriveMinedCriteria`'s
 * first-defined pick is the DECIDED value rather than an accident of order.
 *
 * Everything else is left to derivation, which is the point: support, prevalence
 * (k/n), refs, grounding and confidence are all recomputed from the real union
 * of per-trace evidence, so no string is ever hand-recombined.
 *
 * NO ANNOTATION IS DROPPED. Where the two merged categories both annotated the
 * SAME trace, the pair is folded into one annotation whose `refs` is the UNION
 * of both (deduped by exact `obs|path|value`), because counting one trace twice
 * would inflate the prevalence denominator and misreport the evidence. That fold
 * applies ONLY inside a merged group — with no merges the output is
 * byte-identical to the input (zero behaviour change).
 *
 * A judge-class survivor that absorbs a criterion carrying a `codeEval` is
 * promoted to `hybrid` (code pre-filter + judge) rather than losing the runnable
 * spec — that is exactly what the two leaves jointly observed, and it keeps
 * `lint-uniformity` satisfied (a judge row may not carry a codeEval). PURE.
 */
export function applyCriterionMerges(
  annotations: TraceAnnotation[],
  plan: MergePlan,
): TraceAnnotation[] {
  if (plan.merges.length === 0) return annotations;

  const survivorOf = new Map<string, CriterionMerge>();
  for (const m of plan.merges) {
    survivorOf.set(m.survivor, m);
    for (const id of m.absorbed) survivorOf.set(id, m);
  }

  // the judgeKind each merged group carries forward (survivor's, promoted when a
  // runnable code-check arrives from an absorbed judge-class sibling).
  const judgeKindOf = new Map<string, string>();
  const groupHasCodeEval = new Map<string, boolean>();
  for (const a of annotations) {
    const m = a.category !== undefined ? survivorOf.get(a.category) : undefined;
    if (m === undefined) continue;
    if (a.category === m.survivor && a.judgeKind !== undefined && !judgeKindOf.has(m.survivor)) {
      judgeKindOf.set(m.survivor, a.judgeKind);
    }
    if (a.codeEval !== undefined) groupHasCodeEval.set(m.survivor, true);
  }
  for (const [survivor, kind] of judgeKindOf) {
    if (kind === "llm-judge" && groupHasCodeEval.get(survivor) === true) {
      judgeKindOf.set(survivor, "hybrid");
    }
  }

  const out: TraceAnnotation[] = [];
  /** `${survivorId} ${traceId}` → index into `out`, for the same-trace fold. */
  const foldIndex = new Map<string, number>();

  for (const a of annotations) {
    const m = a.category !== undefined ? survivorOf.get(a.category) : undefined;
    if (m === undefined) {
      out.push(a); // untouched category — byte-identical passthrough
      continue;
    }
    const kind = judgeKindOf.get(m.survivor);
    const rewritten: TraceAnnotation = {
      ...a,
      category: m.survivor,
      statement: m.statement,
      ...(m.severity !== undefined ? { severity: m.severity } : {}),
      ...(kind !== undefined ? { judgeKind: kind as TraceAnnotation["judgeKind"] } : {}),
    };
    const key = `${m.survivor} ${a.traceId}`;
    const at = foldIndex.get(key);
    if (at === undefined) {
      foldIndex.set(key, out.length);
      out.push(rewritten);
      continue;
    }
    // SAME (survivor, trace) seen twice — fold, unioning the evidence refs so the
    // absorbed category's grounding survives while the trace is counted once.
    const kept = out[at]!;
    const refs = [...(kept.refs ?? [])];
    const seen = new Set(refs.map((r) => `${r.obs}|${r.path}|${r.value}`));
    for (const r of rewritten.refs ?? []) {
      const k = `${r.obs}|${r.path}|${r.value}`;
      if (!seen.has(k)) {
        seen.add(k);
        refs.push(r);
      }
    }
    out[at] = {
      ...kept,
      ...(refs.length > 0 ? { refs } : {}),
      // keep the incumbent's note/pointer; adopt the absorbed one only to fill a gap.
      ...(kept.note === undefined && rewritten.note !== undefined ? { note: rewritten.note } : {}),
      ...(kept.evidencePointer === undefined && rewritten.evidencePointer !== undefined
        ? { evidencePointer: rewritten.evidencePointer }
        : {}),
      ...(kept.codeEval === undefined && rewritten.codeEval !== undefined
        ? { codeEval: rewritten.codeEval }
        : {}),
    };
  }
  return out;
}

/**
 * Stamp the merge PROVENANCE onto the derived criteria: `mergedFrom` (what was
 * absorbed) + `aliases` (the absorbed ids, kept resolvable so an older report or
 * dataset recipe naming the pre-merge id still finds its criterion). Criteria
 * that absorbed nothing are returned untouched. PURE.
 */
export function stampMergeProvenance(
  criteria: MinedCriterion[],
  plan: MergePlan,
): MinedCriterion[] {
  if (plan.merges.length === 0) return criteria;
  const bySurvivor = new Map(plan.merges.map((m) => [m.survivor, m]));
  return criteria.map((c) => {
    const m = bySurvivor.get(c.id);
    if (m === undefined) return c;
    const aliases = [...new Set([...(c.aliases ?? []), ...m.absorbed])];
    return { ...c, mergedFrom: [...m.absorbed], aliases };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PENDING NEAR-DUPLICATE DECISIONS — "nothing destroyed · nothing forgotten"
// ════════════════════════════════════════════════════════════════════════════
//
// The guards above refuse to merge a look-alike pair whenever merging could
// misrepresent it. Drawing that refusal only in the report would mean the
// finding dies when the reader closes the tab, and the NEXT run would re-derive
// the same pair as if it had never been seen. So a blocked pair becomes a
// DURABLE PENDING DECISION carried in the suite data:
//
//   - STABLE IDENTITY — the same pair keeps the same `id` across runs (derived
//     from the two criterion ids, order-independent), so it is recognisably the
//     same open question rather than a fresh discovery each time.
//   - IT STAYS UNTIL RULED — a pending decision is never dropped, not even on a
//     run where the pair does not resurface. Monotonic, like the suite itself.
//   - A RULING IS NEVER OVERWRITTEN — once a human rules, later runs refresh the
//     evidence but leave the verdict alone.
//
// ⚠️ NOT-YET-WIRED SURFACE (deliberate, named): NOTHING in this skill consumes a
// ruling yet. Recording a decision is implemented here; APPLYING one (acting on
// `merge-approved`, propagating it into the suite, retiring the pair) belongs to
// the W4 review→validate→CALIBRATE loop, which is not built. The data shape is
// defined now so the calibration loop has something to read; a half-built apply
// path here would be worse than none. The report says so in plain words rather
// than implying a loop exists.

/** Where a near-duplicate pair stands. Only `pending` is produced by this module. */
export const NearDuplicateStatus = {
  /** surfaced, awaiting a human ruling. The ONLY status `*discover` writes. */
  Pending: "pending",
  /** RULED: the pair really is one check — the calibration loop may merge them. */
  MergeApproved: "merge-approved",
  /** RULED: genuinely different criteria; stop surfacing this pair. */
  KeptDistinct: "kept-distinct",
} as const;
export type NearDuplicateStatusValue =
  (typeof NearDuplicateStatus)[keyof typeof NearDuplicateStatus];

/** One durable, human-rulable near-duplicate decision. */
export interface NearDuplicateDecision {
  /** STABLE across runs — derived from the pair, order-independent. */
  id: string;
  /** the pair, sorted, so the identity does not depend on mining order. */
  pair: [string, string];
  status: NearDuplicateStatusValue;
  /** which guard blocked the merge. */
  kind: NearDuplicateKindValue;
  /** the crisp "marker parity: [BEFORE] vs [AFTER]" line. */
  guardSummary: string;
  detail: string;
  /** the most recent similarity measured for this pair. */
  similarity: number;
  /** BOTH statements verbatim + both evidence sets — enough to rule offline. */
  sides: [NearDuplicateSide, NearDuplicateSide];
  /** how many runs have surfaced this pair. A clock-free recurrence signal. */
  timesSurfaced: number;
  /** set ONLY by the (unbuilt) calibration loop — never by `*discover`. */
  ruling?: { by: string; note: string };
}

/** The durable ledger of open (and ruled) near-duplicate questions. */
export interface NearDuplicateLedger {
  decisions: NearDuplicateDecision[];
  /** a pure counter, bumped per recording pass (NO clock — byte-identity). */
  version: number;
}

/** A fresh empty ledger. PURE. */
export function emptyNearDuplicateLedger(): NearDuplicateLedger {
  return { decisions: [], version: 0 };
}

/**
 * The STABLE id of a near-duplicate pair: order-independent (sorting the two ids
 * first, so `a~b` and `b~a` are one question) and content-derived via the same
 * FNV-1a the dataset ids use — no clock, no random, so the same pair yields the
 * same id in every run forever. PURE.
 */
export function nearDuplicateId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `nd-${fnv1aHex(`${x}::${y}`)}`;
}

/**
 * Fold this run's blocked look-alikes into the durable ledger.
 *
 * MONOTONIC — every prior decision is retained in its original order, whether or
 * not it resurfaced this run ("nothing forgotten"). A pair already present is
 * REFRESHED in place (latest similarity + evidence, `timesSurfaced` bumped) and
 * keeps its id, so it reads as the same open question rather than a new
 * discovery. A pair already RULED keeps its ruling and status untouched — this
 * function never re-opens or overwrites a human decision. PURE.
 */
export function recordNearDuplicateFindings(
  ledger: NearDuplicateLedger,
  findings: readonly NearDuplicateFinding[],
): NearDuplicateLedger {
  const byId = new Map(ledger.decisions.map((d) => [d.id, d]));
  const out: NearDuplicateDecision[] = ledger.decisions.map((d) => ({ ...d }));
  const indexOf = new Map(out.map((d, i) => [d.id, i]));

  for (const f of findings) {
    const id = nearDuplicateId(f.a, f.b);
    const existing = byId.get(id);
    if (existing === undefined) {
      out.push({
        id,
        pair: [f.a, f.b].sort() as [string, string],
        status: NearDuplicateStatus.Pending,
        kind: f.kind,
        guardSummary: f.guardSummary,
        detail: f.detail,
        similarity: f.similarity,
        sides: f.sides,
        timesSurfaced: 1,
      });
      indexOf.set(id, out.length - 1);
      byId.set(id, out[out.length - 1]!);
      continue;
    }
    // seen before — refresh the EVIDENCE, never the verdict.
    const at = indexOf.get(id)!;
    out[at] = {
      ...existing,
      kind: f.kind,
      guardSummary: f.guardSummary,
      detail: f.detail,
      similarity: f.similarity,
      sides: f.sides,
      timesSurfaced: existing.timesSurfaced + 1,
      // status + ruling deliberately NOT touched: a ruled pair stays ruled.
    };
  }

  assertMonotonicGrowth(ledger.decisions, out, (d) => d.id);
  return { decisions: out, version: ledger.version + 1 };
}

/** The decisions still awaiting a human ruling. PURE. */
export function pendingDecisions(ledger: NearDuplicateLedger): NearDuplicateDecision[] {
  return ledger.decisions.filter((d) => d.status === NearDuplicateStatus.Pending);
}

/**
 * Resolve a criterion id that may be a PRE-MERGE alias to the id that survives.
 * Exact ids win over aliases (an id is never shadowed by someone else's alias).
 * Returns `undefined` when nothing claims it. PURE.
 */
export function resolveCriterionId(
  criteria: readonly MinedCriterion[],
  id: string,
): string | undefined {
  for (const c of criteria) if (c.id === id) return c.id;
  for (const c of criteria) if ((c.aliases ?? []).includes(id)) return c.id;
  return undefined;
}

// ── Suite-awareness: show the leaf what already exists (prevention, not cleanup) ──

/** One already-known criterion, as handed to the `#mode-discover` leaf. */
export interface ExistingCriterionBrief {
  id: string;
  statement: string;
  severity: SeverityValue;
  level: string;
  checkedBy: string;
}

/**
 * An OPEN near-duplicate question, as shown to the mining leaf. Carries the pair
 * and WHY they were kept apart — deliberately NOT the evidence (see the brief's
 * doc): both sides' statements are already in `criteria`, so this needs only to
 * point at them.
 */
export interface OpenQuestionBrief {
  pair: [string, string];
  /** e.g. `marker parity: [BEFORE] vs [AFTER]` — why these are still two checks. */
  guardSummary: string;
}

/**
 * G5 — one thing the operator REJECTED, as shown to the mining leaf.
 *
 * The statement is carried verbatim rather than by id, because the leaf is comparing
 * MEANING against what it just read in the traces, and a rejected criterion's id tells it
 * nothing. The rationale is carried so the leaf can tell a "wrong rule" rejection from a
 * "not in scope for this subject" one — the second is worth respecting, the first is worth
 * re-proposing differently.
 */
export interface TombstoneBrief {
  id: string;
  /** the rejected statement, verbatim. */
  statement: string;
  /** the operator's stated reason, when they gave one. */
  rationale?: string;
}

/** The brief the mining leaf pre-reads so it can REINFORCE instead of restate. */
export interface ExistingSuiteBrief {
  version: number;
  total: number;
  criteria: ExistingCriterionBrief[];
  /**
   * Pairs already awaiting a human ruling. Shown so the leaf does not mint a
   * THIRD name for a behaviour that is already an open question — it should
   * reuse whichever side its cluster actually matches. Present (possibly empty)
   * whenever a ledger is supplied; absent when the caller passed none.
   */
  openQuestions?: OpenQuestionBrief[];
  /**
   * G5 — criteria the operator REJECTED. This is the PRIMARY anti-rediscovery defence and
   * it is the cheapest one available: the leaf is already making a semantic comparison
   * against the existing suite here, at the only moment where that comparison costs
   * nothing extra. The brief previously carried what the operator ACCEPTED but not what
   * they REJECTED, so a rejected criterion was re-proposed politely, forever.
   *
   * INFORMS, never blocks — the same discipline as `criteria` above. Seeing the behaviour
   * again is legitimate evidence, and a rejection the leaf believes is wrong should be
   * re-proposed with better grounding, not suppressed at source. The identity check
   * (`criterion-identity.ts`) is the backstop for whatever still gets through.
   *
   * Present (possibly empty) whenever tombstones are supplied; ABSENT when the caller
   * passes none — so a caller that supplies nothing gets a byte-identical brief.
   */
  tombstones?: TombstoneBrief[];
}

/**
 * Project the living suite into the compact brief the `#mode-discover` leaf
 * reads before clustering. Carries ONLY what the leaf needs to recognise an
 * already-known behaviour (id + binary statement + severity + level + who checks
 * it) — not the evidence, which would bias the leaf toward re-finding the same
 * failures rather than reading the traces on their own terms.
 *
 * INFORMS, never blocks: seeing the same behaviour again is legitimate
 * REINFORCING evidence for the existing criterion, so the leaf attaches the
 * trace to that id instead of minting a restatement. The merge above stays the
 * safety net for when it mints one anyway. PURE.
 */
export function buildExistingSuiteBrief(
  suite: LivingSuite<MinedCriterion>,
  ledger?: NearDuplicateLedger,
  /** G5 — the operator's tombstones. ABSENT ⇒ the brief is byte-identical to pre-G5. */
  tombstoneList?: readonly TombstoneBrief[],
): ExistingSuiteBrief {
  return {
    version: suite.provenance.version,
    total: suite.entries.length,
    criteria: suite.entries.map((c) => ({
      id: c.id,
      statement: c.statement,
      severity: c.metadata.severity,
      level: c.metadata.level,
      checkedBy: c.metadata.check_method,
    })),
    // OPEN QUESTIONS — the pairs already awaiting a ruling. Both sides are live
    // criteria (a blocked pair is never collapsed), so their statements are
    // already in `criteria` above and this only has to point at them, which is
    // what keeps the brief evidence-free by construction.
    ...(ledger !== undefined
      ? {
          openQuestions: ledger.decisions
            .filter((d) => d.status === NearDuplicateStatus.Pending)
            .map((d) => ({ pair: d.pair, guardSummary: d.guardSummary })),
        }
      : {}),
    // G5 — what the operator said NO to. Omitted entirely when none were supplied, so a
    // pre-G5 caller's brief is unchanged down to the key set.
    ...(tombstoneList !== undefined ? { tombstones: [...tombstoneList] } : {}),
  };
}
