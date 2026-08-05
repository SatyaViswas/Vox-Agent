import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { DeploySemantics, type DeploySemanticsValue } from "./ship-manifest.ts";
import {
  FailureClass,
  type RefinementDisposition,
  type RefinementLedgerEntry,
} from "./refinement.ts";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the CI-green monitor FSM + crash-recoverable checkpoint (ship PRD §4, P2).
//
// A deterministic, checkpointed state machine the ship-monitor drives on the `ci`
// event lane of the orchestrator event-bus (scripts/monitor/event-bus.ts — CONSUMED,
// never forked). The monitor polls `gh pr checks`, classifies red checks
// (refinement.ts), and checkpoints monitor-state.json after EVERY transition so a
// crashed monitor resumes exactly where it left off and `*ship-status` reads it.
//
// This module is the PURE topology + persistence core:
//   stepCiFsm(state, event, ctx)   the §4 state-diagram reducer (no I/O, no clock)
//   ShipMonitorStateSchema         the checkpoint contract (TypeBox, closed, frozen)
//   applyTransition(...)           step + append CI observation / ledger, immutably
//
// The FSM mirrors the ship PRD §4 diagram verbatim:
//   PR_OPEN → CI_PENDING → (CI_GREEN → MERGE_GATE → MERGED → {WATCHING | AWAITING_INSTALL})
//                        ↘ (CI_RED → CLASSIFY → {REFINE → CI_PENDING | ESCALATE})
//   MERGE_GATE → ABORTED (operator declines) ; AWAITING_INSTALL → WATCHING (installed-confirm)
//
// The monitor NEVER pushes/merges/deploys (INV-SHIP-4) — it observes + recommends.
// The reducer only computes the next state; the parent gates and the fix actor
// amends. Determinism: same (state, event, ctx) ⇒ same next state; the wall-clock
// stamp on every observation/history entry is INJECTED, never self-read.
// ---------------------------------------------------------------------------

/** The §4 FSM states (verbatim from the ship PRD state diagram). */
export const CiFsmState = {
  PrOpen: "PR_OPEN",
  CiPending: "CI_PENDING",
  CiGreen: "CI_GREEN",
  CiRed: "CI_RED",
  Classify: "CLASSIFY",
  Refine: "REFINE",
  Escalate: "ESCALATE",
  MergeGate: "MERGE_GATE",
  Merged: "MERGED",
  AwaitingInstall: "AWAITING_INSTALL",
  Watching: "WATCHING",
  Aborted: "ABORTED",
} as const;
export type CiFsmStateValue = (typeof CiFsmState)[keyof typeof CiFsmState];

/** The states from which no further CI-FSM transition is legal (P2 boundary). */
export const CI_FSM_TERMINAL: ReadonlySet<CiFsmStateValue> = new Set<CiFsmStateValue>([
  CiFsmState.Escalate,
  CiFsmState.Aborted,
  CiFsmState.Watching, // the watch phase (P3) takes over from here
]);

/**
 * The events that drive the FSM. Discriminated on `kind`. The ship-monitor
 * constructs one per observation and feeds it to `stepCiFsm`.
 *
 * `ci-observed` (red) carries the pre-computed refinement DISPOSITION
 * (refinement.evaluateRefinement) so the FSM stays a pure topology reducer while
 * the mechanical/grant POLICY lives in refinement.ts. A red observation with no
 * disposition is a caller error (classification is mandatory before transition).
 */
export type CiFsmEvent =
  | { kind: "checks-registered" }
  | { kind: "ci-observed"; conclusion: "green" }
  | { kind: "ci-observed"; conclusion: "red"; disposition: RefinementDisposition }
  | { kind: "refine-pushed" }
  | { kind: "merge-approved" }
  | { kind: "merge-declined" }
  | { kind: "deploy-confirm" } // direct-load: the merge IS the deploy
  | { kind: "await-install" } // installed-copy: enter AWAITING_INSTALL
  | { kind: "installed-confirmed" }; // installed-copy: the install landed → open the watch

export interface CiFsmContext {
  /** KP-3 — direct-load ⇒ deploy-confirm at merge; installed-copy ⇒ await install first. */
  deploySemantics: DeploySemanticsValue;
}

export interface FsmStepResult {
  next: CiFsmStateValue;
  ok: boolean;
  /** WHY the transition was taken or refused (audit / history note). */
  reason: string;
}

/** A concise "illegal transition" refusal (state unchanged). */
function refuse(state: CiFsmStateValue, event: CiFsmEvent): FsmStepResult {
  return {
    next: state,
    ok: false,
    reason: `illegal transition: no rule for event \`${event.kind}\` in state \`${state}\``,
  };
}

/**
 * The §4 reducer. Pure: given the current state + an event (+ deploy semantics),
 * return the next state and WHY. An illegal (state, event) pair is REFUSED
 * (state unchanged, ok:false) rather than throwing — the monitor records the
 * refusal and re-checkpoints; it never silently jumps states.
 */
export function stepCiFsm(
  state: CiFsmStateValue,
  event: CiFsmEvent,
  ctx: CiFsmContext,
): FsmStepResult {
  switch (state) {
    case CiFsmState.PrOpen:
      if (event.kind === "checks-registered") {
        return { next: CiFsmState.CiPending, ok: true, reason: "checks registered on the PR" };
      }
      return refuse(state, event);

    case CiFsmState.CiPending:
      if (event.kind === "ci-observed" && event.conclusion === "green") {
        return { next: CiFsmState.CiGreen, ok: true, reason: "all checks passed" };
      }
      if (event.kind === "ci-observed" && event.conclusion === "red") {
        // CI_RED → CLASSIFY is folded into this transition: the caller supplies the
        // classification disposition; the FSM lands directly in REFINE or ESCALATE.
        if (event.disposition === "refine") {
          return { next: CiFsmState.Refine, ok: true, reason: "red · mechanical class · refining (§4)" };
        }
        if (event.disposition === "escalate") {
          return { next: CiFsmState.Escalate, ok: true, reason: "red · class other / exhausted / grant revoked → ESCALATE (§4)" };
        }
        // surface-preexisting: a base-branch failure is surfaced but does NOT
        // advance the FSM — it stays CI_PENDING (the real checks are still pending)
        // and the parent handles fix-or-attest out of band (§4.5).
        return { next: CiFsmState.CiPending, ok: true, reason: "red · pre-existing (base) — surfaced, not refined (§4.5)" };
      }
      return refuse(state, event);

    case CiFsmState.Refine:
      if (event.kind === "refine-pushed") {
        return { next: CiFsmState.CiPending, ok: true, reason: "mechanical fix pushed → re-poll CI" };
      }
      return refuse(state, event);

    case CiFsmState.CiGreen:
      if (event.kind === "merge-approved") {
        return { next: CiFsmState.Merged, ok: true, reason: "operator approved the merge gate" };
      }
      if (event.kind === "merge-declined") {
        return { next: CiFsmState.Aborted, ok: true, reason: "operator declined the merge gate" };
      }
      return refuse(state, event);

    case CiFsmState.Merged:
      // KP-3: direct-load ⇒ the merge is the deploy → open the watch immediately;
      // installed-copy ⇒ the watch stays CLOSED until an install-confirm event.
      if (event.kind === "deploy-confirm") {
        if (ctx.deploySemantics !== DeploySemantics.DirectLoad) {
          return {
            next: state,
            ok: false,
            reason: "deploy-confirm at bare merge is illegal for an installed-copy target (KP-3) — await installed-confirmed",
          };
        }
        return { next: CiFsmState.Watching, ok: true, reason: "direct-load: merge is the deploy → open the watch" };
      }
      if (event.kind === "await-install") {
        if (ctx.deploySemantics !== DeploySemantics.InstalledCopy) {
          return { next: state, ok: false, reason: "await-install only applies to an installed-copy target (KP-3)" };
        }
        return { next: CiFsmState.AwaitingInstall, ok: true, reason: "installed-copy: watch stays closed pending install-confirm (KP-3)" };
      }
      return refuse(state, event);

    case CiFsmState.AwaitingInstall:
      if (event.kind === "installed-confirmed") {
        return { next: CiFsmState.Watching, ok: true, reason: "installed-confirmation event → open the watch (KP-3)" };
      }
      return refuse(state, event);

    // Terminal / P3-owned states (ESCALATE · ABORTED · WATCHING) and the
    // transient CLASSIFY/CI_RED handles — no further CI-FSM transition is legal.
    default:
      return refuse(state, event);
  }
}

// ── The crash-recoverable checkpoint — monitor-state.json (§4) ────────────────

/** One CI-check observation (the CI timeline). Shape kept read-compatible with
 * ship-status.ts `MonitorState.ci_timeline` (`{check, conclusion, at}`). */
export const CiObservationSchema = Type.Object(
  {
    check: Type.String({ minLength: 1 }), // the check name (e.g. "lint", "test")
    conclusion: Type.String({ minLength: 1 }), // pass | fail | pending | <gh conclusion>
    at: Type.String({ minLength: 1 }), // INJECTED ISO stamp
  },
  { additionalProperties: false },
);
export type CiObservation = Static<typeof CiObservationSchema>;

/** One FSM history entry — the append-only transition log (crash-recovery audit). */
export const FsmHistoryEntrySchema = Type.Object(
  {
    state: Type.String({ minLength: 1 }),
    event: Type.String({ minLength: 1 }),
    at: Type.String({ minLength: 1 }), // INJECTED ISO stamp
    note: Type.String(),
  },
  { additionalProperties: false },
);
export type FsmHistoryEntry = Static<typeof FsmHistoryEntrySchema>;

const literalUnion = <T extends Record<string, string>>(o: T) =>
  Type.Union((Object.values(o) as T[keyof T][]).map((v) => Type.Literal(v)));

const FailureClassEnum = literalUnion(FailureClass);

const RefinementLedgerEntrySchema = Type.Object(
  {
    n: Type.Integer({ minimum: 1 }),
    class: FailureClassEnum,
    evidence_excerpt: Type.String(),
    files_touched: Type.Array(Type.String()),
    push_sha: Type.String(),
    result: literalUnion({ Pending: "pending", Green: "green", Red: "red", Escalated: "escalated" }),
    within_grant: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * The ship-monitor checkpoint (§4). Written after EVERY transition to
 * `.mutagent/ship/runs/<ship-id>/monitor-state.json`. Closed object — an
 * undeclared field is caught. Crash-recoverable: the FSM state + CI timeline +
 * refinement ledger + grant + history fully reconstruct the run.
 */
export const ShipMonitorStateSchema = Type.Object(
  {
    ship_id: Type.String({ minLength: 1 }),
    fsm_state: literalUnion(CiFsmState),
    ci_timeline: Type.Array(CiObservationSchema),
    refinement_ledger: Type.Array(RefinementLedgerEntrySchema),
    refinement_attempts: Type.Integer({ minimum: 0 }), // consumed budget (pre-existing excluded)
    grant: Type.Object(
      {
        pre_grant: literalUnion({ None: "none", Mechanical: "mechanical" }),
        grant_revoked: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    history: Type.Array(FsmHistoryEntrySchema),
  },
  { additionalProperties: false },
);
export type ShipMonitorState = Static<typeof ShipMonitorStateSchema>;

const MonitorStateChecker = TypeCompiler.Compile(ShipMonitorStateSchema);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate a checkpoint (crash-recovery + `*ship-status` read both rely on shape). Pure. */
export function validateMonitorState(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!MonitorStateChecker.Check(obj)) {
    for (const e of MonitorStateChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Build a fresh monitor checkpoint at ARM time (FSM starts in PR_OPEN). Pure. */
export function makeMonitorState(input: {
  shipId: string;
  preGrant?: "none" | "mechanical";
}): ShipMonitorState {
  return {
    ship_id: input.shipId,
    fsm_state: CiFsmState.PrOpen,
    ci_timeline: [],
    refinement_ledger: [],
    refinement_attempts: 0,
    grant: { pre_grant: input.preGrant ?? "none", grant_revoked: false },
    history: [],
  };
}

/**
 * Apply an FSM event to a checkpoint IMMUTABLY: step the FSM, append a history
 * entry (INJECTED `at` stamp), and — for a legal transition — carry the grant /
 * ledger updates. Returns the new checkpoint + the step result. This is the one
 * function the ship-monitor calls per observation; it re-checkpoints the result.
 *
 * `at` is injected (no self-read clock) so the whole apply is deterministic.
 */
export function applyTransition(
  state: ShipMonitorState,
  event: CiFsmEvent,
  ctx: CiFsmContext,
  at: string,
  opts?: {
    /** A CI observation to append to the timeline alongside this transition. */
    observation?: CiObservation;
    /** A ledger append (a refinement attempt) to record with this transition. */
    ledgerEntry?: RefinementLedgerEntry;
    /** The grant state AFTER this transition (from evaluateRefinement). */
    grant?: { pre_grant: "none" | "mechanical"; grant_revoked: boolean };
    /** Did this transition consume a refinement attempt (§4.3)? */
    consumesAttempt?: boolean;
  },
): { state: ShipMonitorState; result: FsmStepResult } {
  const result = stepCiFsm(state.fsm_state, event, ctx);

  const nextLedger = opts?.ledgerEntry
    ? [...state.refinement_ledger, opts.ledgerEntry]
    : state.refinement_ledger;

  const next: ShipMonitorState = {
    ...state,
    fsm_state: result.ok ? result.next : state.fsm_state,
    ci_timeline: opts?.observation
      ? [...state.ci_timeline, opts.observation]
      : state.ci_timeline,
    refinement_ledger: nextLedger,
    refinement_attempts:
      opts?.consumesAttempt === true
        ? state.refinement_attempts + 1
        : state.refinement_attempts,
    grant: opts?.grant ?? state.grant,
    history: [
      ...state.history,
      { state: state.fsm_state, event: event.kind, at, note: result.reason },
    ],
  };

  return { state: next, result };
}
