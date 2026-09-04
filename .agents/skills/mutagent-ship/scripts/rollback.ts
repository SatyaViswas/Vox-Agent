import { CHANGELOG_SECTIONS } from "./changelog.ts";
import type { ShipManifest, ShipStatusValue } from "./ship-manifest.ts";
import type { RollbackRecommendation } from "./watch.ts";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the *rollback revert-PR path (ship PRD §1.3, P3).
//
// *rollback acts on a rollback recommendation (or the operator's own judgment):
// it OPENS a REVERT PR — `git revert <merge-sha>` on a fresh branch — evidence-
// linked, operator-approved, NEVER automatic, NEVER destructive (INV-SHIP-5). The
// revert PR goes through the same CI FSM (§4); rollback OPENS it and never merges
// it (the operator inspects + merges). Mechanism is `git revert`, never a
// force-push, never a rollback env-flag/knob (correctness discipline).
//
// This module is the PURE decision/render core:
//   assertRollbackable(status)        the precondition (status ∈ {shipped, regression-flagged})
//   resolveRollbackEvidence(...)      the evidence-linkage invariant (§1.3 step 1)
//   renderRevertChangelog(...)        the evidence-linked revert-PR body (six-section contract)
//
// The git revert + `gh pr create` themselves are the steward's AGENT ops (the
// skill ships no network); this module decides + renders. Pure: no I/O, no clock.
// ---------------------------------------------------------------------------

/** *rollback is legal only on a run that actually shipped or was flagged (§1.3 inputs). */
export const ROLLBACKABLE_STATUSES: ReadonlySet<ShipStatusValue> = new Set<ShipStatusValue>([
  "shipped",
  "regression-flagged",
]);

export interface PreconditionResult {
  ok: boolean;
  reason: string;
}

/** Is a rollback legal for this run status? (§1.3 — must be shipped|regression-flagged). */
export function assertRollbackable(status: ShipStatusValue): PreconditionResult {
  if (ROLLBACKABLE_STATUSES.has(status)) {
    return { ok: true, reason: `status \`${status}\` is rollbackable` };
  }
  return {
    ok: false,
    reason:
      `status \`${status}\` is not rollbackable — *rollback requires a run in ` +
      "{shipped, regression-flagged} (§1.3)",
  };
}

/** Where the rollback's evidence came from. */
export type RollbackEvidenceSource = "recommendation" | "operator-reason";

export interface RollbackEvidenceInput {
  /** The §6.4 recommendation record, when the rollback acts on a flagged watch. */
  recommendation?: RollbackRecommendation;
  /**
   * An operator-initiated rollback (no recommendation) MUST state a reason — it is
   * recorded verbatim into the revert PR body (§1.3 step 1). Empty ⇒ refused.
   */
  operatorReason?: string;
}

export interface RollbackEvidenceResult {
  ok: boolean;
  source?: RollbackEvidenceSource;
  /** The trace-evidence refs (from the recommendation) — may be [] for an operator reason. */
  evidence: string[];
  /** The verbatim operator reason, when that is the source. */
  operatorReason?: string;
  /** Present when refused — WHY (the evidence-linkage invariant). */
  refusal?: string;
}

/**
 * Resolve the rollback's evidence (§1.3 step 1 — "Evidence-linked is an invariant:
 * a rollback with zero linked evidence is refused"). Precedence:
 *   1. a recommendation record ⇒ its trace-evidence refs (evidence-linked by §6.4).
 *   2. else an operator reason ⇒ recorded verbatim (the operator's own judgment IS
 *      the evidence for a manual rollback).
 *   3. neither ⇒ REFUSED. There is no evidence-free rollback.
 * Pure.
 */
export function resolveRollbackEvidence(input: RollbackEvidenceInput): RollbackEvidenceResult {
  if (input.recommendation) {
    const evidence = input.recommendation.signals_fired.flatMap((s) => s.evidence);
    if (evidence.length === 0) {
      // Defensive: a recommendation should never be evidence-free (validate enforces
      // it), but if a hand-authored one slips through, refuse rather than trust it.
      return {
        ok: false,
        evidence: [],
        refusal:
          "the recommendation carries zero trace evidence — refused (§6.4/§1.3 evidence-linkage invariant)",
      };
    }
    return { ok: true, source: "recommendation", evidence };
  }

  const reason = (input.operatorReason ?? "").trim();
  if (reason !== "") {
    return { ok: true, source: "operator-reason", evidence: [], operatorReason: reason };
  }

  return {
    ok: false,
    evidence: [],
    refusal:
      "no rollback recommendation AND no operator reason — an operator-initiated rollback " +
      "MUST state a reason (§1.3 step 1); a rollback with zero linked evidence is refused",
  };
}

const mdEscape = (s: string): string => s.replace(/\|/g, "\\|");

export interface RevertChangelogInput {
  manifest: ShipManifest;
  /** The resolved evidence (from resolveRollbackEvidence) — must be ok. */
  evidence: RollbackEvidenceResult;
  /** The §6.4 recommendation record, when present (for the signal-delta table). */
  recommendation?: RollbackRecommendation;
  /** The path to the recommendation record (linked in Evidence & Provenance). */
  recommendationRef?: string;
}

/**
 * Render the REVERT PR body (§1.3) — the standardized six-section changelog, but
 * for the revert. `git revert <merge-sha>` is the Solution; Evidence & Provenance
 * links the recommendation evidence (trace refs · signal deltas · window) or the
 * verbatim operator reason. Passes checkChangelogContract (same six sections).
 * THROWS if handed an un-resolved (refused) evidence result — a revert body must
 * never be rendered for an evidence-free rollback.
 */
export function renderRevertChangelog(input: RevertChangelogInput): string {
  if (!input.evidence.ok) {
    throw new Error(
      `renderRevertChangelog: refused — evidence is not resolved (${input.evidence.refusal ?? "unknown"})`,
    );
  }
  const m = input.manifest;
  const mergeSha = m.pr.merge_sha || "(unmerged — no revert target)";

  const problem =
    input.evidence.source === "recommendation"
      ? `Revert ship \`${m.ship_id}\` (\`${m.subject.name}\`): a post-deploy regression was flagged on the watch window and an evidence-linked rollback was recommended.`
      : `Revert ship \`${m.ship_id}\` (\`${m.subject.name}\`) on operator judgment: ${mdEscape(input.evidence.operatorReason ?? "")}`;

  // The signal-delta table (only when a recommendation drove the rollback).
  const signalRows =
    input.recommendation && input.recommendation.signals_fired.length > 0
      ? input.recommendation.signals_fired
          .map(
            (s) =>
              `| \`${s.signal}\` | ${s.watch_value} | ${s.baseline_value} | ${s.delta ?? "—"} | ${s.evidence.map((e) => `\`${mdEscape(e)}\``).join(", ")} |`,
          )
          .join("\n")
      : "| _(operator-initiated — no signal deltas)_ | — | — | — | — |";

  const evidenceLines =
    input.evidence.source === "recommendation"
      ? [
          `- **Rollback recommendation**: \`${input.recommendationRef ?? m.rollback.recommendation ?? "(recommendation record)"}\``,
          `- **Flagged at interval**: ${input.recommendation?.flagged_at_interval ?? "—"} · watch window ${m.watch.window_minutes}m · baseline \`${m.watch.baseline.mode}\``,
          `- **Trace evidence**: ${input.evidence.evidence.map((e) => `\`${mdEscape(e)}\``).join(", ") || "(none)"}`,
        ]
      : [`- **Operator reason (verbatim)**: ${mdEscape(input.evidence.operatorReason ?? "")}`];

  return [
    "## Problem",
    "",
    problem,
    "",
    "## Solution",
    "",
    `Revert the ship merge via \`git revert ${mergeSha}\` on a fresh branch — a NEW revert commit ` +
      "(log-based, auditable, non-destructive). This PR OPENS the revert; the operator inspects and " +
      "merges it (INV-SHIP-5 — never automatic, never destructive, never a force-push).",
    "",
    "## Changes",
    "",
    "| File | Purpose (WHY) |",
    "|---|---|",
    `| _(git revert of ${mdEscape(mergeSha)})_ | Undo the shipped change; the revert is the whole diff |`,
    "",
    "## Evidence & Provenance",
    "",
    `- **Evaluate GATE verdict (original ship)**: \`${m.evidence.evaluate_verdict}\``,
    `- **Verdict commit**: \`${m.subject.commit}\``,
    `- **Revert target (ship merge sha)**: \`${mergeSha}\``,
    ...evidenceLines,
    "",
    "| Signal | Watch | Baseline | Δ | Evidence |",
    "|---|---|---|---|---|",
    signalRows,
    "",
    "## Verification",
    "",
    "**Pre-revert:** the revert PR runs the SAME CI FSM (§4) — mechanical refinement allowed; it must go green before merge.",
    "",
    "**Post-merge:** a ④ DIAGNOSE handoff is ensured — rollback is mitigation, not diagnosis; the regression still needs a root cause (§1.3 step 4).",
    "",
    "## Risks & Limitations",
    "",
    "A revert restores the prior behavior but does NOT explain the regression — DIAGNOSE owns the root cause. If the reverted change had unrelated fixes, they are undone too (a revert is the whole diff); re-land them separately after diagnosis.",
    "",
  ].join("\n");
}

/** The six mandatory sections a revert body must carry (re-exported for the contract check). */
export const REVERT_CHANGELOG_SECTIONS = CHANGELOG_SECTIONS;
