import { lookupRoute } from "./dispatch.ts";
import {
  checkOnboardingComplete,
  SOURCE_STAGES,
  TARGET_STAGES,
} from "./onboarding-check.ts";
import type { MissingKey, OnboardingRunContext } from "./onboarding-check.ts";
import type { MutagentConfig } from "./config-schema.ts";
import type { AdlStageValue } from "./handover-contract.ts";

// ---------------------------------------------------------------------------
// O8 — execution gating (v0.2.0).
//
// gateExecution adjudicates whether a resolved *command may EXECUTE, given the
// current config + a small run-ctx. It enforces the SCOPED floors of the v0.2.0
// contract and nothing else:
//
//   1. MIGRATION floor — if the config is a LEGACY (pre-v0.2.0) config (loadConfig
//      returned `{ ok:false, legacy:true }`), block with `migration-required`. No
//      other floor runs — you must migrate before anything can gate.
//
//   2. ONBOARDING floor — for a command whose ROUTING stage needs a source and/or
//      a target and/or a provider, it calls checkOnboardingComplete(config,
//      [stage], runCtx) and, if incomplete, splits the result into the specific
//      blocker kinds (`source-required` / `target-required` / `provider-required`
//      / `config-error` for a broken SELECTION default (>1 `default: true`) /
//      `onboarding-incomplete` for the base keys). CRITICAL: this is the
//      shape-vs-completeness split — completeness is the completion-check's job;
//      this gate calls it, it does NOT tighten the config schema. *audit routes
//      to the evaluator but its routing stage is Audit — not a source stage — so
//      *audit demands no source (its judge_model base-floor still applies when
//      relevant, via checkOnboardingComplete).
//
//   3. APPROVAL floor — a `gated` command (CLI install / apply: *build, *diagnose,
//      *optimize, *onboard) is blocked `approval-required` unless
//      ctx.approval_granted.
//
// allowed = blockers.length === 0.
//
// Pure + deterministic: no I/O, no clock, no random. Reuses the SAME route table
// as scripts/dispatch.ts via lookupRoute — one source of truth for the routing
// stage + the gated flag (same-package import, not a sealed-sibling cross-ref).
// ---------------------------------------------------------------------------

/** A single reason a command is blocked from executing. Discriminated on `kind`. */
export type Blocker =
  | {
      kind: "onboarding-incomplete";
      /** The exact base config keys still required (from checkOnboardingComplete). */
      missing: MissingKey[];
      reason: string;
    }
  | {
      kind: "source-required";
      reason: string;
    }
  | {
      kind: "target-required";
      reason: string;
    }
  | {
      kind: "provider-required";
      reason: string;
    }
  | {
      kind: "config-error";
      /** Which role's selector is broken (source | target) — the ambiguous default. */
      key: "source-config-error" | "target-config-error";
      reason: string;
    }
  | {
      kind: "migration-required";
      reason: string;
    }
  | {
      kind: "approval-required";
      reason: string;
    }
  | {
      // INV-SHIP-1 (ship PRD §1.4) — an `invocation: operator-only` route was reached by a
      // non-operator caller (a trigger, a chained stage-advance, an agent, or a script).
      // Structurally refused: there is deliberately no programmatic entry into *ship / *rollback.
      kind: "invocation-refused";
      reason: string;
    };

export interface GateResult {
  /** True iff there are no blockers. */
  allowed: boolean;
  blockers: Blocker[];
}

/** The small injected context the gate reads (run-aware floors + approval). */
export interface GateContext {
  /**
   * Set when the operator has granted approval for a gated command (the
   * orchestrator-led batch-approval after platforms are configured). Absent /
   * false ⇒ a gated command is blocked.
   */
  approval_granted?: boolean;
  /** Evaluate mode — `discover` makes evaluate a source-consuming stage. */
  mode?: OnboardingRunContext["mode"];
  /** Evaluator judge runtime (renamed from substrate) — `in-house` needs a provider. */
  judge_runtime?: OnboardingRunContext["substrate"];
  /** True when APPLY is requested (build/optimize/diagnose write a fix ⇒ target floor). */
  apply_requested?: boolean;
  /**
   * Set true when the config is a LEGACY (pre-v0.2.0) config (loadConfig returned
   * `{ ok:false, legacy:true }`). Drives the migration-required floor.
   */
  legacy_config?: boolean;
  /**
   * INV-SHIP-1 (ship PRD §1.4). Set true when the immediate caller is an OPERATOR
   * utterance. An `invocation: operator-only` route (⑥ SHIP's `*ship` / `*rollback`)
   * is REFUSED unless this is true — a trigger / chained stage-advance / agent / script
   * carries no operator signal, so it fails closed (absent ⇒ non-operator ⇒ refused).
   */
  operator_invoked?: boolean;
}

/** True iff `stage` is a SOURCE stage (evaluate/diagnose — may consume a source). */
function isSourceStage(stage: AdlStageValue): boolean {
  return SOURCE_STAGES.includes(stage);
}

/** True iff `stage` is a TARGET-writing stage (build/optimize/diagnose). */
function isTargetStage(stage: AdlStageValue): boolean {
  return TARGET_STAGES.includes(stage);
}

/** Base-floor missing keys (everything NOT already surfaced as its own blocker kind). */
const SPECIFIC_KEYS = new Set([
  "source-required",
  "target-required",
  "provider-required",
  "source-config-error",
  "target-config-error",
]);

/**
 * Adjudicate whether `command` may execute against `config`.
 *
 * @param command the resolved *command (with or without a leading `*`).
 * @param config  the parsed (possibly partial) MutagentConfig (v0.2.0).
 * @param ctx     gate context: approval + run-aware floors (mode / judge_runtime /
 *                apply_requested) + legacy_config.
 * @returns { allowed, blockers } — allowed iff blockers is empty.
 *
 * Pure + deterministic. An unrecognized command (no route) has no applicable
 * floor and returns allowed:true with no blockers — command recognition is the
 * dispatch layer's job (it returns an explicit `unknown` descriptor); the gate
 * only adjudicates the migration + onboarding + approval floors.
 */
export function gateExecution(
  command: string,
  config: MutagentConfig,
  ctx: GateContext = {},
): GateResult {
  const blockers: Blocker[] = [];

  // ── 1. MIGRATION floor (legacy config short-circuits everything) ────────────
  if (ctx.legacy_config === true) {
    blockers.push({
      kind: "migration-required",
      reason:
        "the config is a legacy (pre-v0.2.0) shape — run the migration directive (references/config-migration.md) before any stage can execute",
    });
    return { allowed: false, blockers };
  }

  const route = lookupRoute(command);
  const stage = route?.adl_stage;

  // ── 1.5 INVOCATION floor (INV-SHIP-1) — operator-only routes fail closed ─────
  // A route marked `invocation: operator-only` (⑥ SHIP's *ship / *rollback) is
  // STRUCTURALLY refused for any non-operator caller. This is stronger than the
  // approval floor: approval asks "did the operator say yes to a gated act"; this
  // asks "is the immediate caller the operator at all". A trigger / chained
  // stage-advance / agent / script carries no operator signal ⇒ refused. Short-
  // circuits: a refused invocation reports nothing else (there is no legal run).
  if (route?.invocation === "operator-only" && ctx.operator_invoked !== true) {
    return {
      allowed: false,
      blockers: [
        {
          kind: "invocation-refused",
          reason:
            `${command} is operator-only (INV-SHIP-1) — it cannot be auto-dispatched by a ` +
            "trigger, a chained stage-advance, an agent, or a script; only an explicit operator " +
            "utterance may launch it. There is deliberately no programmatic entry point.",
        },
      ],
    };
  }

  // ── 2. ONBOARDING floor (scoped by the routing stage + run ctx) ─────────────
  // Only a dispatch command carries a routing adl_stage. Evaluate the scoped
  // floors only when the stage could demand a source, a target, a provider, or a
  // judging base field. `checkOnboardingComplete` decides which floors actually
  // apply given the run ctx (discover-only source, at-apply target, in-house
  // provider); the gate just routes each missing key into its blocker kind.
  // NOTE (F2): a `resolved-default` role binding (many entries + exactly one
  // `default: true`) SATISFIES the source/target floor exactly like a
  // `resolved-single` — it surfaces NO missing key here, so it adds NO blocker.
  // The default-CONFIRM prompt is a run-time skill concern, not a gate. Only
  // `multiple-defaults` (>1 default) surfaces a `config-error` blocker below.
  if (stage !== undefined) {
    const runCtx: OnboardingRunContext = {
      mode: ctx.mode,
      substrate: ctx.judge_runtime,
      apply: ctx.apply_requested,
    };
    const status = checkOnboardingComplete(config, [stage], runCtx);
    if (!status.complete) {
      // Split the specific role floors into their own blocker kinds.
      for (const m of status.missing) {
        if (m.key === "source-required") {
          blockers.push({ kind: "source-required", reason: m.reason });
        } else if (m.key === "target-required") {
          blockers.push({ kind: "target-required", reason: m.reason });
        } else if (m.key === "provider-required") {
          blockers.push({ kind: "provider-required", reason: m.reason });
        } else if (m.key === "source-config-error" || m.key === "target-config-error") {
          // SELECTION config error — >1 catalog entry marked `default: true`.
          blockers.push({ kind: "config-error", key: m.key, reason: m.reason });
        }
      }
      // The remaining base keys collapse into one onboarding-incomplete blocker.
      const baseMissing = status.missing.filter((m) => !SPECIFIC_KEYS.has(m.key));
      if (baseMissing.length > 0) {
        blockers.push({
          kind: "onboarding-incomplete",
          missing: baseMissing,
          reason: `onboarding is incomplete for the ${stage} stage — ${baseMissing
            .map((m) => m.key)
            .join(", ")}`,
        });
      }
    }
  }

  // ── 3. APPROVAL floor (gated commands) ──────────────────────────────────────
  if (route?.gated === true && ctx.approval_granted !== true) {
    blockers.push({
      kind: "approval-required",
      reason:
        "this command is gated (CLI install / apply) — explicit operator approval is required",
    });
  }

  return { allowed: blockers.length === 0, blockers };
}

// Re-export for callers that want the membership sets alongside the gate.
export { isSourceStage, isTargetStage };
