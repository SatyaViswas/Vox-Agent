/**
 * scripts/criterion-identity.ts — G5: "have we already ruled on this?", as a HYBRID.
 * ---------------------------------------------------------------------------
 * THE PROBLEM. A judge notices the same underlying failure every run and writes it
 * differently every time:
 *     run 1 → "the agent announced an action and never performed it"
 *     run 2 → "reply asserts a completed unsubscribe with no corresponding tool call"
 *     run 3 → "stated outcome not supported by the trajectory"
 * Three phrasings, one rule. So the question is not "how do we keep a list" — it is how
 * we recognise that a new proposal is something the operator ALREADY ruled on, when it
 * does not look like it.
 *
 * WHY NOT `merge-criteria.ts`. That module is a SAFETY NET, not a recogniser, and its own
 * header says so: it finds lexical candidates, applies two deterministic guards that can
 * only BLOCK a merge, and records what it refuses to decide. Its comment is explicit —
 * "a bag of words cannot see a polarity, scope or noun inversion" and "NO LLM anywhere in
 * this path". The three statements above share almost no vocabulary, so their similarity
 * is near zero and they would never even become candidates there. Nothing in that module
 * is changed by this one.
 *
 * SO THIS IS A HYBRID, and the division of labour is the whole design:
 *
 *   CODE (this file)  the formal data interface + the correctness checks. It builds the
 *                     shortlist to compare against, validates the shape of what comes
 *                     back, applies the veto guards, and maps a verdict to an outcome.
 *                     It NEVER decides that two rules are the same.
 *   AGENT             the semantic call, and only that. It sees one proposal and a small
 *                     shortlist — never the whole corpus — and it never writes anything.
 *
 * THE ASYMMETRY THAT MAKES IT SAFE. The guards may only VETO a claimed match, never
 * confirm one. If the agent says "same rule" but the guards see a polarity inversion, the
 * guards win — a mechanical fact beats a judgement. If the guards are silent, the agent
 * decides. Suppression therefore requires BOTH the agent to claim a match AND the guards
 * to stay silent, so the worst case is that the operator is shown something they already
 * ruled on. The dangerous case — silently swallowing a genuinely new criterion — cannot
 * happen. Every uncertain path (unsure · malformed · vetoed · no match) resolves to SHOW.
 *
 * PURE + deterministic given the agent's verdict as an INPUT: no clock, no random, no
 * network, no fs. The non-determinism lives in the agent call, which the caller performs
 * and passes in — which is also what makes every branch here unit-testable with a stub.
 */
import { contrastiveMarkers, statementSimilarity, statementTokens } from "./merge-criteria.ts";
import { DecisionKind, type OperatorDecision } from "./decisions-store.ts";

/** How a proposal relates to something already ruled on. `unsure` is FIRST-CLASS. */
export const IdentityRelation = {
  /** the same rule, differently worded. */
  Same: "same",
  /** a strictly narrower case of the prior rule. */
  Narrower: "narrower",
  /** a strictly broader rule that subsumes the prior one. */
  Broader: "broader",
  /** genuinely a different rule. */
  Different: "different",
  /**
   * The agent could not tell. A judge forced to choose is a judge that guesses, and a
   * guess here silently suppresses a real finding — so this is a legitimate answer with a
   * defined, safe outcome (SHOW), never a failure to be retried into a decision.
   */
  Unsure: "unsure",
} as const;
export type IdentityRelationValue = (typeof IdentityRelation)[keyof typeof IdentityRelation];

/** One entry the agent compares a proposal against. */
export interface IdentityCandidate {
  /** the id of the prior thing ruled on (criterion id / observation id). */
  id: string;
  statement: string;
  /** what the operator ruled: accept ⇒ already live · reject ⇒ a tombstone. */
  kind: OperatorDecision["kind"];
  /** the operator's stated reason, shown back when a rejected item recurs. */
  rationale?: string;
}

/** What the agent is asked to compare — built by code, never by the agent. */
export interface IdentityShortlist {
  proposalId: string;
  proposalStatement: string;
  candidates: IdentityCandidate[];
  /**
   * How many priors were NOT shown because of the cap. DECLARED, never silent: a bounded
   * comparison that reads as exhaustive is how a real match gets missed without anyone
   * noticing. A caller that sees a non-zero value here knows the answer is partial.
   */
  omitted: number;
}

/** The agent's answer. Validated by `parseIdentityVerdict` before it is ever trusted. */
export interface IdentityVerdict {
  relation: IdentityRelationValue;
  /** REQUIRED for same/narrower/broader — which candidate it matched. */
  matchedId?: string;
  /** why — carried into the report so a suppression is always explicable. */
  rationale?: string;
}

/** The cap on how many priors one agent call compares against. */
export const DEFAULT_SHORTLIST_SIZE = 12;

/**
 * Build the comparison set for ONE proposal: the priors most worth looking at, most
 * lexically similar first.
 *
 * The ranking uses `statementSimilarity` purely to ORDER the shortlist — it is not a
 * decision and nothing is excluded for scoring low. That distinction matters: lexical
 * similarity is exactly the signal that FAILS on reworded rules, so using it to filter
 * would reintroduce the bug this module exists to fix. It only decides what to read
 * first, and whatever the cap drops is counted in `omitted`. PURE.
 */
export function buildIdentityShortlist(
  proposal: { id: string; statement: string },
  priors: readonly IdentityCandidate[],
  size: number = DEFAULT_SHORTLIST_SIZE,
): IdentityShortlist {
  const ranked = [...priors].sort(
    (x, y) =>
      statementSimilarity(proposal.statement, y.statement) -
      statementSimilarity(proposal.statement, x.statement),
  );
  return {
    proposalId: proposal.id,
    proposalStatement: proposal.statement,
    candidates: ranked.slice(0, size),
    omitted: Math.max(0, ranked.length - size),
  };
}

/**
 * Validate an agent's raw answer. A malformed verdict is REPORTED, never coerced into a
 * decision — silently repairing it would be the system deciding on the agent's behalf,
 * which is precisely the authority this module refuses to take.
 * Returns the verdict, or an error string naming what was wrong. PURE.
 */
export function parseIdentityVerdict(raw: unknown): { verdict: IdentityVerdict } | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "identity verdict is not an object" };
  const r = raw as Record<string, unknown>;
  const relation = r["relation"];
  const known = Object.values(IdentityRelation) as string[];
  if (typeof relation !== "string" || !known.includes(relation)) {
    return { error: `identity verdict has an unknown relation '${String(relation)}' (expected one of ${known.join(" | ")})` };
  }
  const needsMatch = relation === IdentityRelation.Same || relation === IdentityRelation.Narrower || relation === IdentityRelation.Broader;
  const matchedId = r["matchedId"];
  if (needsMatch && (typeof matchedId !== "string" || matchedId.length === 0)) {
    return { error: `relation '${relation}' claims a match but names no matchedId` };
  }
  const verdict: IdentityVerdict = { relation: relation as IdentityRelationValue };
  if (typeof matchedId === "string" && matchedId.length > 0) verdict.matchedId = matchedId;
  if (typeof r["rationale"] === "string") verdict.rationale = r["rationale"];
  return { verdict };
}

/** Why the deterministic guards refused a claimed match. */
export interface GuardVeto {
  reason: string;
}

/**
 * THE VETO. Mechanical reasons two statements CANNOT be the same rule, however similar the
 * wording — reusing the two guards `merge-criteria.ts` already calibrated (measured on 32
 * pairs at zero false merges) via its exported primitives. Nothing there is modified,
 * re-tuned, or re-implemented.
 *
 *   1. contrastive-marker parity — statements turning on opposite words (includes vs
 *      excludes, before vs after, at least vs at most) are different rules.
 *   2. no 1-for-1 substitution — each side holding exactly one content token the other
 *      lacks is a swapped subject, not a rephrasing.
 *
 * Returns a veto or null. This function can only ever say NO. PURE.
 */
export function vetoIdentityMatch(a: string, b: string): GuardVeto | null {
  const ma = contrastiveMarkers(a);
  const mb = contrastiveMarkers(b);
  const onlyMa = [...ma].filter((m) => !mb.has(m));
  const onlyMb = [...mb].filter((m) => !ma.has(m));
  if (onlyMa.length > 0 || onlyMb.length > 0) {
    return { reason: `marker parity: [${[...ma].sort().join(",")}] vs [${[...mb].sort().join(",")}]` };
  }
  const ta = statementTokens(a);
  const tb = statementTokens(b);
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (onlyA.length === 1 && onlyB.length === 1) {
    return { reason: `one-for-one substitution: '${onlyA[0]}' vs '${onlyB[0]}'` };
  }
  return null;
}

/** What the operator actually sees. */
export const IdentityOutcome = {
  /** already live in the suite — attach as reinforcing evidence, do not re-propose. */
  SuppressedAccepted: "suppressed-accepted",
  /** previously rejected — collapse into "previously rejected", with the original reason. */
  SuppressedRejected: "suppressed-rejected",
  /** narrower/broader than a live criterion — an AMENDMENT, not a new rule. */
  Amendment: "amendment",
  /** show it as a normal proposal. Every uncertain path lands here. */
  Show: "show",
} as const;
export type IdentityOutcomeValue = (typeof IdentityOutcome)[keyof typeof IdentityOutcome];

export interface IdentityResolution {
  outcome: IdentityOutcomeValue;
  /** the prior this was matched to, when one applies. */
  matchedId?: string;
  /** the human-readable WHY — always populated, so no suppression is ever unexplained. */
  reason: string;
  /** set when the guards overruled a claimed match (the safety asymmetry firing). */
  vetoed?: string;
}

/**
 * Map a validated agent verdict to what the operator sees, applying the veto.
 *
 * ORDER IS LOAD-BEARING and reads as the safety argument:
 *   1. no claimed match, or `unsure`            → SHOW
 *   2. the named candidate does not exist        → SHOW (never trust a dangling id)
 *   3. the guards veto the claimed match         → SHOW (mechanical fact beats judgement)
 *   4. only now: suppress / amend by prior ruling
 * Suppression is the ONLY branch requiring everything to line up. PURE.
 */
export function resolveIdentity(
  verdict: IdentityVerdict,
  shortlist: IdentityShortlist,
): IdentityResolution {
  if (verdict.relation === IdentityRelation.Unsure) {
    return { outcome: IdentityOutcome.Show, reason: "the identity check was not confident — shown rather than guessed" };
  }
  if (verdict.relation === IdentityRelation.Different || verdict.matchedId === undefined) {
    return { outcome: IdentityOutcome.Show, reason: "no prior ruling covers this — a genuinely new proposal" };
  }
  const match = shortlist.candidates.find((c) => c.id === verdict.matchedId);
  if (match === undefined) {
    return {
      outcome: IdentityOutcome.Show,
      reason: `the identity check named '${verdict.matchedId}', which is not in the compared set — shown rather than trusted`,
    };
  }
  const veto = vetoIdentityMatch(shortlist.proposalStatement, match.statement);
  if (veto !== null) {
    return {
      outcome: IdentityOutcome.Show,
      matchedId: match.id,
      reason: `a match to '${match.id}' was claimed, but these cannot be the same rule — shown as new`,
      vetoed: veto.reason,
    };
  }
  if (verdict.relation === IdentityRelation.Narrower || verdict.relation === IdentityRelation.Broader) {
    return {
      outcome: IdentityOutcome.Amendment,
      matchedId: match.id,
      reason: `${verdict.relation} than '${match.id}' — an amendment to an existing criterion, not a new one`,
    };
  }
  if (match.kind === DecisionKind.Reject) {
    return {
      outcome: IdentityOutcome.SuppressedRejected,
      matchedId: match.id,
      reason: `previously rejected as '${match.id}'${match.rationale !== undefined ? ` — ${match.rationale}` : ""}`,
    };
  }
  return {
    outcome: IdentityOutcome.SuppressedAccepted,
    matchedId: match.id,
    reason: `already covered by '${match.id}', which is live in the suite — attached as reinforcing evidence`,
  };
}
