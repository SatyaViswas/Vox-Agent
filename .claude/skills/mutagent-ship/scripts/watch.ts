import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the post-deploy watch: signals + flag rule + rollback recommendation
// (ship PRD §7 + §6.4, P3).
//
// After deploy-confirm the ship-monitor acquires the source-platform trace stream
// via the 3 legal paths (mutagent-cli trace, §6.3 — an AGENT op) and computes the
// §7 signal set over each interval, comparing the window against the pre-ship
// baseline. This module is the PURE decision core of that watch — no I/O, no
// clock, no network:
//
//   aggregateInterval(traces)          per-interval signal counts (§7.2)
//   flagRegression(window, baseline)   the §7.2 flag rule (delta ∨ twice-in-window)
//                                      + the §7.3 cold-subject signals-only mode
//   makeRollbackRecommendation(...)    the §6.4 record (verdict = RECOMMEND_ROLLBACK,
//                                      evidence-linked ≥1 per signal — MANDATORY)
//
// The signal set is REUSED, not invented (§7.2): SHIP consumes the deterministic
// TraceSignals the UniTF layer already computes (mutagent-tools/src/signals/). The
// standalone+symbiosis rule forbids importing that source across skills, so the
// relevant signal fields are mirrored here BY CONVENTION (like the P1 spine mirrors
// the config/handover vocabulary) — the monitor feeds already-computed per-trace
// signals in; this module never re-implements signal detection.
//
// KP-4: thresholds ship as principled DEFAULTS; calibration is deprioritized. The
// correctness focus is the window + deployment-verification path (§7.1), not tuning.
// ---------------------------------------------------------------------------

/** The §7.2 named signals (reused from the UniTF TraceSignals set). */
export const WatchSignal = {
  HasApiErrors: "hasApiErrors",
  HasError: "hasError",
  NegativeReaction: "negativeReaction",
  HasChatFeedback: "hasChatFeedback",
  /** The headline aggregate driver (§7.2) — flagged-trace share delta vs baseline. */
  ErrorRateDelta: "errorRateDelta",
  /** A new below-floor score in-window (§7.2 hasChatFeedback + minScore). */
  MinScoreFloor: "minScoreFloor",
} as const;
export type WatchSignalValue = (typeof WatchSignal)[keyof typeof WatchSignal];

/**
 * The per-trace signal fields SHIP consumes (mirrored from UniTF TraceSignals BY
 * CONVENTION — the monitor supplies these already-computed, never re-detected here).
 */
export interface WatchTraceSignals {
  traceId: string;
  hasError: boolean;
  hasApiErrors: boolean;
  /** scanNegativeReaction hit over user-role text. */
  negativeReaction: boolean;
  hasChatFeedback: boolean;
  /** The lowest attached score, when any (§7.2 minScore). */
  minScore?: number;
}

/** Aggregated signal counts over ONE interval's (or the baseline's) traces. */
export interface IntervalSignals {
  traceCount: number;
  errorCount: number;
  apiErrorCount: number;
  negativeReactionCount: number;
  chatFeedbackCount: number;
  /** The lowest score seen in the slice (undefined when none attached). */
  minScore?: number;
  /** flagged-trace share = errorCount / max(1, traceCount) (§7.2 headline aggregate). */
  errorRate: number;
}

/** Aggregate a slice of per-trace signals into interval counts. Pure. */
export function aggregateInterval(traces: readonly WatchTraceSignals[]): IntervalSignals {
  let errorCount = 0;
  let apiErrorCount = 0;
  let negativeReactionCount = 0;
  let chatFeedbackCount = 0;
  let minScore: number | undefined;
  for (const t of traces) {
    if (t.hasError) errorCount += 1;
    if (t.hasApiErrors) apiErrorCount += 1;
    if (t.negativeReaction) negativeReactionCount += 1;
    if (t.hasChatFeedback) chatFeedbackCount += 1;
    if (typeof t.minScore === "number") {
      minScore = minScore === undefined ? t.minScore : Math.min(minScore, t.minScore);
    }
  }
  const traceCount = traces.length;
  const errorRate = traceCount === 0 ? 0 : Math.round((errorCount / traceCount) * 1000) / 1000;
  const agg: IntervalSignals = {
    traceCount,
    errorCount,
    apiErrorCount,
    negativeReactionCount,
    chatFeedbackCount,
    errorRate,
  };
  if (minScore !== undefined) agg.minScore = minScore;
  return agg;
}

/** The flag thresholds (schema-defaulted, §7.2/KP-4 — principled defaults). */
export interface WatchThresholds {
  /** error-rate delta above baseline that fires the headline flag (default 0.1). */
  errorRateDelta: number;
  /** A score at/below this floor fires the minScore signal (optional — off when absent). */
  minScoreFloor?: number;
  /** How many in-window hits a baseline-0 signal needs to fire (default 2 — "twice"). */
  twiceInWindow: number;
}

export const DEFAULT_WATCH_THRESHOLDS: WatchThresholds = {
  errorRateDelta: 0.1,
  twiceInWindow: 2,
};

/** The baseline mode (ship-manifest §2 / §7.3). */
export type BaselineModeValue = "pre-ship-window" | "none";

/** One fired signal — WHY the window flagged, with the 1-based tick it fired at. */
export interface FiredSignal {
  signal: WatchSignalValue;
  watchValue: number;
  baselineValue: number;
  delta?: number;
  /** 1-based interval (tick) at which this signal fired. */
  firedAtInterval: number;
}

export interface RegressionVerdict {
  flagged: boolean;
  firedSignals: FiredSignal[];
  /** The EARLIEST 1-based tick any signal fired (undefined ⇒ clean window). */
  flaggedAtInterval?: number;
  mode: BaselineModeValue;
}

/**
 * The §7.2 flag rule (pure, deterministic):
 *   regression ⇔ (error-rate delta > threshold) ∨ (any baseline-0 signal fires ≥ twice in-window)
 *
 * A regression can flag at ANY interval, not only at close — so the window is
 * evaluated tick-by-tick and `flaggedAtInterval` is the earliest firing tick.
 *
 * §7.3 cold-subject degraded mode (`mode: none`): the delta rules are INERT and
 * any ABSOLUTE signal hit (hasApiErrors / hasError / negativeReaction) flags —
 * an honest signals-only watch, recorded as such (never a silent clean).
 */
export function flagRegression(
  window: readonly IntervalSignals[],
  baseline: IntervalSignals,
  mode: BaselineModeValue,
  thresholds: WatchThresholds = DEFAULT_WATCH_THRESHOLDS,
): RegressionVerdict {
  const fired: FiredSignal[] = [];

  if (mode === "none") {
    // Cold subject — signals-only. Delta inert; absolute hits flag (§7.3).
    const absolute: Array<[WatchSignalValue, (i: IntervalSignals) => number]> = [
      [WatchSignal.HasApiErrors, (i) => i.apiErrorCount],
      [WatchSignal.HasError, (i) => i.errorCount],
      [WatchSignal.NegativeReaction, (i) => i.negativeReactionCount],
    ];
    for (const [signal, pick] of absolute) {
      let cumulative = 0;
      for (let idx = 0; idx < window.length; idx += 1) {
        cumulative += pick(window[idx]);
        if (cumulative >= 1) {
          fired.push({ signal, watchValue: cumulative, baselineValue: 0, firedAtInterval: idx + 1 });
          break;
        }
      }
    }
    return finalize(fired, mode);
  }

  // pre-ship-window mode — the full §7.2 rule.
  const baseRate = baseline.errorRate;
  // (1) error-rate delta driver — the earliest tick whose rate exceeds baseline+threshold.
  for (let idx = 0; idx < window.length; idx += 1) {
    const delta = Math.round((window[idx].errorRate - baseRate) * 1000) / 1000;
    if (delta > thresholds.errorRateDelta) {
      fired.push({
        signal: WatchSignal.ErrorRateDelta,
        watchValue: window[idx].errorRate,
        baselineValue: baseRate,
        delta,
        firedAtInterval: idx + 1,
      });
      break;
    }
  }
  // (2) baseline-0 signals firing ≥ twice in-window.
  const baselineZero: Array<[WatchSignalValue, (i: IntervalSignals) => number, number]> = [
    [WatchSignal.HasApiErrors, (i) => i.apiErrorCount, baseline.apiErrorCount],
    [WatchSignal.HasError, (i) => i.errorCount, baseline.errorCount],
    [WatchSignal.NegativeReaction, (i) => i.negativeReactionCount, baseline.negativeReactionCount],
    [WatchSignal.HasChatFeedback, (i) => i.chatFeedbackCount, baseline.chatFeedbackCount],
  ];
  for (const [signal, pick, baseCount] of baselineZero) {
    if (baseCount !== 0) continue; // the "baseline 0" precondition
    let cumulative = 0;
    for (let idx = 0; idx < window.length; idx += 1) {
      cumulative += pick(window[idx]);
      if (cumulative >= thresholds.twiceInWindow) {
        fired.push({ signal, watchValue: cumulative, baselineValue: 0, firedAtInterval: idx + 1 });
        break;
      }
    }
  }
  // (3) a NEW below-floor score in-window (only when a floor is configured).
  if (thresholds.minScoreFloor !== undefined) {
    const floor = thresholds.minScoreFloor;
    const baselineBelow = baseline.minScore !== undefined && baseline.minScore <= floor;
    if (!baselineBelow) {
      for (let idx = 0; idx < window.length; idx += 1) {
        const ms = window[idx].minScore;
        if (ms !== undefined && ms <= floor) {
          fired.push({
            signal: WatchSignal.MinScoreFloor,
            watchValue: ms,
            baselineValue: baseline.minScore ?? Number.NaN,
            firedAtInterval: idx + 1,
          });
          break;
        }
      }
    }
  }

  return finalize(fired, mode);
}

function finalize(fired: FiredSignal[], mode: BaselineModeValue): RegressionVerdict {
  const flaggedAtInterval =
    fired.length > 0 ? Math.min(...fired.map((f) => f.firedAtInterval)) : undefined;
  const verdict: RegressionVerdict = { flagged: fired.length > 0, firedSignals: fired, mode };
  if (flaggedAtInterval !== undefined) verdict.flaggedAtInterval = flaggedAtInterval;
  return verdict;
}

// ── The rollback recommendation record (§6.4) — a RECOMMENDATION, never an action ──

/** The ONLY verdict this record can carry (§6.4). */
export const ROLLBACK_VERDICT = "RECOMMEND_ROLLBACK" as const;

const FiredSignalRecordSchema = Type.Object(
  {
    signal: Type.String({ minLength: 1 }),
    watch_value: Type.Number(),
    baseline_value: Type.Number(),
    delta: Type.Optional(Type.Number()),
    // Concrete trace refs — MANDATORY, ≥1 (enforced in validate below).
    evidence: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** The §6.4 rollback-recommendation record schema (closed, frozen verdict). */
export const RollbackRecommendationSchema = Type.Object(
  {
    ship_id: Type.String({ minLength: 1 }),
    flagged_at_interval: Type.Integer({ minimum: 1 }),
    signals_fired: Type.Array(FiredSignalRecordSchema),
    verdict: Type.Literal(ROLLBACK_VERDICT),
    revert_target: Type.String({ minLength: 1 }), // pr.merge_sha
    handoff: Type.String(), // the parent-emitted DIAGNOSE HandoverBundle path
    note: Type.String(),
  },
  { additionalProperties: false },
);
export type RollbackRecommendation = Static<typeof RollbackRecommendationSchema>;

const RecommendationChecker = TypeCompiler.Compile(RollbackRecommendationSchema);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a recommendation record. Two floors: the closed TypeBox shape, plus
 * the SEMANTIC invariant TypeBox cannot express — EVERY fired signal MUST carry
 * ≥1 evidence trace ref (§6.4: "concrete trace refs — MANDATORY, ≥1"). An
 * evidence-free recommendation is refused: a rollback with zero linked evidence
 * must never exist (INV — §6.4 / §1.3).
 */
export function validateRollbackRecommendation(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!RecommendationChecker.Check(obj)) {
    for (const e of RecommendationChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  const rec = (obj ?? {}) as { signals_fired?: unknown };
  if (Array.isArray(rec.signals_fired)) {
    rec.signals_fired.forEach((raw, i) => {
      const s = (raw ?? {}) as { evidence?: unknown };
      const ev = Array.isArray(s.evidence) ? s.evidence : [];
      if (ev.length === 0) {
        errors.push(
          `/signals_fired/${i}/evidence: every fired signal MUST carry ≥1 trace-evidence ref ` +
            "(§6.4 — a rollback with zero linked evidence is refused)",
        );
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

export interface RollbackRecommendationInput {
  shipId: string;
  verdict: RegressionVerdict;
  /** trace-evidence refs per fired signal — keyed by the signal name. MANDATORY ≥1 each. */
  evidenceBySignal: Partial<Record<WatchSignalValue, string[]>>;
  /** the ship merge sha — the revert target (§6.4). */
  revertTarget: string;
  /** the parent-emitted DIAGNOSE HandoverBundle path (may be "" when set later). */
  handoff?: string;
}

/**
 * Build the §6.4 rollback-recommendation record from a flagged verdict + the
 * monitor's per-signal trace evidence. Pure + deterministic. THROWS if the
 * verdict is not flagged (a recommendation only exists for a regression) or if
 * any fired signal has no evidence (fail-loud — the evidence-linkage invariant).
 */
export function makeRollbackRecommendation(
  input: RollbackRecommendationInput,
): RollbackRecommendation {
  if (!input.verdict.flagged || input.verdict.flaggedAtInterval === undefined) {
    throw new Error(
      "makeRollbackRecommendation: refused — the watch verdict is not flagged " +
        "(a rollback recommendation exists only for a regression, §6.4)",
    );
  }
  const signals_fired = input.verdict.firedSignals.map((f) => {
    const evidence = input.evidenceBySignal[f.signal] ?? [];
    if (evidence.length === 0) {
      throw new Error(
        `makeRollbackRecommendation: signal \`${f.signal}\` has no trace evidence — ` +
          "every fired signal MUST be evidence-linked (§6.4)",
      );
    }
    const row: Static<typeof FiredSignalRecordSchema> = {
      signal: f.signal,
      watch_value: f.watchValue,
      baseline_value: f.baselineValue,
      evidence: [...evidence],
    };
    if (f.delta !== undefined) row.delta = f.delta;
    return row;
  });

  return {
    ship_id: input.shipId,
    flagged_at_interval: input.verdict.flaggedAtInterval,
    signals_fired,
    verdict: ROLLBACK_VERDICT,
    revert_target: input.revertTarget,
    handoff: input.handoff ?? "",
    note:
      "RECOMMENDATION ONLY. Nothing in the system acts on this file automatically. " +
      "*rollback <ship-id> reads it, gates on the operator, and opens a REVERT PR (INV-SHIP-5).",
  };
}
