// ---------------------------------------------------------------------------
// mutagent-optimize — the UNIFIED amend contract (`AmendRequest`) + adapters.
//
// WHY: the ⑤ OPTIMIZE S1 build handover is fed by TWO "amend request" dialects —
//   • `EddChangeRequest` — what the EVALUATOR emits (eval→optimize / EDD loop, F18).
//       mutagent-evaluator/.../scripts/edd/edd-types.ts
//   • `Remedy` (the diagnostics "RemedyPacket") — what DIAGNOSTICS emits
//       (diagnose→optimize). mutagent-diagnostics/.../scripts/normalize/trace.ts
// Two shapes for the same job = drift risk. This module is the ONE superset the
// optimize consumer accepts, plus lossless bidirectional adapters for each dialect.
//
// WHERE / STANDALONE INVARIANT: published skills NEVER cross-import (the config-schema
// precedent — parity is mirrored INLINE, not imported; see config/parity.test.ts in
// evaluator + diagnostics). So this contract is SELF-CONTAINED: the two dialect shapes
// are re-expressed here as local parity-mirror interfaces (`EddChangeRequestLike` /
// `RemedyLike`), and the round-trip test (amend-request.test.ts) mirrors the canonical
// field lists inline so a dialect change breaks the test until this superset follows.
// The unification is CONSUMER-SIDE: optimize adapts both dialects INBOUND; the emitters
// keep their native shipped output (each is a "view over the superset" via the round-trip).
//
// PURE: no clock, no random, no IO, no schema lib (matches optimize's pure-TS style —
// loop-state.ts / optimize-loop-run.ts carry no TypeBox). The validator is hand-rolled.
// ---------------------------------------------------------------------------

/** The FROZEN contract version. Bump only via an explicit, reviewed migration. */
export const AMEND_REQUEST_VERSION = "0.1.0" as const;

/** Which emitter/dialect an amend originated from — the lossless back-map discriminant. */
export const AmendOrigin = {
  /** the evaluator's EddChangeRequest (eval→optimize / EDD F18). */
  Eval: "eval",
  /** the diagnostics Remedy bundle (diagnose→optimize). */
  Diagnostics: "diagnostics",
} as const;
export type AmendOriginValue = (typeof AmendOrigin)[keyof typeof AmendOrigin];

/** The amend lifecycle status (superset of the EDD ChangeRequestStatus). */
export const AmendStatus = {
  Requested: "requested",
  Amended: "amended",
  Rejected: "rejected",
} as const;
export type AmendStatusValue = (typeof AmendStatus)[keyof typeof AmendStatus];

/** WHERE the engineer fixes (the evaluator's coarse target). */
export type AmendRemedyTarget = "agentspec" | "impl";

/** The change kind (the diagnostics changeType). */
export type AmendChangeType = "add" | "modify" | "delete" | "replace";

/** The categorical cost/correctness scale (the diagnostics scalars). */
export type AmendCostCorrectness = "low" | "medium" | "high";

/** The diagnostics diff absence marker. */
export type AmendDiffStatus = "source-unavailable" | "origin-unknown";

/**
 * One grounded failing case (the evaluator's FailingCaseRef). A simple shape,
 * typed precisely here (mirrors edd-types.ts `FailingCaseRefSchema`).
 */
export interface AmendFailingCaseRef {
  caseId: string;
  criterionId: string;
  critique: string;
  refs: Array<{ obs: string; path: string; value: string }>;
}

/** A before/after diff (the diagnostics `Remedy.diff`). */
export interface AmendDiff {
  before: string;
  after: string;
}

// ── The superset ────────────────────────────────────────────────────────────
/**
 * `AmendRequest` — the ONE amend contract the ⑤ OPTIMIZE consumer accepts. A strict
 * superset of BOTH dialects: every field of an `EddChangeRequest` (7) and every field
 * of a diagnostics `Remedy` (16, incl. nested) is representable, none lost.
 *
 * Shared fields (id, subject) appear once. Dialect-specific fields are optional — the
 * `origin` discriminant tells the back-adapter which subset to reconstruct.
 *
 * The three complex nested diagnostics fields (`failureOrigin`, `plan`, `feedbackOnFix`)
 * ride as structured PASS-THROUGH (`unknown`): they are validated on the diagnostics
 * side and preserved verbatim so the round-trip is lossless WITHOUT duplicating the deep
 * diagnostics type tree here (which the standalone invariant forbids importing).
 */
export interface AmendRequest {
  /** contract version — frozen. */
  amendVersion: typeof AMEND_REQUEST_VERSION;
  /** which dialect produced this (drives the lossless back-map). */
  origin: AmendOriginValue;
  /** superset of EddChangeRequest.requestId / Remedy.remedyId. */
  amendId: string;
  /** what is being amended. eval: EddChangeRequest.subject; diagnostics: injected by the caller. */
  subject: string;
  /** amend lifecycle. eval: the request's status; diagnostics: defaults to "requested". */
  status: AmendStatusValue;

  // ── WHERE (the target) ──
  /** eval: REQUIRED coarse target (agentspec|impl); diagnostics: omitted. */
  remedyTarget?: AmendRemedyTarget;
  /** diagnostics: concrete file/module/agent the remedy patches. */
  applyTarget?: string;
  /** diagnostics: apply routing class (local-agent|local-code-construct|remote). */
  targetClass?: string;
  /** diagnostics: the kind of change. */
  changeType?: AmendChangeType;

  // ── WHY (evidence + justification) ──
  /** eval: the grounded failing cases driving the request (≥1). */
  failingCases?: AmendFailingCaseRef[];
  /** eval: the NL proposed remedy (a hypothesis, not a mandate). */
  proposedRemedy?: string;
  /** diagnostics: comparative rationale (why THIS remedy). */
  rationale?: string;
  /** diagnostics: causal mechanism (why it works). */
  whyWorks?: string;
  /** diagnostics: the remedy title. */
  title?: string;
  /** diagnostics: implementation/operational cost. */
  cost?: AmendCostCorrectness;
  /** diagnostics: confidence the fix resolves the root cause. */
  correctness?: AmendCostCorrectness;
  /** diagnostics: enricher-derived priority (lower = higher). */
  rank?: number;

  // ── WHAT (the fix payload) ──
  /** diagnostics: ordered apply instructions (≥1). */
  applyInstructions?: string[];
  /** diagnostics: before/after diff (present iff the source is findable). */
  diff?: AmendDiff;
  /** diagnostics: diff absence marker (present iff `diff` is omitted). */
  diffStatus?: AmendDiffStatus;
  /** eval: 1-based EDD swing index. */
  swing?: number;

  // ── Structured pass-through (diagnostics-only nested; validated diagnostics-side) ──
  /** diagnostics: the structured FailureOrigin. Preserved verbatim. */
  failureOrigin?: unknown;
  /** diagnostics: the ActionablePlan. Preserved verbatim. */
  plan?: unknown;
  /** diagnostics: accumulated FeedbackOnFix[]. Preserved verbatim. */
  feedbackOnFix?: unknown;
}

// ── Local parity-mirror dialect shapes ──────────────────────────────────────
// These mirror the canonical dialect definitions. Kept in lockstep by
// amend-request.test.ts (inline field-list parity, config-parity-test style).

/** Parity mirror of evaluator edd-types.ts `EddChangeRequestSchema` (Static type). */
export interface EddChangeRequestLike {
  requestId: string;
  swing: number;
  subject: string;
  remedyTarget: AmendRemedyTarget;
  failingCases: AmendFailingCaseRef[];
  proposedRemedy: string;
  status: "requested";
}

/** Parity mirror of diagnostics trace.ts `Remedy` (interface). */
export interface RemedyLike {
  remedyId: string;
  title: string;
  failureOrigin: unknown;
  diff?: AmendDiff;
  diffStatus?: AmendDiffStatus;
  cost: AmendCostCorrectness;
  correctness: AmendCostCorrectness;
  rank: number;
  targetClass: string;
  plan?: unknown;
  applyTarget: string;
  rationale: string;
  whyWorks: string;
  applyInstructions: string[];
  changeType?: AmendChangeType;
  feedbackOnFix?: unknown;
}

// ── Dialect intake closure (fail-loud on an unknown inbound field) ───────────
// The adapters copy a KNOWN field set. Without a closed-key check on the INPUT, the
// instant an emitter grows a field (both dialects have — changeType/feedbackOnFix were
// later Remedy additions) it would vanish from the handover with ZERO signal — the exact
// drift W2I2 exists to close. So intake mirrors the canonical dialects' own
// `additionalProperties:false`: an unknown inbound key THROWS, it is never silently dropped.

/** The canonical `EddChangeRequest` key set (mirror of edd-types.ts `EddChangeRequestSchema`). */
export const EDD_CHANGE_REQUEST_KEYS: readonly string[] = [
  "requestId",
  "swing",
  "subject",
  "remedyTarget",
  "failingCases",
  "proposedRemedy",
  "status",
];

/** The canonical `Remedy` key set (mirror of trace.ts `Remedy`). */
export const REMEDY_KEYS: readonly string[] = [
  "remedyId",
  "title",
  "failureOrigin",
  "diff",
  "diffStatus",
  "cost",
  "correctness",
  "rank",
  "targetClass",
  "plan",
  "applyTarget",
  "rationale",
  "whyWorks",
  "applyInstructions",
  "changeType",
  "feedbackOnFix",
];

/**
 * Assert an inbound dialect object carries ONLY canonical keys. THROWS fail-loud (naming
 * the offending field) on any unknown key — a new emitter field must be wired into
 * AmendRequest + its adapter, never silently subset-copied away.
 */
function assertClosedDialect(input: unknown, allowed: readonly string[], dialect: string): void {
  if (typeof input !== "object" || input === null) {
    throw new Error(`${dialect} intake rejected — expected an object`);
  }
  const unknownKeys = Object.keys(input as Record<string, unknown>).filter((k) => !allowed.includes(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${dialect} intake rejected — unknown field(s) [${unknownKeys.join(", ")}]: the dialect is closed ` +
        `(additionalProperties:false). A new emitter field must be wired into AmendRequest + its adapter, ` +
        `not silently dropped.`,
    );
  }
}

// ── Adapters — evaluator dialect ⇄ superset (lossless) ───────────────────────

/** `EddChangeRequest` → `AmendRequest`. Every EDD field is carried; none lost. */
export function eddChangeRequestToAmend(edd: EddChangeRequestLike): AmendRequest {
  assertClosedDialect(edd, EDD_CHANGE_REQUEST_KEYS, "EddChangeRequest");
  return {
    amendVersion: AMEND_REQUEST_VERSION,
    origin: AmendOrigin.Eval,
    amendId: edd.requestId,
    subject: edd.subject,
    status: edd.status,
    remedyTarget: edd.remedyTarget,
    failingCases: edd.failingCases,
    proposedRemedy: edd.proposedRemedy,
    swing: edd.swing,
  };
}

/** `AmendRequest` (eval origin) → `EddChangeRequest`. Reconstructs the 7 EDD fields exactly. */
export function amendToEddChangeRequest(a: AmendRequest): EddChangeRequestLike {
  if (a.origin !== AmendOrigin.Eval) {
    throw new Error(
      `amendToEddChangeRequest: origin must be "eval" (got "${a.origin}") — a diagnostics amend has no EddChangeRequest view`,
    );
  }
  if (a.remedyTarget === undefined) throw new Error("amendToEddChangeRequest: missing remedyTarget");
  if (a.swing === undefined) throw new Error("amendToEddChangeRequest: missing swing");
  if (a.failingCases === undefined) throw new Error("amendToEddChangeRequest: missing failingCases");
  if (a.proposedRemedy === undefined) throw new Error("amendToEddChangeRequest: missing proposedRemedy");
  if (a.status !== AmendStatus.Requested) {
    throw new Error(`amendToEddChangeRequest: EddChangeRequest.status must be "requested" (got "${a.status}")`);
  }
  return {
    requestId: a.amendId,
    swing: a.swing,
    subject: a.subject,
    remedyTarget: a.remedyTarget,
    failingCases: a.failingCases,
    proposedRemedy: a.proposedRemedy,
    status: "requested",
  };
}

// ── Adapters — diagnostics dialect ⇄ superset (lossless) ─────────────────────

/**
 * `Remedy` → `AmendRequest`. Every `Remedy` field is carried; none lost. `subject` is
 * injected by the caller (a `Remedy` carries no subject — the diagnosed entity is
 * supplied by the diagnostics context). Optional dialect fields are set only when
 * present so absent stays absent across the round-trip.
 */
export function remedyToAmend(rem: RemedyLike, subject: string): AmendRequest {
  assertClosedDialect(rem, REMEDY_KEYS, "Remedy");
  const a: AmendRequest = {
    amendVersion: AMEND_REQUEST_VERSION,
    origin: AmendOrigin.Diagnostics,
    amendId: rem.remedyId,
    subject,
    status: AmendStatus.Requested,
    title: rem.title,
    failureOrigin: rem.failureOrigin,
    cost: rem.cost,
    correctness: rem.correctness,
    rank: rem.rank,
    targetClass: rem.targetClass,
    applyTarget: rem.applyTarget,
    rationale: rem.rationale,
    whyWorks: rem.whyWorks,
    applyInstructions: rem.applyInstructions,
  };
  if (rem.diff !== undefined) a.diff = rem.diff;
  if (rem.diffStatus !== undefined) a.diffStatus = rem.diffStatus;
  if (rem.plan !== undefined) a.plan = rem.plan;
  if (rem.changeType !== undefined) a.changeType = rem.changeType;
  if (rem.feedbackOnFix !== undefined) a.feedbackOnFix = rem.feedbackOnFix;
  return a;
}

/** `AmendRequest` (diagnostics origin) → `Remedy`. Reconstructs the 16 Remedy fields exactly. */
export function amendToRemedy(a: AmendRequest): RemedyLike {
  if (a.origin !== AmendOrigin.Diagnostics) {
    throw new Error(
      `amendToRemedy: origin must be "diagnostics" (got "${a.origin}") — an eval amend has no Remedy view`,
    );
  }
  if (a.title === undefined) throw new Error("amendToRemedy: missing title");
  if (a.cost === undefined) throw new Error("amendToRemedy: missing cost");
  if (a.correctness === undefined) throw new Error("amendToRemedy: missing correctness");
  if (a.rank === undefined) throw new Error("amendToRemedy: missing rank");
  if (a.targetClass === undefined) throw new Error("amendToRemedy: missing targetClass");
  if (a.applyTarget === undefined) throw new Error("amendToRemedy: missing applyTarget");
  if (a.rationale === undefined) throw new Error("amendToRemedy: missing rationale");
  if (a.whyWorks === undefined) throw new Error("amendToRemedy: missing whyWorks");
  if (a.applyInstructions === undefined) throw new Error("amendToRemedy: missing applyInstructions");
  const rem: RemedyLike = {
    remedyId: a.amendId,
    title: a.title,
    failureOrigin: a.failureOrigin,
    cost: a.cost,
    correctness: a.correctness,
    rank: a.rank,
    targetClass: a.targetClass,
    applyTarget: a.applyTarget,
    rationale: a.rationale,
    whyWorks: a.whyWorks,
    applyInstructions: a.applyInstructions,
  };
  if (a.diff !== undefined) rem.diff = a.diff;
  if (a.diffStatus !== undefined) rem.diffStatus = a.diffStatus;
  if (a.plan !== undefined) rem.plan = a.plan;
  if (a.changeType !== undefined) rem.changeType = a.changeType;
  if (a.feedbackOnFix !== undefined) rem.feedbackOnFix = a.feedbackOnFix;
  return rem;
}

// ── Consumer accept-gate — hand-rolled validator (fail-loud) ─────────────────

const AMEND_ORIGINS: readonly string[] = [AmendOrigin.Eval, AmendOrigin.Diagnostics];
const AMEND_STATUSES: readonly string[] = [AmendStatus.Requested, AmendStatus.Amended, AmendStatus.Rejected];
const COST_CORRECTNESS: readonly string[] = ["low", "medium", "high"];
const REMEDY_TARGETS: readonly string[] = ["agentspec", "impl"];
const CHANGE_TYPES: readonly string[] = ["add", "modify", "delete", "replace"];
const DIFF_STATUSES: readonly string[] = ["source-unavailable", "origin-unknown"];

/** The exact top-level key set of `AmendRequest` — closes the object (no smuggled fields). */
const AMEND_KEYS: readonly string[] = [
  "amendVersion",
  "origin",
  "amendId",
  "subject",
  "status",
  "remedyTarget",
  "applyTarget",
  "targetClass",
  "changeType",
  "failingCases",
  "proposedRemedy",
  "rationale",
  "whyWorks",
  "title",
  "cost",
  "correctness",
  "rank",
  "applyInstructions",
  "diff",
  "diffStatus",
  "swing",
  "failureOrigin",
  "plan",
  "feedbackOnFix",
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Collect every contract violation on a candidate amend. Returns [] when valid.
 * Enforces: required scalars, enum membership, the closed key set (no additional
 * properties), the eval/diagnostics dialect-required fields, and the diff XOR
 * diffStatus rule for a diagnostics amend that carries either.
 */
export function amendRequestViolations(input: unknown): string[] {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null) return ["not an object"];
  const a = input as Record<string, unknown>;

  for (const key of Object.keys(a)) {
    if (!AMEND_KEYS.includes(key)) problems.push(`unknown field "${key}"`);
  }

  if (a.amendVersion !== AMEND_REQUEST_VERSION) {
    problems.push(`amendVersion must be "${AMEND_REQUEST_VERSION}"`);
  }
  if (!isNonEmptyString(a.origin) || !AMEND_ORIGINS.includes(a.origin)) {
    problems.push(`origin must be one of ${AMEND_ORIGINS.join("|")}`);
  }
  if (!isNonEmptyString(a.amendId)) problems.push("amendId must be a non-empty string");
  if (!isNonEmptyString(a.subject)) problems.push("subject must be a non-empty string");
  if (!isNonEmptyString(a.status) || !AMEND_STATUSES.includes(a.status)) {
    problems.push(`status must be one of ${AMEND_STATUSES.join("|")}`);
  }

  if (a.remedyTarget !== undefined && !REMEDY_TARGETS.includes(a.remedyTarget as string)) {
    problems.push(`remedyTarget must be one of ${REMEDY_TARGETS.join("|")}`);
  }
  if (a.changeType !== undefined && !CHANGE_TYPES.includes(a.changeType as string)) {
    problems.push(`changeType must be one of ${CHANGE_TYPES.join("|")}`);
  }
  if (a.cost !== undefined && !COST_CORRECTNESS.includes(a.cost as string)) {
    problems.push(`cost must be one of ${COST_CORRECTNESS.join("|")}`);
  }
  if (a.correctness !== undefined && !COST_CORRECTNESS.includes(a.correctness as string)) {
    problems.push(`correctness must be one of ${COST_CORRECTNESS.join("|")}`);
  }
  if (a.diffStatus !== undefined && !DIFF_STATUSES.includes(a.diffStatus as string)) {
    problems.push(`diffStatus must be one of ${DIFF_STATUSES.join("|")}`);
  }
  if (a.swing !== undefined && (typeof a.swing !== "number" || !Number.isInteger(a.swing) || a.swing < 1)) {
    problems.push("swing must be a positive integer");
  }
  if (a.rank !== undefined && typeof a.rank !== "number") {
    problems.push("rank must be a number");
  }

  // diff XOR diffStatus — a remedy must never claim BOTH a concrete diff and "source not found".
  if (a.diff !== undefined && a.diffStatus !== undefined) {
    problems.push("diff and diffStatus are mutually exclusive (exactly one, or neither)");
  }

  // Dialect-required fields (the strict-superset guarantee for each origin).
  if (a.origin === AmendOrigin.Eval) {
    if (a.remedyTarget === undefined) problems.push("eval amend requires remedyTarget");
    if (a.swing === undefined) problems.push("eval amend requires swing");
    if (!Array.isArray(a.failingCases) || a.failingCases.length === 0) {
      problems.push("eval amend requires ≥1 failingCases");
    }
    if (!isNonEmptyString(a.proposedRemedy)) problems.push("eval amend requires proposedRemedy");
  } else if (a.origin === AmendOrigin.Diagnostics) {
    for (const f of ["title", "targetClass", "applyTarget", "rationale", "whyWorks"] as const) {
      if (!isNonEmptyString(a[f])) problems.push(`diagnostics amend requires ${f}`);
    }
    if (a.cost === undefined) problems.push("diagnostics amend requires cost");
    if (a.correctness === undefined) problems.push("diagnostics amend requires correctness");
    if (typeof a.rank !== "number") problems.push("diagnostics amend requires rank");
    if (!Array.isArray(a.applyInstructions) || a.applyInstructions.length === 0) {
      problems.push("diagnostics amend requires ≥1 applyInstructions");
    }
    // canonical `Remedy.failureOrigin` is REQUIRED. It rides as structured pass-through
    // (`unknown`) so we cannot type-check its interior, but a presence check is truer than
    // silently accepting a diagnostics amend that dropped its origin.
    if (a.failureOrigin === undefined) problems.push("diagnostics amend requires failureOrigin");
  }

  return problems;
}

/**
 * The consumer accept-gate: validate a candidate amend, THROW-loud on any violation,
 * return it typed on success. A malformed handover must never cross into the ⑤ OPTIMIZE
 * S1 build silently.
 */
export function validateAmendRequest(input: unknown): AmendRequest {
  const problems = amendRequestViolations(input);
  if (problems.length > 0) {
    throw new Error(`AmendRequest invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return input as AmendRequest;
}

/**
 * Collapse a structured amend into the NL build brief the existing S1 build handover
 * consumes (`TurnContext.remedy: string`). Deterministic. This is how the superset FEEDS
 * the current consumer without breaking its string seam:
 *   - eval:        the proposed remedy (+ the failing-case critiques for grounding).
 *   - diagnostics: the title + rationale + ordered apply instructions.
 */
export function amendToBuildRemedy(a: AmendRequest): string {
  if (a.origin === AmendOrigin.Eval) {
    const critiques = (a.failingCases ?? []).map((c) => `• ${c.criterionId}: ${c.critique}`);
    return [a.proposedRemedy ?? "", ...critiques].filter((s) => s.length > 0).join("\n");
  }
  const steps = (a.applyInstructions ?? []).map((s, i) => `${i + 1}. ${s}`);
  return [a.title, a.rationale, ...steps].filter((s): s is string => isNonEmptyString(s)).join("\n");
}
