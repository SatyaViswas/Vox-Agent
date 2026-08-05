/**
 * scripts/decisions-store.ts — G4: the append-only OPERATOR DECISIONS store.
 * ---------------------------------------------------------------------------
 * Two surfaces ask the operator to decide something. `*review` shows each judge verdict
 * with agree / revise / refute; `*discover` proposes mined criteria and holds ambiguous
 * near-duplicates open as questions. Both were READ-ONLY: the ruling was displayed and
 * then discarded, so an accepted criterion was re-proposed next run and a rejected one
 * was proposed again forever. The system could not tell "never seen" from "you already
 * said no". This is where a ruling goes so it survives.
 *
 * WHY APPEND-ONLY: for exactly the reason the living suite is. A decision that can vanish
 * is a decision you have to make again, and a system that silently forgets a rejection is
 * indistinguishable from one that never recorded it. Growth is monotonic and enforced by
 * the SAME guard the suite uses (`assertMonotonicGrowth`) rather than a second, parallel
 * discipline that could drift away from it.
 *
 * A REJECT IS A TOMBSTONE, NEVER A DELETION. Nothing is removed from the suite; the
 * rejection is recorded alongside it. That is what makes "you already ruled on this"
 * answerable later, and what lets a wrong rejection be revisited instead of being made
 * permanent by a silent drop.
 *
 * PURE + deterministic: no clock, no random, no network, no fs. Ids are content-derived
 * (FNV-1a, the same primitive the dataset ids use), so the same ruling yields the same id
 * in every run forever — a store written twice is byte-identical (C-PIN).
 *
 * NO LLM in this path. This module is the formal DATA INTERFACE around a decision: it
 * records, dedupes and enforces. It never decides anything itself, and it never judges
 * whether two criteria mean the same thing — that is a semantic call and it lives in
 * `criterion-identity.ts` (G5).
 */
import { fnv1aHex } from "./build-dataset.ts";
import { assertMonotonicGrowth, growLivingSuite, type LivingSuite } from "./living-suite.ts";
import type { MinedCriterion } from "./contracts/eval-types.ts";

/** What the operator did. */
export const DecisionKind = {
  /** the criterion becomes PERMANENT in the suite (with its kind + severity). */
  Accept: "accept",
  /** recorded as a tombstone — never deleted, never re-proposed. */
  Reject: "reject",
  /** an amended statement, linked to the original. */
  Revise: "revise",
} as const;
export type DecisionKindValue = (typeof DecisionKind)[keyof typeof DecisionKind];

/** What the ruling is ABOUT — the three decision surfaces, named rather than stringly. */
export const DecisionTargetKind = {
  /** a mined/proposed criterion (from `*discover`). */
  Criterion: "criterion",
  /** an open near-duplicate pair (`nd-…`, from the merge ledger). */
  NearDuplicatePair: "near-duplicate-pair",
  /** a judge observation with no matching criterion (from `*review` / the walks). */
  Observation: "observation",
  /** a specific judge verdict the operator disputed (from `*review`). */
  Verdict: "verdict",
} as const;
export type DecisionTargetKindValue =
  (typeof DecisionTargetKind)[keyof typeof DecisionTargetKind];

/** One durable operator ruling. */
export interface OperatorDecision {
  /** STABLE across runs — content-derived, order-independent. */
  decisionId: string;
  kind: DecisionKindValue;
  targetKind: DecisionTargetKindValue;
  /** the criterion id / pair id / observation id the ruling is about. */
  target: string;
  /**
   * The criterion statement VERBATIM at ruling time. Load-bearing for two reasons: a
   * tombstone must be comparable against a future proposal that carries a different id,
   * and a ruling must stay readable after the thing it ruled on has gone.
   */
  statement?: string;
  /** WHY — shown back to the operator when a rejected item recurs. */
  rationale?: string;
  /** the amended statement (kind === "revise"). */
  revisedStatement?: string;
  /** which run surfaced it (provenance, never a clock). */
  runId?: string;
}

/** The durable, append-only decision ledger. */
export interface DecisionsStore {
  decisions: OperatorDecision[];
  /** a pure counter, bumped per append (NO clock — byte-identity). */
  version: number;
}

/** A fresh empty store. PURE. */
export function emptyDecisionsStore(): DecisionsStore {
  return { decisions: [], version: 0 };
}

/**
 * The STABLE id of a ruling: content-derived from (kind, targetKind, target) so the SAME
 * ruling recorded twice collapses to one entry rather than accumulating duplicates.
 *
 * Deliberately NOT including the rationale or runId: re-affirming the same ruling with
 * different wording is the same decision, and a store that grew a new row each time the
 * operator restated themselves would be a log, not a ledger. PURE.
 */
export function decisionId(
  kind: DecisionKindValue,
  targetKind: DecisionTargetKindValue,
  target: string,
): string {
  return `dec-${fnv1aHex(`${kind}::${targetKind}::${target}`)}`;
}

/**
 * Append rulings to the store, MONOTONICALLY.
 *
 * Every prior decision is retained in its original order. A decision already present is
 * REFRESHED IN PLACE (latest rationale / statement) and keeps its id, so re-submitting a
 * review does not duplicate the ledger.
 *
 * A ruling that REVERSES an earlier one on the same target is appended as its own entry —
 * both survive, and `effectiveDecision` resolves which one is current. Overwriting the old
 * one would destroy the fact that the operator changed their mind, which is exactly the
 * kind of history this store exists to keep. PURE.
 */
export function recordDecisions(
  store: DecisionsStore,
  incoming: readonly Omit<OperatorDecision, "decisionId">[],
): DecisionsStore {
  const out: OperatorDecision[] = store.decisions.map((d) => ({ ...d }));
  const indexOf = new Map(out.map((d, i) => [d.decisionId, i]));
  for (const raw of incoming) {
    const id = decisionId(raw.kind, raw.targetKind, raw.target);
    const at = indexOf.get(id);
    const entry: OperatorDecision = { decisionId: id, ...raw };
    if (at === undefined) {
      indexOf.set(id, out.length);
      out.push(entry);
    } else {
      out[at] = { ...out[at]!, ...entry };
    }
  }
  assertMonotonicGrowth(store.decisions, out, (d) => d.decisionId);
  return { decisions: out, version: store.version + 1 };
}

/**
 * The CURRENT ruling for a target — the LAST recorded one wins, because a later ruling is
 * the operator changing their mind and the ledger keeps both. Returns undefined when the
 * target was never ruled on (which is what "never seen" means, and is precisely the state
 * the system previously could not distinguish from "already rejected"). PURE.
 */
export function effectiveDecision(
  store: DecisionsStore,
  target: string,
): OperatorDecision | undefined {
  let found: OperatorDecision | undefined;
  for (const d of store.decisions) if (d.target === target) found = d;
  return found;
}

/**
 * Every REJECTED item still in force — the tombstones.
 *
 * This is the anti-rediscovery input (G5): it is handed to the mining agent so it does not
 * re-propose what the operator said no to, and it is the list a new proposal is compared
 * against before the operator is asked again. A target later ACCEPTED is not a tombstone —
 * `effectiveDecision` decides, so a reversal is honoured rather than shadowed. PURE.
 */
export function tombstones(store: DecisionsStore): OperatorDecision[] {
  const seen = new Set<string>();
  const out: OperatorDecision[] = [];
  for (const d of store.decisions) {
    if (seen.has(d.target)) continue;
    seen.add(d.target);
    const eff = effectiveDecision(store, d.target);
    if (eff !== undefined && eff.kind === DecisionKind.Reject) out.push(eff);
  }
  return out;
}

/** Every ACCEPTED item still in force (the permanent-membership half). PURE. */
export function accepted(store: DecisionsStore): OperatorDecision[] {
  const seen = new Set<string>();
  const out: OperatorDecision[] = [];
  for (const d of store.decisions) {
    if (seen.has(d.target)) continue;
    seen.add(d.target);
    const eff = effectiveDecision(store, d.target);
    if (eff !== undefined && eff.kind === DecisionKind.Accept) out.push(eff);
  }
  return out;
}

/** What `applyDecisions` did — auditable, so "it was applied" is never taken on faith. */
export interface ApplyDecisionsResult {
  suite: LivingSuite<MinedCriterion>;
  /** criterion ids made PERMANENT by an accept this pass. */
  admitted: string[];
  /** criterion ids whose statement an accepted revise amended. */
  revised: string[];
  /**
   * Accepted targets with NO candidate to admit — a NAMED degrade, never a silent skip.
   * An accept that admits nothing means the proposal it referred to was not supplied,
   * and a caller must be able to see that rather than assume success.
   */
  unmatched: string[];
}

/**
 * G4 — make the operator's rulings STICK in the living suite.
 *
 *   accept  → the criterion is APPENDED permanently, carrying its `check_method` (the
 *             kind decides which machinery runs it — code, judge, or hybrid — so
 *             admitting a statement without its kind would admit an unrunnable rule) and
 *             its severity.
 *   reject  → NOTHING is appended, and nothing is removed. The tombstone in the store is
 *             the whole effect. This is why growth stays monotonic.
 *   revise  → the amended statement is admitted, LINKED to the original via `aliases`, so
 *             an outstanding reference to the pre-revision id still resolves.
 *
 * `candidates` are the proposals currently on the table (from `*discover`); a decision
 * names one by id. Admission goes through `growLivingSuite`, so the monotonic-growth
 * invariant is enforced by the same guard as every other append. PURE.
 */
export function applyDecisions(
  suite: LivingSuite<MinedCriterion>,
  store: DecisionsStore,
  candidates: readonly MinedCriterion[],
): ApplyDecisionsResult {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const present = new Set(suite.entries.map((c) => c.id));
  const admit: MinedCriterion[] = [];
  const admitted: string[] = [];
  const revised: string[] = [];
  const unmatched: string[] = [];

  for (const d of store.decisions) {
    // a superseded ruling must not act — only what is CURRENTLY in force.
    if (effectiveDecision(store, d.target)?.decisionId !== d.decisionId) continue;
    if (d.kind === DecisionKind.Reject) continue; // a tombstone appends nothing
    if (d.targetKind !== DecisionTargetKind.Criterion && d.targetKind !== DecisionTargetKind.Observation) {
      continue; // pair/verdict rulings do not admit criteria
    }
    const candidate = byId.get(d.target);
    if (candidate === undefined) { unmatched.push(d.target); continue; }
    if (present.has(candidate.id)) continue; // already permanent — accepting twice is a no-op

    if (d.kind === DecisionKind.Revise && d.revisedStatement !== undefined) {
      admit.push({
        ...candidate,
        statement: d.revisedStatement,
        aliases: [...(candidate.aliases ?? []), candidate.id],
      });
      revised.push(candidate.id);
    } else {
      admit.push(candidate);
    }
    admitted.push(candidate.id);
    present.add(candidate.id);
  }

  return {
    // growLivingSuite is a no-op on an empty append, so a reject-only pass leaves the
    // suite untouched rather than bumping its version for nothing.
    suite: admit.length > 0 ? growLivingSuite(suite, admit, (c) => c.id) : suite,
    admitted, revised, unmatched,
  };
}
