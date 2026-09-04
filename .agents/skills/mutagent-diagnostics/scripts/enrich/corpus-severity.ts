/**
 * scripts/enrich/corpus-severity.ts
 * ② Corpus-relative severity calibration — the G-2 over-alarming fix (SL-8 / DS-02).
 * Type A — Pure Script (deterministic numeric scoring, no LLM calls, no I/O).
 *
 * PROBLEM (SL-8, run SL-8-diag-dual-…14-34-32): on the all-clean control dataset DS-02,
 * `*diagnose` raised 2 CRIT + 3 HIGH on 50 certified-clean traces because a numeric
 * anomaly's SEVERITY was assigned by ABSOLUTE thresholds, not corpus-relative norms — a
 * latency that IS the corpus baseline got escalated to CRIT.
 *
 * FIX — reuse the proven FI-LAT rubric recipe (do NOT invent a model): a numeric anomaly's
 * SEVERITY is scored against the corpus's OWN distribution. Concretely:
 *   • compare each span ONLY against spans of the SAME name;
 *   • band(name) = BAND_MULTIPLIER (3) × that name's p90, with an absolute FLOOR;
 *   • a value is a SPIKE (→ high/crit severity) ONLY if it exceeds BOTH its name-band AND
 *     the floor. Below either bound it is corpus-normal → med/info, never crit/high.
 *
 * The floor guards a FAST corpus: a 50ms value that is 5× a 10ms p90 is a relative outlier
 * but not a real latency problem, so the absolute floor keeps it out of crit/high.
 *
 * PROPOSED principle (operator-locked constitution): see
 *   .meta/prd.yaml key_problems → KP-023 (proposed PR-056).
 * `.meta/design-principles.md` is operator-LOCKED and is NOT edited here.
 */

/** Severity grades a numeric anomaly can resolve to (subset of Finding.severity). */
export type NumericSeverity = "crit" | "high" | "med" | "info";

/** band(name) = BAND_MULTIPLIER × p90(name). FI-LAT rubric = 3×. */
export const BAND_MULTIPLIER = 3;

/**
 * Absolute latency floor (ms). Nothing below this is ever a spike, regardless of how far
 * it sits above its name-band. Mirrors tier0-scan.ts HIGH_LATENCY_MS (10_000) for parity.
 */
export const DEFAULT_LATENCY_FLOOR_MS = 10_000;

/** A (name, value) sample — the numeric metric grouped by its span/agent name. */
export interface NameValue {
  /** Span / agent / operation name the value is compared WITHIN. */
  name: string;
  /** The numeric metric (e.g. latency in ms). */
  value: number;
}

/** The corpus's own distribution, computed once per run and reused per finding. */
export interface CorpusBaseline {
  /** p90 of the metric per span name. */
  p90ByName: Map<string, number>;
  /** p90 across ALL values — fallback when a finding's name is unseen in the corpus. */
  overallP90: number;
  /** Absolute floor below which nothing is a spike. */
  floor: number;
  /** Multiplier applied to a name's p90 to get its spike band. */
  bandMultiplier: number;
  /** How many samples fed the baseline (0 = no corpus data → callers should skip). */
  sampleCount: number;
}

/** The verdict for a single value scored against the corpus. */
export interface SpikeVerdict {
  /** True iff value > name-band AND value > floor. */
  isSpike: boolean;
  /** Corpus-relative severity grade. */
  severity: NumericSeverity;
  /** The evaluated value. */
  value: number;
  /** bandMultiplier × p90(name) — the relative spike threshold. */
  nameBand: number;
  /** The absolute floor applied. */
  floor: number;
}

/**
 * Nearest-rank percentile over a numeric array (deterministic). Identical semantics to
 * build-render-input.ts `percentile` — kept local so this module stays dependency-light
 * (build-render-input imports THIS file, so importing back would create a cycle).
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[rank];
}

/** Rank a severity for MAX-severity aggregation across a finding's source spans. */
const SEVERITY_RANK: Record<NumericSeverity, number> = { info: 0, med: 1, high: 2, crit: 3 };

/**
 * Compute the corpus baseline (per-name p90 + overall p90) from a batch of (name, value)
 * samples. Deterministic. sampleCount === 0 signals "no corpus data" so callers can skip
 * calibration rather than fabricate a baseline from nothing.
 */
export function computeCorpusBaseline(
  samples: NameValue[],
  opts?: { floor?: number; bandMultiplier?: number }
): CorpusBaseline {
  const floor = opts?.floor ?? DEFAULT_LATENCY_FLOOR_MS;
  const bandMultiplier = opts?.bandMultiplier ?? BAND_MULTIPLIER;

  const byName = new Map<string, number[]>();
  const all: number[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;
    all.push(s.value);
    const arr = byName.get(s.name);
    if (arr) arr.push(s.value);
    else byName.set(s.name, [s.value]);
  }

  const p90ByName = new Map<string, number>();
  for (const [name, vals] of byName) p90ByName.set(name, percentile(vals, 90));

  return {
    p90ByName,
    overallP90: percentile(all, 90),
    floor,
    bandMultiplier,
    sampleCount: all.length,
  };
}

/**
 * Score ONE (name, value) against the corpus. A value is a spike ONLY if it clears BOTH
 * its name-band (3× the name's p90) AND the absolute floor. Spikes grade high, or crit
 * when extreme (≥ 2× the name-band); non-spikes are med (absolutely slow but corpus-normal)
 * or info (below the floor). A baseline-normal value therefore never grades crit/high.
 */
export function corpusRelativeSeverity(
  name: string,
  value: number,
  baseline: CorpusBaseline
): SpikeVerdict {
  const p90 = baseline.p90ByName.get(name) ?? baseline.overallP90;
  const nameBand = baseline.bandMultiplier * p90;
  const floor = baseline.floor;
  const isSpike = value > nameBand && value > floor;

  let severity: NumericSeverity;
  if (isSpike) {
    severity = value >= 2 * nameBand ? "crit" : "high";
  } else if (value > floor) {
    // above the absolute floor but within its cohort's norms → notable, not alarming.
    severity = "med";
  } else {
    severity = "info";
  }
  return { isSpike, severity, value, nameBand, floor };
}

/**
 * Calibrate a finding's numeric-anomaly severity from its source spans. Evaluates EACH
 * (name, value) against the corpus and returns the MAX-severity verdict (a single genuine
 * spike dominates; if none of the finding's spans spike, the finding is corpus-normal).
 * Returns null when there are no scorable spans, so the caller leaves severity untouched.
 */
export function calibrateFromSpans(
  spans: NameValue[],
  baseline: CorpusBaseline
): SpikeVerdict | null {
  const scorable = spans.filter((s) => Number.isFinite(s.value));
  if (scorable.length === 0 || baseline.sampleCount === 0) return null;

  let worst: SpikeVerdict | null = null;
  for (const s of scorable) {
    const v = corpusRelativeSeverity(s.name, s.value, baseline);
    if (worst === null || SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst.severity]) {
      worst = v;
    }
  }
  return worst;
}
