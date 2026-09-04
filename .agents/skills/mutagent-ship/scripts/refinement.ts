// ---------------------------------------------------------------------------
// ⑥ SHIP — the proactive CI-refinement policy (ship PRD §4, P2).
//
// The bounded, mechanical-only refinement loop that runs on a RED CI check. The
// ship-monitor classifies a red check from its own log; the PARENT gates the
// push; a bounded fix actor amends ONLY the mechanical breakage. This module is
// the PURE POLICY core of that loop — no I/O, no clock, no network:
//
//   classifyFailure(log)      log excerpt → { class, evidenceExcerpt }   (§4.1)
//   evaluateRefinement(input) the whole KP-5 decision (refine|escalate,   (§4.2–4.6)
//                             within-grant, auto-revoke, budget, pre-existing)
//   appendRefinementEntry()   the audit ledger (§4.6)
//
// Load-bearing rulings encoded here (all LOCKED, ship PRD §10):
//   §4.2 Mechanical-only mandate — {lint,typecheck,build,test} are mechanical
//        CLASSES; `other` escalates. A mechanical class whose fix would TOUCH a
//        non-mechanical surface (weaken a test, change subject semantics, touch
//        outside the PR diff) is RECLASSIFIED `other` ⇒ escalate.
//   §4.3 Bounded — default 3 attempts per ship (total, not per class).
//   §4.4 KP-5 mechanical pre-grant + AUTO-REVOKE — mechanical classes may be
//        pre-granted at *ship time; the instant a refinement touches a
//        non-mechanical surface the grant auto-revokes for the REST OF THE RUN
//        and every subsequent push falls back to an explicit gate.
//   §4.5 Pre-existing red is not ours to hide — a check already failing on base
//        is surfaced (fix-or-attest), does NOT consume an attempt, is never
//        "refined away" silently.
//
// Deterministic: same input ⇒ deep-equal output. Mirrors the P1 spine style
// (pure functions, injected everything) so the policy is unit-testable against
// inline literals with zero mocking.
// ---------------------------------------------------------------------------

/**
 * The five failure classes a red check is sorted into from its own log (§4.1).
 * The first four are MECHANICAL; `other` always escalates.
 */
export const FailureClass = {
  Lint: "lint",
  Typecheck: "typecheck",
  Build: "build",
  Test: "test",
  Other: "other",
} as const;
export type FailureClassValue = (typeof FailureClass)[keyof typeof FailureClass];

/** The mechanical classes — the ONLY ones eligible for the refinement loop (§4.2). */
export const MECHANICAL_CLASSES: ReadonlySet<FailureClassValue> = new Set<FailureClassValue>([
  FailureClass.Lint,
  FailureClass.Typecheck,
  FailureClass.Build,
  FailureClass.Test,
]);

/** Is `c` a mechanical class (lint|typecheck|build|test)? `other` is never mechanical. */
export function isMechanicalClass(c: FailureClassValue): boolean {
  return MECHANICAL_CLASSES.has(c);
}

/** The default refinement budget (§4.3) — total attempts per ship, not per class. */
export const DEFAULT_MAX_REFINEMENT_ATTEMPTS = 3 as const;

// ── Classification (§4.1) ────────────────────────────────────────────────────

/** A classified red check: the class + the log excerpt that justified it (§4.1). */
export interface FailureClassification {
  class: FailureClassValue;
  /** The log line(s) that justified the class — recorded in the ledger (audit). */
  evidenceExcerpt: string;
}

// Deterministic, evidence-based signatures. ORDER MATTERS: the most specific
// signatures are checked first so a compound log (a lint run that also mentions
// "error") lands on the most precise class. A signature is an ordered list of
// case-insensitive substrings/patterns; the FIRST class with a hit wins.
const CLASS_SIGNATURES: ReadonlyArray<{ class: FailureClassValue; patterns: readonly RegExp[] }> = [
  {
    class: FailureClass.Lint,
    patterns: [/\beslint\b/i, /\bprettier\b/i, /\bruff\b/i, /\blint(ing)?\b/i, /max-warnings/i],
  },
  {
    // Specific error-code / assignability signatures FIRST so the ledger excerpt
    // lands on the actual type error, not a bare `tsc --noEmit` invocation line.
    class: FailureClass.Typecheck,
    patterns: [/\bTS\d{3,5}\b/, /type '.*' is not assignable/i, /\btsc\b/i, /\btype-?check\b/i, /\bpyright\b/i, /\bmypy\b/i],
  },
  {
    class: FailureClass.Test,
    patterns: [/\bbun test\b/i, /\bvitest\b/i, /\bjest\b/i, /\bpytest\b/i, /\b\d+ fail\b/i, /expect\(/i, /assertion/i, /\btest(s)? failed\b/i],
  },
  {
    class: FailureClass.Build,
    patterns: [/\bbuild failed\b/i, /\bbun build\b/i, /\btsc -p\b/i, /\bcompilation\b/i, /\bcannot find module\b/i, /\brollup\b/i, /\bwebpack\b/i],
  },
];

/** The longest single line containing the first matched pattern — the ledger excerpt. */
function extractExcerpt(log: string, pattern: RegExp): string {
  const lines = log.split(/\r?\n/);
  const hit = lines.find((l) => pattern.test(l));
  const chosen = (hit ?? log.split(/\r?\n/)[0] ?? "").trim();
  // Keep the ledger compact + leak-safe — one line, capped.
  return chosen.length > 240 ? `${chosen.slice(0, 237)}...` : chosen;
}

/**
 * Classify a red check from its OWN log (§4.1) — evidence-based, deterministic.
 * Returns the class + the log excerpt that justified it. An unrecognized log ⇒
 * `other` (which always escalates — the safe default; never guess mechanical).
 *
 * This is the deterministic FLOOR the ship-monitor records; a runtime LLM read
 * may refine the excerpt phrasing but never downgrades an `other` to mechanical
 * without evidence (the monitor never fabricates a mechanical class).
 */
export function classifyFailure(log: string): FailureClassification {
  const text = log ?? "";
  for (const sig of CLASS_SIGNATURES) {
    for (const p of sig.patterns) {
      if (p.test(text)) {
        return { class: sig.class, evidenceExcerpt: extractExcerpt(text, p) };
      }
    }
  }
  return {
    class: FailureClass.Other,
    evidenceExcerpt: extractExcerpt(text, /.*/),
  };
}

// ── The refinement decision (§4.2–4.6, KP-5) ─────────────────────────────────

/** The mechanical pre-grant state carried across the run (ship-manifest §2). */
export interface GrantState {
  /** `mechanical` ⇒ mechanical classes pre-granted at *ship time (KP-5). */
  preGrant: "none" | "mechanical";
  /** Flips true the moment a refinement touches non-mechanical surface (rest-of-run). */
  grantRevoked: boolean;
}

export interface RefinementDecisionInput {
  classification: FailureClassification;
  /**
   * Would the fix touch a NON-MECHANICAL surface — weaken/skip/delete a test,
   * change the shipped subject's semantics, touch files outside the PR's own
   * diff, or need `--no-verify`/force-push? The fix actor reports this honestly;
   * true ⇒ reclassify `other` ⇒ escalate + auto-revoke (§4.2/§4.4).
   */
  touchesNonMechanical: boolean;
  /** Was this check ALREADY failing on the base branch (§4.5)? */
  preExisting: boolean;
  grant: GrantState;
  /** Attempts already CONSUMED this run (excludes pre-existing surfacings). */
  attemptsTaken: number;
  maxAttempts?: number; // default 3 (§4.3)
}

/** What the FSM should do with a red check + the audit facts behind it. */
export type RefinementDisposition = "refine" | "escalate" | "surface-preexisting";

export interface RefinementDecision {
  disposition: RefinementDisposition;
  /** True iff a mechanical push is covered by the standing pre-grant (no per-push gate). */
  withinGrant: boolean;
  /** True iff this push must fall back to an explicit operator gate. */
  requiresExplicitGate: boolean;
  /** The grant state AFTER this decision (grantRevoked flips true on a non-mechanical touch). */
  grant: GrantState;
  /** Does this attempt CONSUME the bounded budget? (pre-existing never does — §4.5) */
  consumesAttempt: boolean;
  /** Human-readable WHY — recorded with the ledger entry / escalation. */
  reason: string;
}

/**
 * The whole KP-5 refinement decision (§4.2–4.6), pure. Given a classified red
 * check + the honest "would this touch a non-mechanical surface" report + the
 * current grant/budget state, decide: refine (and under what gate) or escalate,
 * and compute the NEW grant state (auto-revoke is sticky for the rest of the run).
 *
 * Precedence of the escalation rules is deliberate and tested:
 *   1. pre-existing red        → surface (fix-or-attest); never consumes budget, never refined away.
 *   2. non-mechanical touch    → reclassify `other` ⇒ escalate + AUTO-REVOKE the grant (§4.4).
 *   3. class `other`           → escalate.
 *   4. budget exhausted        → escalate.
 *   5. otherwise               → refine; gated per the (possibly already-revoked) grant.
 */
export function evaluateRefinement(input: RefinementDecisionInput): RefinementDecision {
  const max = input.maxAttempts ?? DEFAULT_MAX_REFINEMENT_ATTEMPTS;
  const c = input.classification.class;
  // The grant can only ever move none/active → revoked; once revoked it stays revoked.
  const baseGrant: GrantState = { ...input.grant };

  // 1. Pre-existing red (§4.5) — surfaced, never refined away, never consumes budget.
  if (input.preExisting) {
    return {
      disposition: "surface-preexisting",
      withinGrant: false,
      requiresExplicitGate: false,
      grant: baseGrant,
      consumesAttempt: false,
      reason:
        "pre-existing red (already failing on base) — surfaced for fix-or-attest (§4.5); " +
        "not consumed against the refinement budget and never refined away silently",
    };
  }

  // 2. Non-mechanical touch (§4.2/§4.4) — reclassify `other` ⇒ escalate + AUTO-REVOKE.
  if (input.touchesNonMechanical) {
    return {
      disposition: "escalate",
      withinGrant: false,
      requiresExplicitGate: true,
      grant: { ...baseGrant, grantRevoked: true },
      consumesAttempt: false,
      reason:
        "the fix would touch a non-mechanical surface (weaken a test / change subject " +
        "semantics / touch outside the PR diff) — reclassified `other` ⇒ ESCALATE; the " +
        "mechanical pre-grant AUTO-REVOKES for the rest of the run (KP-5 §4.4)",
    };
  }

  // 3. Class `other` (§4.2) — never mechanical, always escalate.
  if (!isMechanicalClass(c)) {
    return {
      disposition: "escalate",
      withinGrant: false,
      requiresExplicitGate: true,
      grant: baseGrant,
      consumesAttempt: false,
      reason: `failure class \`${c}\` is not mechanical ⇒ ESCALATE (§4.2)`,
    };
  }

  // 4. Budget exhausted (§4.3) — bounded retries.
  if (input.attemptsTaken >= max) {
    return {
      disposition: "escalate",
      withinGrant: false,
      requiresExplicitGate: true,
      grant: baseGrant,
      consumesAttempt: false,
      reason: `refinement budget exhausted (${input.attemptsTaken}/${max}) ⇒ ESCALATE (§4.3)`,
    };
  }

  // 5. Refine — a mechanical class, mechanical touch, budget remaining. The GATE
  //    depends on the grant: covered by an un-revoked mechanical pre-grant ⇒ no
  //    per-push gate; otherwise (pre_grant none, OR grant already revoked) ⇒ gate.
  const covered = baseGrant.preGrant === "mechanical" && !baseGrant.grantRevoked;
  return {
    disposition: "refine",
    withinGrant: covered,
    requiresExplicitGate: !covered,
    grant: baseGrant,
    consumesAttempt: true,
    reason: covered
      ? `mechanical \`${c}\` fix within the standing pre-grant (KP-5) — no per-push gate`
      : baseGrant.grantRevoked
        ? `mechanical \`${c}\` fix, but the pre-grant was REVOKED earlier this run — explicit gate`
        : `mechanical \`${c}\` fix, no pre-grant active — explicit gate`,
  };
}

// ── The refinement ledger (§4.6) ─────────────────────────────────────────────

/** The outcome of a pushed refinement attempt. */
export const RefinementResult = {
  Pending: "pending",
  Green: "green",
  Red: "red",
  Escalated: "escalated",
} as const;
export type RefinementResultValue =
  (typeof RefinementResult)[keyof typeof RefinementResult];

/**
 * One refinement-ledger entry (§4.6): every attempt records its number, class,
 * the evidence excerpt, the files it touched, the push sha, the result, and
 * whether it was covered by the pre-grant (`within_grant`). Rendered in the
 * ship-report + the 🏁 Final Status.
 */
export interface RefinementLedgerEntry {
  n: number; // 1-based attempt number (monotonic)
  class: FailureClassValue;
  evidence_excerpt: string;
  files_touched: string[];
  push_sha: string; // "" until the fix is pushed
  result: RefinementResultValue;
  within_grant: boolean;
}

export interface RefinementEntryInput {
  classification: FailureClassification;
  filesTouched: string[];
  pushSha?: string;
  result?: RefinementResultValue;
  withinGrant: boolean;
}

/**
 * Append a refinement attempt to the ledger (§4.6). Pure — returns a NEW array;
 * the attempt number is derived from the ledger length (monotonic, 1-based) so
 * the caller never has to track `n` separately. Scope discipline (§4.3): the
 * caller is responsible for not exceeding the prior attempt's class evidence —
 * this function only records.
 */
export function appendRefinementEntry(
  ledger: readonly RefinementLedgerEntry[],
  input: RefinementEntryInput,
): RefinementLedgerEntry[] {
  const entry: RefinementLedgerEntry = {
    n: ledger.length + 1,
    class: input.classification.class,
    evidence_excerpt: input.classification.evidenceExcerpt,
    files_touched: [...input.filesTouched],
    push_sha: input.pushSha ?? "",
    result: input.result ?? RefinementResult.Pending,
    within_grant: input.withinGrant,
  };
  return [...ledger, entry];
}

/** How many ledger entries actually CONSUMED the budget (pre-existing excluded). */
export function attemptsConsumed(ledger: readonly RefinementLedgerEntry[]): number {
  return ledger.length;
}

/** Is the refinement budget exhausted (§4.3)? */
export function refinementBudgetExhausted(
  attemptsTaken: number,
  maxAttempts: number = DEFAULT_MAX_REFINEMENT_ATTEMPTS,
): boolean {
  return attemptsTaken >= maxAttempts;
}
