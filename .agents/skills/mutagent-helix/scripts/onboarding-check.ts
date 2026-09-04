import { AdlStage, type AdlStageValue } from "./handover-contract.ts";
import type { MutagentConfig, Source, Target } from "./config-schema.ts";
import { ApplyKind } from "./config-schema.ts";

// ---------------------------------------------------------------------------
// C2 — the per-command / per-role onboarding completion-check (v0.2.0).
//
// v0.2.0 collapses the false `stages` axis: the config is keyed by SKILL under
// `lifecycle`, and the "where traces come from" / "where fixes go" live in a
// GLOBAL catalog (`global.sources[]` / `global.targets[]`) bound BY ROLE, not by
// ref. So onboarding is no longer a single monolithic floor — it is SCOPED to
// what the invoked stage actually needs, only when the config doesn't already
// specify it, and it STOPS only when a genuinely-required thing is missing.
//
// Binding by role (NOT by ref — there is no source_ref/target_ref) under the
// SELECTION contract (an entry marked `default: true` is auto-selected):
//   - source-consumers (evaluate / diagnose) bind `global.sources`.
//   - target-writers  (build / optimize / diagnose-apply) bind `global.targets`.
//   Exactly ONE entry ⇒ auto-bind (`resolved-single`). MULTIPLE entries: exactly one
//   `default: true` ⇒ `resolved-default` (binds; run-time confirms); >1 `default: true`
//   ⇒ `multiple-defaults` (a CONFIG ERROR — the selector is ambiguous, surfaces
//   `source/target-config-error`);
//   0 defaults ⇒ `needs-selection` (the operator picks at RUN time). ZERO ⇒ the
//   relevant floor is unmet. `needs-selection` is NOT a hard-fail: a source/target
//   EXISTS, the operator just picks — the floor is satisfied for gating purposes.
//   `multiple-defaults` IS a hard-fail (a config error to fix).
//
// The floors (scoped, run-ctx-aware):
//   - BASE floor:     `global.models.judge_model` (renamed from pinned_judge) +
//                     `global.models.default` where needed;
//                     `global.workspace.repo` for TARGET-WRITING stages.
//   - SOURCE floor:   evaluate (ONLY when ctx.mode is DISCOVER) + diagnose (always)
//                     need a resolvable global source → else `source-required`.
//   - TARGET floor:   build + optimize(at apply) + diagnose(at apply, UNLESS
//                     lifecycle.diagnostics.apply === "report-only") need a
//                     resolvable global target → else `target-required`.
//   - PROVIDER floor: evaluate with judge_runtime === "in-house" needs a provider
//                     with credentials_ref → else `provider-required`.
//
// PURE + deterministic: no I/O, no clock, no random. Defensive against partial /
// undefined sub-objects so it can run on a fresh, mostly-empty config.
// ---------------------------------------------------------------------------

/** The run-context the onboarding check reads (all optional; defaults are conservative). */
export interface OnboardingRunContext {
  /**
   * The evaluate mode. `discover` (mine criteria from traces) NEEDS a source;
   * a code/dataset run does NOT (it warns + streams to stdout instead). Only
   * meaningful for the evaluate stage.
   */
  mode?: "discover" | "code" | "dataset" | string;
  /**
   * The evaluator judge runtime (renamed from `substrate`). `in-house` (provider
   * SDK) NEEDS a provider credential; `agent-dispatch` / `code-based` /
   * `user-framework` do not.
   */
  substrate?: "agent-dispatch" | "in-house" | "code-based" | "user-framework" | string;
  /**
   * True when the operator has requested APPLY (build/optimize/diagnose write a
   * fix). Absent/false ⇒ a draft-only run that does NOT demand a target.
   */
  apply?: boolean;
}

/**
 * The stages that CONSUME an observability source (where traces come from).
 * Evaluator + diagnostics care; spec / build / optimize / audit do not.
 *
 * Typed `readonly AdlStageValue[]` so `gate.ts`'s `SOURCE_STAGES.includes(stage)`
 * accepts any AdlStageValue. NOTE: evaluate is source-consuming ONLY in DISCOVER
 * mode — that nuance lives in the floor logic (checkOnboardingComplete), not in
 * this coarse membership set. `gate.ts` uses this only to decide whether to
 * evaluate the source-aware floor at all.
 */
export const SOURCE_STAGES: readonly AdlStageValue[] = [
  AdlStage.Evaluate,
  AdlStage.Diagnose,
];

/** The stages that WRITE to a target (need a resolvable global target at apply). */
export const TARGET_STAGES: readonly AdlStageValue[] = [
  AdlStage.Build,
  AdlStage.Optimize,
  AdlStage.Diagnose,
];

/** A single unmet onboarding requirement: the config key + why it's needed. */
export interface MissingKey {
  key: string;
  reason: string;
}

export interface OnboardingStatus {
  complete: boolean;
  /** The exact keys still required for onboarding to be complete (empty when complete). */
  missing: MissingKey[];
}

/** True iff `s` is a non-empty trimmed string. */
function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "";
}

// ── Role-based catalog resolution ─────────────────────────────────────────────

/**
 * The outcome of resolving a role's catalog (source or target) under the SELECTION
 * contract (a catalog entry marked `default: true` is auto-selected when multiple
 * exist). The two BOUND outcomes are split (F2) so the run-time layer can tell an
 * unambiguous single from a pre-picked default and prompt accordingly:
 *   - `resolved-single`   — exactly ONE entry in the catalog: it auto-binds with NO
 *                           prompt (there is nothing to disambiguate).
 *   - `resolved-default`  — MULTIPLE entries, exactly one marked `default: true`: the
 *                           default binds, but the run-time layer CONFIRMS it (the
 *                           default is preselected; the operator may override). Both
 *                           `resolved-single` + `resolved-default` are BINDABLE — the
 *                           split is purely about the run-time prompt, not the floor.
 *   - `needs-selection`   — multiple entries, none marked default; the operator
 *                           picks at RUN time (NOT a hard-fail — a source/target
 *                           EXISTS, so the floor is satisfied; do not block the gate).
 *   - `multiple-defaults` — multiple entries with >1 marked `default: true`; a
 *                           CONFIG ERROR (the selector is ambiguous). NOT bindable —
 *                           surfaces a distinct config-error floor.
 *   - `none`              — zero entries; the relevant floor is UNMET.
 *
 * NOTE: the CONFIRM prompt (on `resolved-default`) and the PICK prompt (on
 * `needs-selection`) are a RUN-TIME skill concern — NOT this pure gate's job. This
 * module only classifies; the gate treats both bound outcomes as floor-satisfying.
 */
export type RoleResolution<T> =
  | { status: "resolved-single"; entry: T }
  | { status: "resolved-default"; entry: T }
  | { status: "needs-selection"; entries: T[] }
  | { status: "multiple-defaults"; entries: T[] }
  | { status: "none" };

/** A catalog entry participates in the SELECTION contract via an optional `default` flag. */
interface Selectable {
  default?: boolean;
}

/**
 * Shared SELECTION-contract precedence over a role catalog (source or target):
 *   1. length 0            ⇒ none
 *   2. length 1            ⇒ resolved-single (the single entry auto-binds, no prompt)
 *   3. multiple:
 *      - exactly one `default: true` ⇒ resolved-default (binds; run-time CONFIRMS)
 *      - >1 `default: true`          ⇒ multiple-defaults (config error)
 *      - 0 defaults                  ⇒ needs-selection (operator picks at run time)
 * The `resolved-single` vs `resolved-default` split (F2) is a run-time-prompt
 * distinction only — BOTH are bindable + both satisfy the onboarding floor.
 * Pure + deterministic — no I/O, no clock; tolerant of an undefined catalog.
 */
function resolveByRole<T extends Selectable>(catalog: readonly T[]): RoleResolution<T> {
  if (catalog.length === 0) return { status: "none" };
  if (catalog.length === 1) return { status: "resolved-single", entry: catalog[0]! };
  const defaults = catalog.filter((e) => e.default === true);
  if (defaults.length === 1) return { status: "resolved-default", entry: defaults[0]! };
  if (defaults.length > 1) return { status: "multiple-defaults", entries: defaults };
  return { status: "needs-selection", entries: [...catalog] };
}

/**
 * Resolve the SOURCE bound by role from `global.sources` under the SELECTION
 * contract. One ⇒ resolved-single (auto-bind); many+one-default ⇒ resolved-default
 * (bind + run-time confirm); many+no-default ⇒ needs-selection (pick at run);
 * many+multi-default ⇒ multiple-defaults (config error); none ⇒ none. Pure.
 * Source-consumers (evaluate/diagnose) call this;
 * there is NO source_ref — binding is by role + catalog cardinality + `default`.
 */
export function resolveSourceByRole(config: MutagentConfig): RoleResolution<Source> {
  return resolveByRole(config?.global?.sources ?? []);
}

/**
 * Resolve the TARGET bound by role from `global.targets` under the SELECTION
 * contract. One ⇒ resolved-single (auto-bind); many+one-default ⇒ resolved-default
 * (bind + run-time confirm); many+no-default ⇒ needs-selection (pick at run);
 * many+multi-default ⇒ multiple-defaults (config error); none ⇒ none. Pure.
 * Target-writers (build/optimize/diagnose-apply) call
 * this; there is NO target_ref — binding is by role + cardinality + `default`.
 */
export function resolveTargetByRole(config: MutagentConfig): RoleResolution<Target> {
  return resolveByRole(config?.global?.targets ?? []);
}

/**
 * True iff a role resolution yields a usable binding for the onboarding gate:
 * `resolved-single` (unambiguous bind) OR `resolved-default` (default binds; the
 * run-time layer confirms) OR `needs-selection` (a source/target EXISTS — the
 * operator picks at run time; do NOT block the gate). `multiple-defaults` is a
 * CONFIG ERROR (NOT bindable — the ambiguous selector must be fixed) and `none` is
 * unmet. So `resolved-default` satisfies the floor exactly like `resolved-single`
 * (it adds NO new blocker — the confirm is a run-time step, not a gate).
 */
function isBindable<T>(r: RoleResolution<T>): boolean {
  return (
    r.status === "resolved-single" ||
    r.status === "resolved-default" ||
    r.status === "needs-selection"
  );
}

/** True iff a role resolution is the `multiple-defaults` config error (>1 default). */
function isMultipleDefaults<T>(r: RoleResolution<T>): boolean {
  return r.status === "multiple-defaults";
}

// ── Floor helpers ─────────────────────────────────────────────────────────────

/** True iff the stage WRITES to a target (needs workspace.repo + a target at apply). */
function isTargetStage(stage: AdlStageValue): boolean {
  return TARGET_STAGES.includes(stage);
}

/**
 * Does the evaluate stage need a source? Only in DISCOVER mode. A code/dataset
 * run warns + streams to stdout instead of demanding a source.
 */
function evaluateNeedsSource(ctx: OnboardingRunContext): boolean {
  return ctx.mode === "discover";
}

/** True iff diagnostics is configured report-only (⇒ no target needed at apply). */
function diagnosticsIsReportOnly(config: MutagentConfig): boolean {
  return config?.lifecycle?.diagnostics?.apply === ApplyKind.ReportOnly;
}

/**
 * Does a TARGET-writing stage demand a target for THIS run?
 *   - build    — at apply (build IS a write; a draft does not).
 *   - optimize  — at apply (draft remedies need no target).
 *   - diagnose — at apply, UNLESS lifecycle.diagnostics.apply === "report-only".
 */
function stageNeedsTarget(
  stage: AdlStageValue,
  config: MutagentConfig,
  ctx: OnboardingRunContext,
): boolean {
  if (!isTargetStage(stage)) return false;
  if (ctx.apply !== true) return false;
  if (stage === AdlStage.Diagnose && diagnosticsIsReportOnly(config)) return false;
  return true;
}

/** True iff ≥1 provider carries a usable credentials_ref (env-var name OR {env,path}). */
function hasUsableProvider(config: MutagentConfig): boolean {
  const providers = config?.global?.providers ?? [];
  return providers.some((p) => {
    const ref = p?.credentials_ref;
    if (typeof ref === "string") return hasText(ref);
    return typeof ref === "object" && ref !== null && hasText((ref as { env?: unknown }).env);
  });
}

/**
 * Check whether onboarding is complete for the given config + the ONE stage being
 * invoked + the run context.
 *
 * @param config       the parsed (possibly partial) MutagentConfig (v0.2.0).
 * @param activeStages the ADL stage(s) the operator is invoking. Scoped floors
 *                     apply per stage; de-duped so a stage listed twice can't
 *                     push duplicate keys.
 * @param ctx          run context: { mode, substrate, apply } — drives the
 *                     source(discover-only)/target(at-apply)/provider(in-house) floors.
 * @returns { complete, missing } — `missing` lists the exact keys still needed,
 *          keyed by the v0.2.0 reason strings (`judge-model-required`,
 *          `source-required`, `target-required`, `provider-required`, the
 *          SELECTION config-error keys `source-config-error` /
 *          `target-config-error` (>1 `default: true`), plus the base
 *          workspace/models keys). NOTE: `needs-selection` (multi source/target,
 *          no default) does NOT appear here — it satisfies the floor (pick at run).
 *
 * Pure + deterministic: same inputs ⇒ deep-equal result. No I/O, no clock.
 */
export function checkOnboardingComplete(
  config: MutagentConfig,
  activeStages: AdlStageValue[],
  ctx: OnboardingRunContext = {},
): OnboardingStatus {
  const missing: MissingKey[] = [];
  const stages = Array.from(new Set(activeStages));

  const needsJudgeModel = stages.some(
    (s) => s === AdlStage.Evaluate || s === AdlStage.Audit,
  );
  const anyTargetStage = stages.some((s) => isTargetStage(s));

  // ── BASE floor ──────────────────────────────────────────────────────────────
  // judge_model — required by the judging stages (evaluate / audit).
  if (needsJudgeModel && !hasText(config?.global?.models?.judge_model)) {
    missing.push({
      key: "global.models.judge_model",
      reason: "a pinned judge model (global.models.judge_model) is required for the judging stage",
    });
  }
  // default model — needed where a run executes a model (evaluate / build).
  const needsDefaultModel =
    stages.some((s) => s === AdlStage.Evaluate) || anyTargetStage;
  if (needsDefaultModel && !hasText(config?.global?.models?.default)) {
    missing.push({
      key: "global.models.default",
      reason: "a default model (global.models.default) is required",
    });
  }
  // workspace.repo — needed by target-WRITING stages.
  if (anyTargetStage && !hasText(config?.global?.workspace?.repo)) {
    missing.push({
      key: "global.workspace.repo",
      reason: "the target repo/workspace (global.workspace.repo) is required for a target-writing stage",
    });
  }

  // ── SOURCE floor ──────────────────────────────────────────────────────────────
  // diagnose ALWAYS needs a source; evaluate needs one ONLY in DISCOVER mode.
  // `needs-selection` (multi, no default) SATISFIES the floor (operator picks at
  // run time). `multiple-defaults` (>1 default) is a distinct CONFIG ERROR.
  const needsSource =
    stages.some((s) => s === AdlStage.Diagnose) ||
    (stages.some((s) => s === AdlStage.Evaluate) && evaluateNeedsSource(ctx));
  if (needsSource) {
    const srcRes = resolveSourceByRole(config);
    if (isMultipleDefaults(srcRes)) {
      missing.push({
        key: "source-config-error",
        reason:
          "more than one global source (global.sources[]) is marked `default: true` — exactly one default may be set (or none, to pick at run time)",
      });
    } else if (!isBindable(srcRes)) {
      missing.push({
        key: "source-required",
        reason: "a resolvable global source (global.sources[]) is required — none configured",
      });
    }
  }

  // ── TARGET floor ──────────────────────────────────────────────────────────────
  // `needs-selection` (multi, no default) SATISFIES the floor. `multiple-defaults`
  // (>1 default) is a distinct CONFIG ERROR.
  const needsTarget = stages.some((s) => stageNeedsTarget(s, config, ctx));
  if (needsTarget) {
    const tgtRes = resolveTargetByRole(config);
    if (isMultipleDefaults(tgtRes)) {
      missing.push({
        key: "target-config-error",
        reason:
          "more than one global target (global.targets[]) is marked `default: true` — exactly one default may be set (or none, to pick at run time)",
      });
    } else if (!isBindable(tgtRes)) {
      missing.push({
        key: "target-required",
        reason: "a resolvable global target (global.targets[]) is required at apply — none configured",
      });
    }
  }

  // ── PROVIDER floor ──────────────────────────────────────────────────────────
  // evaluate with an in-house judge runtime needs a provider credential.
  const needsProvider =
    stages.some((s) => s === AdlStage.Evaluate) && ctx.substrate === "in-house";
  if (needsProvider && !hasUsableProvider(config)) {
    missing.push({
      key: "provider-required",
      reason: "an in-house judge runtime needs a provider with a credentials_ref (global.providers[]) — none usable",
    });
  }

  return { complete: missing.length === 0, missing };
}
