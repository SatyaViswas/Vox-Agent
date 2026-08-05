/**
 * scripts/cold-start-project.ts — EV-5.3 the EvalTrace → ColdTrace projection.
 * ---------------------------------------------------------------------------
 * The COLD front-door (`cold-start-sampler.ts`) balances a bootstrap ✓/✗ suite
 * from MECHANICAL labels alone (no LLM judge yet). Its input is a `ColdTrace`
 * (id + `MechanicalSignals` + dedup keys). The determiner PREP stage, however,
 * works over `EvalTrace[]` (the projection of the handed-over UniTF export). This
 * module is the thin, PURE adapter between the two — and the SINGLE place the
 * cold sampler is wired into the determiner/discover path.
 *
 * ── HONEST-NULL projection (why the mapping looks the way it does) ────────────
 * The `EvalTrace` contract does NOT carry a generic `ext.signals` /
 * `ext.classification` block — the UniTF→EvalTrace projection (`unitf-to-
 * evaltrace.ts`) FLATTENS only the fields it can ground onto the top level
 * (`errored` · `status` · `incomplete` · `scores`) and the UniTF source `ext`
 * itself carries just `ext.eval` (the §9.4.2 fidelity marker). So the mechanical
 * signals are read from what ACTUALLY survives to `EvalTrace`, and every signal
 * with no grounded source stays UNKNOWN (absent), never a fabricated `false`:
 *
 *   MechanicalSignals.hasError       ← EvalTrace.errored            (ERROR family)
 *   MechanicalSignals.hasApiErrors   ← EvalTrace.status === "error" (ERROR family)
 *   MechanicalSignals.incomplete     ← EvalTrace.incomplete         (TERMINAL family)
 *   MechanicalSignals.hasScore/minScore ← numeric EvalTrace.scores  (SCORE family)
 *   MechanicalSignals.hasChatFeedback/negativeReaction ← UNKNOWN — the FEEDBACK
 *       family is not carried on EvalTrace today; omitted (never coerced false).
 *   ColdTrace.scenario   ← UNKNOWN — no classification field on EvalTrace, so a
 *       trace has no dedup key and is kept (never a false collapse).
 *   ColdTrace.worthiness ← UNKNOWN — no worthiness field on EvalTrace (dedup is a
 *       no-op without a scenario key anyway).
 *
 * PURE + deterministic: no clock, no random, no network. A given `EvalTrace[]`
 * always yields the identical selection (reproducible cold suites — C-PIN-adjacent).
 */
import {
  coldStartSample,
  type ColdStartSuite,
  type ColdTrace,
  type MechanicalSignals,
} from "./cold-start-sampler.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";

/**
 * Read the SCORE family off `EvalTrace.scores`. Scores are carried verbatim
 * (`unknown[]`, Langfuse-style `{ name, value }`). Only FINITE NUMERIC `value`s
 * count toward the cold SCORE signal; a non-numeric or absent value contributes
 * nothing. Returns `{}` (both UNKNOWN) when there is no numeric score — honest-
 * null, never a fabricated `hasScore:false`.
 */
function scoreSignals(scores: unknown[] | undefined): Pick<MechanicalSignals, "hasScore" | "minScore"> {
  if (scores === undefined || scores.length === 0) return {};
  let min = Number.POSITIVE_INFINITY;
  let seen = false;
  for (const s of scores) {
    if (s === null || typeof s !== "object") continue;
    const value = (s as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) {
      seen = true;
      if (value < min) min = value;
    }
  }
  return seen ? { hasScore: true, minScore: min } : {};
}

/**
 * Project one `EvalTrace` → the cold sampler's `ColdTrace`. Honest-null: only
 * grounded signals are set; everything else is left absent (UNKNOWN). Explicit
 * about the ERROR/TERMINAL/SCORE families it can ground and the FEEDBACK family
 * it cannot (see the module header).
 */
export function projectEvalTraceToCold(trace: EvalTrace): ColdTrace {
  const signals: MechanicalSignals = {};
  // ERROR family — `errored` is the always-set structured flag (false = a grounded
  // not-errored). `status === "error"` is the raw carried tri-state; surface it as
  // the API-error signal when the source supplied it.
  if (trace.errored !== undefined) signals.hasError = trace.errored;
  if (trace.status === "error") signals.hasApiErrors = true;
  // TERMINAL family — the §9.4.2 truncation marker (absent ⇒ UNKNOWN, never false).
  if (trace.incomplete !== undefined) signals.incomplete = trace.incomplete;
  // SCORE family — derived from any numeric platform score.
  Object.assign(signals, scoreSignals(trace.scores));
  // FEEDBACK family (hasChatFeedback/negativeReaction), scenario, worthiness: NOT
  // carried on EvalTrace — deliberately omitted so they read UNKNOWN downstream.
  return { id: trace.id, signals };
}

/** Project a batch of `EvalTrace` → `ColdTrace[]`, order-preserving + PURE. */
export function projectColdTraces(traces: EvalTrace[]): ColdTrace[] {
  return traces.map(projectEvalTraceToCold);
}

/**
 * The cold-start selection metadata surfaced into the discover/determiner report
 * (the determiner-stage `manifest.json`). `lowConfidence` is the load-bearing
 * flag: a thin-negative cold suite MUST have its first judge pass treated as
 * LOW-CONFIDENCE and re-balanced once real verdicts exist.
 */
export interface ColdStartMeta {
  /** the sampler's target suite size (default = incoming trace count → pass-through). */
  targetSize: number;
  /** how many traces the batch handed to the sampler. */
  input: number;
  /** how many traces the cold suite selected (≤ input; = input on pass-through). */
  selected: number;
  passCount: number;
  failCount: number;
  /** the ✗-pool was too thin — treat the first cold judge pass as LOW-CONFIDENCE. */
  lowConfidence: boolean;
  /** the ✗-pool was rarer than its balanced half → every available fail was taken. */
  oversampledFailPool: boolean;
  /** BOTH non-empty pools are represented (never a success-only bootstrap suite). */
  minBothHeld: boolean;
}

/**
 * Wire the cold-start sampler over an `EvalTrace[]` batch and map the balanced
 * suite BACK to the concrete `EvalTrace[]` the determiner PREP consumes. This is
 * the SAFE call-site helper: it subsamples FIRST, so the untouched
 * `prepDeterminerTasks` still emits exactly one determiner task per SELECTED
 * trace. `size` defaults to the incoming count — a pass-through that only
 * subsamples when an explicit smaller `size` is given (or the batch's own
 * ✓/✗ imbalance triggers oversample flagging). PURE + deterministic.
 */
export function selectColdStartSuite(
  traces: EvalTrace[],
  opts: { size?: number; minBoth?: number; prevalenceFloor?: number; scoreThreshold?: number } = {},
): { selected: EvalTrace[]; meta: ColdStartMeta; suite: ColdStartSuite } {
  const size = opts.size ?? traces.length;
  const suite = coldStartSample(projectColdTraces(traces), {
    size,
    minBoth: opts.minBoth,
    prevalenceFloor: opts.prevalenceFloor,
    scoreThreshold: opts.scoreThreshold,
  });
  // Map the selected cold reps back to their source EvalTrace, preserving the
  // suite's (✓-then-✗) order. `filter` guards the impossible missing-id case.
  const byId = new Map(traces.map((t) => [t.id, t] as const));
  const selected = suite.selected
    .map((c) => byId.get(c.id))
    .filter((t): t is EvalTrace => t !== undefined);
  const meta: ColdStartMeta = {
    targetSize: size,
    input: traces.length,
    selected: selected.length,
    passCount: suite.passCount,
    failCount: suite.failCount,
    lowConfidence: suite.lowConfidence,
    oversampledFailPool: suite.oversampledFailPool,
    minBothHeld: suite.minBothHeld,
  };
  return { selected, meta, suite };
}
