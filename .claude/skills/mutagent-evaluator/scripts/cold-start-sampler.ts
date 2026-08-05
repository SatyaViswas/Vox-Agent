/**
 * scripts/cold-start-sampler.ts — EV-5.3 the balanced COLD-START sampler.
 * ---------------------------------------------------------------------------
 * PRE-SUITE, there is NO LLM judge yet: the EV-042 determiner (`determine-
 * outcome.ts`) needs a criteria suite to run, and the suite doesn't exist yet.
 * So the ONLY ✓/✗ labels available at cold start are:
 *   (a) the agent/skill DEFINITION's success ORACLE, and
 *   (b) deterministic MECHANICAL signals — the four cold-label families
 *       ERROR · FEEDBACK · SCORE · TERMINAL (a subset of `ext.signals` plus the
 *       §9.4.2 terminal/`incomplete` marker). No provider, no judge tokens.
 *
 * This is DISTINCT from `sample-traces.ts` `balancedSample`, which balances over
 * the LLM-determiner's `OutcomeVerdict` labels (a WARM, post-judge input). This
 * module is the COLD front-door: it manufactures a balanced ✓/✗ bootstrap suite
 * from mechanical labels alone so the first judge pass is trained on BOTH classes.
 *
 * The pipeline (in order):
 *   stratify → SL-5 prevalence floor → worthiness/scenario dedup →
 *   MIN-BOTH (a guaranteed minimum from BOTH pools — never a success-only suite) →
 *   oversample the ✗-pool when rare (and flag the suite LOW-CONFIDENCE).
 *
 * PURE + deterministic: no `Math.random`, no clock, no network. A given
 * (traces, opts) always yields the identical suite (reproducible cold suites —
 * C-PIN-adjacent). Never fabricates a trace: a scarcer class contributes all it
 * has and no more.
 */

// ── Mechanical cold labels (NO LLM judge) ───────────────────────────────────

/** The cold outcome — the ONLY two pools a balanced suite is built from. */
export const ColdOutcome = { Pass: "pass", Fail: "fail" } as const;
export type ColdOutcomeValue = (typeof ColdOutcome)[keyof typeof ColdOutcome];

/**
 * The four MECHANICAL cold-label signal families available pre-suite. Mirrors the
 * subset of UniTF `ext.signals` (`hasError`/`hasApiErrors`/`hasChatFeedback`/
 * `negativeReaction`/`hasScore`/`minScore`) plus the §9.4.2 terminal marker
 * (`incomplete`). All optional/additive: an absent field is UNKNOWN, never a
 * false — the oracle reads only what is present.
 */
export interface MechanicalSignals {
  /** ERROR family — a run/tool error was recorded. */
  hasError?: boolean;
  /** ERROR family — provider/API errors were recorded. */
  hasApiErrors?: boolean;
  /** FEEDBACK family — a user chat reaction exists on the trace. */
  hasChatFeedback?: boolean;
  /** FEEDBACK family — that reaction was negative (frustration/swear hit). */
  negativeReaction?: boolean;
  /** SCORE family — a numeric score exists. */
  hasScore?: boolean;
  /** SCORE family — the lowest score seen (compared to `scoreThreshold`). */
  minScore?: number;
  /** TERMINAL family — the session was cut off / reached no terminal event. */
  incomplete?: boolean;
}

/** One candidate trace at cold start: its id + mechanical signals + dedup keys. */
export interface ColdTrace {
  id: string;
  signals: MechanicalSignals;
  /** `ext.classification.scenario` — the dedup key (one rep per scenario). */
  scenario?: string;
  /** `ext.signals.worthinessScore` [0,1] — dedup keeps the worthiest rep. */
  worthiness?: number;
}

/**
 * The DEFINITION success oracle: maps a cold trace → ✓/✗, or `null` when the
 * mechanical signals are insufficient to decide. A `null` (UNKNOWN) trace is kept
 * for coverage but NEVER forced into a pool — it can't help balance and must not
 * fabricate a label. The default is {@link defaultMechanicalOracle}; a subject
 * whose DEFINITION encodes a richer success rule injects its own here.
 */
export type SuccessOracle = (t: ColdTrace) => ColdOutcomeValue | null;

/** Default SCORE-family pass/fail cut. */
export const DEFAULT_SCORE_THRESHOLD = 0.5;

/**
 * The default MECHANICAL oracle over the four cold-label families. A trace is ✗
 * when ANY negative mechanical signal fired — an error, a NEGATIVE user reaction,
 * a below-threshold score, or a non-terminal/truncated session — and ✓ otherwise.
 * PURE + total (never returns `null`): a subject that needs an UNKNOWN verdict
 * injects its own oracle. No LLM, no provider.
 */
export function defaultMechanicalOracle(
  scoreThreshold: number = DEFAULT_SCORE_THRESHOLD,
): SuccessOracle {
  return (t) => {
    const s = t.signals;
    const errored = s.hasError === true || s.hasApiErrors === true;
    const negFeedback = s.hasChatFeedback === true && s.negativeReaction === true;
    const lowScore =
      s.hasScore === true && typeof s.minScore === "number" && s.minScore < scoreThreshold;
    const truncated = s.incomplete === true;
    return errored || negFeedback || lowScore || truncated ? ColdOutcome.Fail : ColdOutcome.Pass;
  };
}

// ── stratify ────────────────────────────────────────────────────────────────

/** The ✓/✗ pools plus the UNKNOWN remainder (oracle abstained). Order-preserving. */
export interface Stratified {
  pass: ColdTrace[];
  fail: ColdTrace[];
  unknown: ColdTrace[];
}

/**
 * Partition traces into the ✓/✗ pools via the oracle (UNKNOWN → `unknown`).
 * PURE + deterministic; preserves input order within each pool.
 */
export function stratify(traces: ColdTrace[], oracle: SuccessOracle): Stratified {
  const pass: ColdTrace[] = [];
  const fail: ColdTrace[] = [];
  const unknown: ColdTrace[] = [];
  for (const t of traces) {
    const v = oracle(t);
    if (v === ColdOutcome.Pass) pass.push(t);
    else if (v === ColdOutcome.Fail) fail.push(t);
    else unknown.push(t);
  }
  return { pass, fail, unknown };
}

// ── worthiness / scenario dedup ─────────────────────────────────────────────

/**
 * Keep ONE representative per `scenario` — the highest `worthiness` (ties → the
 * first seen). Traces with NO scenario have no dedup key, so they are all kept
 * (they can't be proven duplicates). Deterministic + order-preserving over the
 * surviving representatives. Never reorders by worthiness — only DROPS lower-
 * worthiness same-scenario duplicates.
 */
export function dedupByScenario(pool: ColdTrace[]): ColdTrace[] {
  // First pass: pick the winning id per scenario (highest worthiness, first-seen tie).
  const winner = new Map<string, ColdTrace>();
  for (const t of pool) {
    if (t.scenario === undefined) continue;
    const cur = winner.get(t.scenario);
    if (cur === undefined || (t.worthiness ?? 0) > (cur.worthiness ?? 0)) {
      winner.set(t.scenario, t);
    }
  }
  // Second pass: emit in original order, keeping non-scenario traces + each
  // scenario's winner exactly once.
  const emittedScenario = new Set<string>();
  const out: ColdTrace[] = [];
  for (const t of pool) {
    if (t.scenario === undefined) {
      out.push(t);
      continue;
    }
    if (winner.get(t.scenario) === t && !emittedScenario.has(t.scenario)) {
      emittedScenario.add(t.scenario);
      out.push(t);
    }
  }
  return out;
}

// ── coldStartSample — the balanced cold suite ───────────────────────────────

export interface ColdStartOptions {
  /** Target suite size (the sampler stays at or under this, MIN-BOTH excepted). */
  size: number;
  /**
   * MIN-BOTH — the guaranteed minimum drawn from EACH non-empty pool (default 1).
   * When honoring both minimums would exceed `size`, MIN-BOTH WINS: a balanced
   * bootstrap suite is worth more than a hard size cap, and a success-only suite
   * is never acceptable.
   */
  minBoth?: number;
  /**
   * SL-5 PREVALENCE FLOOR — the minimum number of ✗-pool traces retained even when
   * the ✗ class is scarce (default = `minBoth`). The fail budget never drops below
   * `min(prevalenceFloor, availableFails)`, so a rare-but-present failure signal is
   * never balanced away.
   */
  prevalenceFloor?: number;
  /** SCORE-family pass/fail cut for the default oracle (default 0.5). */
  scoreThreshold?: number;
  /** The DEFINITION success oracle (default `defaultMechanicalOracle(scoreThreshold)`). */
  oracle?: SuccessOracle;
  /** Worthiness/scenario dedup (default true). */
  dedup?: boolean;
}

export interface ColdStartSuite {
  /** The selected cold suite (deduped, balanced): ✓ representatives then ✗. */
  selected: ColdTrace[];
  passCount: number;
  failCount: number;
  /** true when the ✗-pool was too rare to fill its balanced half → all fails taken. */
  oversampledFailPool: boolean;
  /**
   * true when the suite rests on TOO-FEW negatives — the ✗-pool was oversampled or
   * couldn't fill its balanced half (or is empty). Downstream MUST treat the first
   * cold judge pass as LOW-CONFIDENCE and re-balance once real verdicts exist.
   */
  lowConfidence: boolean;
  /**
   * The MIN-BOTH invariant: BOTH non-empty pools are represented in `selected`.
   * A success-only suite (or a fail-only suite) ⇒ false. When both pools have
   * members this is ALWAYS true.
   */
  minBothHeld: boolean;
}

/**
 * Build a balanced cold-start suite from mechanical labels. Runs the full EV-5.3
 * pipeline: stratify → SL-5 prevalence floor → scenario/worthiness dedup →
 * MIN-BOTH → oversample-when-rare. PURE + deterministic; never fabricates.
 */
export function coldStartSample(traces: ColdTrace[], opts: ColdStartOptions): ColdStartSuite {
  const size = Math.max(0, Math.floor(opts.size));
  const minBoth = Math.max(0, Math.floor(opts.minBoth ?? 1));
  const oracle = opts.oracle ?? defaultMechanicalOracle(opts.scoreThreshold);

  const strat = stratify(traces, oracle);
  const pass = opts.dedup === false ? strat.pass : dedupByScenario(strat.pass);
  const fail = opts.dedup === false ? strat.fail : dedupByScenario(strat.fail);

  const perSide = Math.floor(size / 2);
  // SL-5 prevalence floor: fails we must keep even when scarce (capped at availability).
  const prevalenceFloor = Math.max(0, Math.floor(opts.prevalenceFloor ?? minBoth));
  const failFloor = Math.min(Math.max(prevalenceFloor, minBoth), fail.length);

  let takeFail: number;
  let takePass: number;
  let oversampledFailPool = false;

  if (fail.length > 0 && fail.length < perSide) {
    // ✗-pool RARE — oversample: take EVERY available fail, fill the rest with ✓.
    oversampledFailPool = true;
    takeFail = fail.length;
    takePass = Math.min(pass.length, Math.max(0, size - takeFail));
  } else {
    // Balanced take, but never below the SL-5 floor for fails.
    takeFail = Math.min(fail.length, Math.max(perSide, failFloor));
    takePass = Math.min(pass.length, Math.max(0, size - takeFail));
    // If ✓ is scarce and budget remains, let ✗ backfill up to `size`.
    if (takePass + takeFail < size) {
      takeFail = Math.min(fail.length, size - takePass);
    }
  }

  // MIN-BOTH enforcement — never drop a NON-EMPTY pool below min(minBoth, available).
  // This is the "never a success-only suite" guarantee; it can push the total over
  // `size` only in the degenerate small-`size` case, which is intentional.
  if (fail.length > 0) takeFail = Math.max(takeFail, Math.min(minBoth, fail.length));
  if (pass.length > 0) takePass = Math.max(takePass, Math.min(minBoth, pass.length));

  const selectedPass = pass.slice(0, takePass);
  const selectedFail = fail.slice(0, takeFail);
  const selected = [...selectedPass, ...selectedFail];

  const passCount = selectedPass.length;
  const failCount = selectedFail.length;
  const minBothHeld = passCount > 0 && failCount > 0;
  // Low-confidence when negatives are thin: oversampled, or the ✗-pool couldn't
  // fill its balanced half, or there are no negatives at all.
  const lowConfidence = oversampledFailPool || fail.length === 0 || failCount < perSide;

  return { selected, passCount, failCount, oversampledFailPool, lowConfidence, minBothHeld };
}
