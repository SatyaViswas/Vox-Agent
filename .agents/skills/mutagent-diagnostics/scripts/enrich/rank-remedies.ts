/**
 * scripts/enrich/rank-remedies.ts
 * W13-C (D-1): deterministic remedy-rank derivation.
 *
 * The orchestrator protocol (§8) states "Remedies: ranked by cost × correctness",
 * but no code implemented it — so `remedy.rank` reached the renderer as `undefined`
 * (one leg of the D-1 contract-triad desync). This module finally implements that
 * rule in code: `rank` is DERIVED here from the analyzer's `cost` + `correctness`
 * categoricals, never analyzer-supplied. That:
 *   1. guarantees every remedy carries a `rank` before render (no `RANK undefined`);
 *   2. removes an agent-discretion variance source — ranking is now reproducible
 *      (honors the variance program: deterministic, no LLM judgment on rank).
 *
 * `cost`/`correctness` themselves are analyzer-emitted and contract-required
 * (findings-contract.ts REQUIRED_REMEDY_FIELDS) — so they are guaranteed present
 * by the time this runs (Step 8.5 enricher, post Step-7.1 gate).
 *
 * Type A — Pure Script (deterministic, no I/O, no clock, no random).
 */

import type { Remedy } from "../normalize/trace.ts";

/** Categorical → ordinal weight. Higher correctness and LOWER cost are better. */
const CORRECTNESS_WEIGHT: Record<Remedy["correctness"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const COST_WEIGHT: Record<Remedy["cost"], number> = {
  // Lower cost is better, so it contributes MORE priority when cheaper.
  low: 3,
  medium: 2,
  high: 1,
};

/**
 * Priority score for a remedy — HIGHER means a better (higher-priority) remedy.
 *
 * Correctness is weighted to dominate cost: a correct-but-pricey fix outranks a
 * cheap-but-weak one. We achieve strict dominance by scaling correctness above the
 * cost range (cost ∈ [1..3] can never overturn a correctness step):
 *
 *   score = correctnessWeight * 10 + costWeight
 *
 * Deterministic: same inputs → same score, every run.
 */
export function remedyPriorityScore(remedy: Pick<Remedy, "cost" | "correctness">): number {
  return CORRECTNESS_WEIGHT[remedy.correctness] * 10 + COST_WEIGHT[remedy.cost];
}

/**
 * Assign a 1-based `rank` to every remedy by descending priority score
 * (lower rank = higher priority, per the canonical Remedy.rank contract).
 *
 * Pure: returns a new array of new remedy objects; the input is not mutated.
 * Stable + reproducible: score ties are broken deterministically by `remedyId`
 * ascending, so parallel-analyzer output ranks identically on every run.
 */
// ── OPT-2: reconcile remedies that collide on the same applyTarget ────────────────

/**
 * A remedy's CHANGE SIGNATURE — two remedies with the same signature AND the same
 * applyTarget are the SAME edit (safe to merge). Deliberately narrow: title + the actual
 * change payload (diff / describedChange / diffStatus). Ignores rationale/notes prose so a
 * genuine duplicate edit isn't kept apart by cosmetic wording.
 */
function remedyChangeSignature(r: Remedy): string {
  return JSON.stringify({
    title: r.title ?? "",
    diff: r.diff ?? null,
    describedChange: r.describedChange ?? null,
    diffStatus: r.diffStatus ?? null,
  });
}

/** Union two ordered string lists, preserving first-seen order, dropping empties/dups. */
function unionOrdered(a: readonly string[] = [], b: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...a, ...b]) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * OPT-2: group remedies by `applyTarget` and reconcile collisions BEFORE ranking.
 *
 * Ranking treats each remedy independently, so N remedies patching the SAME location were
 * ranked + shown as if independently applicable (the dogfood: 5 remedies on one line, folded
 * to 3 by hand). This pass runs just before `rankRemedies`:
 *   - IDENTICAL same-target remedies (same change signature) are MERGED into one — their
 *     `applyInstructions` are unioned so nothing is lost.
 *   - DIFFERENT same-target remedies are FLAGGED: each gets `applyTargetCollision` listing
 *     its sibling remedyIds, so the report warns that the selections conflict (apply at most
 *     one). We do NOT fabricate a merged diff for genuinely different edits.
 *
 * Pure + deterministic: returns new remedy objects; input order is preserved (first
 * occurrence of each target wins its slot). Remedies with an empty `applyTarget` are never
 * grouped (each stays independent).
 */
export function reconcileRemediesByTarget(remedies: readonly Remedy[]): Remedy[] {
  const groups = new Map<string, Remedy[]>();
  const order: string[] = [];
  remedies.forEach((r, i) => {
    const key = (r.applyTarget ?? "").trim();
    // Empty target → never grouped: give each a unique key so it passes straight through.
    const groupKey = key === "" ? `__ungrouped__${i}` : key;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey)!.push(r);
  });

  const out: Remedy[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    // Merge IDENTICAL remedies (same change signature) within the group.
    const bySig = new Map<string, Remedy>();
    const sigOrder: string[] = [];
    for (const r of group) {
      const sig = remedyChangeSignature(r);
      const existing = bySig.get(sig);
      if (existing) {
        bySig.set(sig, {
          ...existing,
          applyInstructions: unionOrdered(existing.applyInstructions, r.applyInstructions),
        });
      } else {
        bySig.set(sig, r);
        sigOrder.push(sig);
      }
    }
    const merged = sigOrder.map((s) => bySig.get(s)!);

    if (merged.length === 1) {
      // All collisions were identical → one edit, no conflict.
      out.push(merged[0]);
      continue;
    }

    // Genuinely DIFFERENT edits on the same target → flag the conflict on each.
    const ids = merged.map((r) => r.remedyId);
    for (const r of merged) {
      out.push({ ...r, applyTargetCollision: ids.filter((id) => id !== r.remedyId) });
    }
  }
  return out;
}

export function rankRemedies(remedies: readonly Remedy[]): Remedy[] {
  // Index-tag first so the sort is fully deterministic even on duplicate ids.
  const ordered = remedies
    .map((remedy, index) => ({ remedy, index }))
    .sort((a, b) => {
      const scoreDelta = remedyPriorityScore(b.remedy) - remedyPriorityScore(a.remedy);
      if (scoreDelta !== 0) return scoreDelta;
      // Tie-break 1: remedyId ascending (stable, content-addressed).
      const idDelta = a.remedy.remedyId.localeCompare(b.remedy.remedyId);
      if (idDelta !== 0) return idDelta;
      // Tie-break 2: original input order (never relies on Array.sort stability).
      return a.index - b.index;
    });

  return ordered.map(({ remedy }, i) => ({ ...remedy, rank: i + 1 }));
}
