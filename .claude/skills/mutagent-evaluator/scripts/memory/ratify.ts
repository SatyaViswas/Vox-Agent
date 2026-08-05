/**
 * scripts/memory/ratify.ts — EV-4: persist ratify / do-not decisions + hold the verdict.
 * ---------------------------------------------------------------------------
 * The dominant dogfood finding ("router-as-doer") rested on a NORMATIVE call —
 * what counts as correct routing — that only the operator can settle. The review
 * UI already CAPTURES the operator's verify/eliminate decisions on each surfaced
 * assumption (`build-review-ui.ts` `setCalib` → `calibration.json`), but wrote them
 * NOWHERE: a verdict resting on an unratified standard still read as final.
 *
 * This is the LEAN wiring (decision EV-4 option a — NO new criterion schema):
 *   1. ROUTE each calibration decision into `appendMemory` — the same store the
 *      next run's judges read at start (`memory/read.ts`), deduped by slug.
 *   2. HOLD the verdict: a NORMATIVE criterion with no `verify` ratification in the
 *      decision set is `needs-ratification`; while any is pending the run's verdict
 *      is HELD (not final) — the value call must be settled first.
 *
 * PURE cores (deterministic; `now` injected). The only fs edge reuses `appendMemory`.
 */
import { appendMemory, Lifecycle, MemoryType, type AppendResult } from "./append.ts";
import { AssumptionKind, type CriterionVerdict } from "../contracts/eval-types.ts";

/**
 * The criterion ids whose verdict rests on a NORMATIVE assumption (a value/standard
 * call — `AssumptionKind.Normative`), whether surfaced in `assumptions[]` or the
 * `blockedBy` payload. These are the criteria that REQUIRE operator ratification
 * before their verdict can be final. PURE.
 */
export function normativeCriterionIds(verdicts: CriterionVerdict[]): string[] {
  const ids = new Set<string>();
  for (const v of verdicts) {
    const inAssumptions = (v.assumptions ?? []).some((a) => a.kind === AssumptionKind.Normative);
    const inBlock = v.blockedBy?.kind === AssumptionKind.Normative;
    if (inAssumptions || inBlock) ids.add(v.criterionId);
  }
  return [...ids].sort();
}

/** The verify/eliminate action a review-UI calibration button emits (`data-action`). */
export const RatifyAction = {
  /** the operator RATIFIES the surfaced assumption/standard (accept it). */
  Verify: "verify",
  /** the operator rejects it (do-not — drop this standard). */
  Eliminate: "eliminate",
} as const;
export type RatifyActionValue = (typeof RatifyAction)[keyof typeof RatifyAction];

/**
 * One calibration decision as the review UI exports it (`calibration.json`). Shape
 * mirrors `build-review-ui.ts` `setCalib` EXACTLY so the operator's export routes
 * with no transform.
 */
export interface CalibrationDecision {
  traceId: string;
  criterionId: string;
  assumptionIndex: number;
  action: RatifyActionValue;
  decidedAt?: string;
}

/** A stable slug for a ratification memory (dedupe: re-deciding the same pair updates). */
export function ratificationSlug(d: CalibrationDecision): string {
  return `ratify-${d.criterionId}-a${d.assumptionIndex}`;
}

/**
 * Project a calibration decision → an AutoMemory FeedbackInput. A `verify` is a
 * standing "this standard IS ratified" fact the next run's judge honours; an
 * `eliminate` records the operator dropped it. PURE.
 */
export function calibrationToMemory(
  d: CalibrationDecision,
  criterionStatement?: string,
): { title: string; description: string; body: string } {
  const ratified = d.action === RatifyAction.Verify;
  const what = criterionStatement !== undefined && criterionStatement.length > 0 ? criterionStatement : d.criterionId;
  const title = ratificationSlug(d);
  const verb = ratified ? "RATIFIED" : "REJECTED (do-not)";
  return {
    title,
    description: `Normative ratification — criterion ${d.criterionId} assumption #${d.assumptionIndex} ${verb}`,
    body:
      `Operator ${verb} the normative standard for criterion \`${d.criterionId}\` ` +
      `(assumption #${d.assumptionIndex}).\n\n` +
      `**What:** ${what}\n` +
      `**Why:** a normative criterion (what SHOULD count as good) is an operator value call — ` +
      `the judge cannot settle it. This decision is the settled standard.\n` +
      `**How to apply:** ${ratified
        ? "treat this standard as ratified — the verdict on this criterion may now be final."
        : "do NOT gate on this standard — the operator dropped it."}\n` +
      (d.decidedAt !== undefined ? `\n(decided ${d.decidedAt})` : ""),
  };
}

/**
 * ROUTE calibration decisions into AutoMemory (EV-4). One `appendMemory` per
 * decision, deduped by slug (re-deciding UPDATES). Returns the append results.
 * `now` (YYYY-MM-DD) is INJECTED. `statements` optionally maps criterionId → its
 * statement for a richer memory body.
 */
export function persistCalibrations(
  memoryDir: string,
  decisions: CalibrationDecision[],
  now: string,
  statements: Record<string, string> = {},
): AppendResult[] {
  return decisions.map((d) => {
    const m = calibrationToMemory(d, statements[d.criterionId]);
    return appendMemory(
      memoryDir,
      {
        title: m.title,
        description: m.description,
        lifecycle: Lifecycle.Evaluate,
        type: MemoryType.Feedback, // a standing steer the next run's judge honours
        feedback: { text: m.body },
      },
      now,
    );
  });
}

/** The ratification state of one normative criterion (EV-4). */
export interface RatificationStatus {
  criterionId: string;
  /** true when a `verify` decision ratified it; false ⇒ needs-ratification. */
  ratified: boolean;
}

/**
 * Given the NORMATIVE criterion ids (those resting on a normative assumption) and
 * the operator's calibration decisions, report which are RATIFIED (a `verify`
 * exists) vs still `needs-ratification`. An `eliminate` does NOT ratify — the
 * standard was dropped, not settled-as-correct. PURE.
 */
export function ratificationStatus(
  normativeCriterionIds: string[],
  decisions: CalibrationDecision[],
): RatificationStatus[] {
  const ratified = new Set(
    decisions.filter((d) => d.action === RatifyAction.Verify).map((d) => d.criterionId),
  );
  return normativeCriterionIds.map((id) => ({ criterionId: id, ratified: ratified.has(id) }));
}

/**
 * The criterion ids that HOLD the verdict (EV-4): normative criteria not yet
 * ratified. While this list is non-empty the run's verdict is NOT final — the
 * operator must settle the value call first. PURE.
 */
export function pendingRatifications(
  normativeCriterionIds: string[],
  decisions: CalibrationDecision[],
): string[] {
  return ratificationStatus(normativeCriterionIds, decisions)
    .filter((s) => !s.ratified)
    .map((s) => s.criterionId);
}

/** Is the run's verdict HELD pending an operator ratification? (EV-4) */
export function isVerdictHeldForRatification(
  normativeCriterionIds: string[],
  decisions: CalibrationDecision[],
): boolean {
  return pendingRatifications(normativeCriterionIds, decisions).length > 0;
}
