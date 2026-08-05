/**
 * scripts/run-deterministic.ts
 * ---------------------------------------------------------------------------
 * The deterministic executor — Tab-1 deterministic rows (decision #4). Walks the
 * subject eval-matrix; for every criterion whose checkMethod is in the
 * DETERMINISTIC track (deterministic-script | typebox-schema | gate) it runs a
 * binary pass/fail check with NO model. Judge-track rows (trace-cross-ref |
 * trajectory-diff) are emitted as `track:judge, result:skip` placeholders that
 * the pinned-judge seam (run-judge.ts) fills in.
 *
 * The deterministic checks are REAL and grounded in the loaded run-bundle:
 *  - typebox-schema  : the relevant produced artifact must be present + parse as
 *                      a non-empty object/array (the schema-conformance proxy the
 *                      bundle can answer offline).
 *  - gate            : the gate's evidence must be present (e.g. an evidence/
 *                      file set, a wave6 stamp) — absence => fail-loud.
 *  - deterministic-script : the artifact the script produces must be present and
 *                      non-empty in the bundle.
 *
 * Where a criterion's deep semantic check genuinely needs to re-execute the
 * subject's own script against live data (beyond presence/shape), that is an
 * EXPLICIT, documented integration seam (see `evaluateDeterministic` -> the
 * `needsLiveReexec` path) rather than a silent pass. Such rows return result
 * `skip` with a detail explaining the seam, so they never FALSE-PASS.
 *
 * Pure + deterministic: components/criteria are processed in matrix order; no
 * clock/random/network.
 */
import {
  type Component,
  type Criterion,
  type EvalMatrix,
  type RowResultValue,
  type ScorecardCriterion,
  CheckMethod,
  RowResult,
  Track,
  trackForCheckMethod,
} from "./contracts/types.ts";
import { type RunBundle } from "./contracts/types.ts";

export interface DeterministicRowResult {
  componentId: string;
  criterion: ScorecardCriterion;
}

/**
 * Map a criterion to the artifact whose presence/shape proves it. Subject-
 * agnostic heuristic: the bundle's well-known artifacts cover the produced
 * outputs an audit can verify offline. A criterion that references no bundle
 * artifact is a live-reexec seam.
 */
function evidenceArtifactFor(
  criterion: Criterion,
  bundle: RunBundle,
): string | null {
  // Gate rows about evidence/aggregate require the evidence dir.
  const s = criterion.statement.toLowerCase();
  if (s.includes("evidence file") || s.includes("evidence/")) {
    return bundle.data.evidence ? "evidence" : null;
  }
  if (s.includes("wave-6") || s.includes("wave6") || s.includes("stamp")) {
    return bundle.data.wave6 ? "wave6" : null;
  }
  if (s.includes("runmeta") || s.includes("runmeta.")) {
    return bundle.data.runMeta ? "runMeta" : null;
  }
  if (s.includes("entity") || s.includes("diagnosedentity")) {
    return bundle.data.entityContext ? "entityContext" : null;
  }
  if (s.includes("renderinput") || s.includes("render input") || s.includes("heatmap")) {
    return bundle.data.renderInput ? "renderInput" : null;
  }
  if (s.includes("traces-metadata") || s.includes("traces metadata")) {
    return bundle.data.tracesMetadata ? "tracesMetadata" : null;
  }
  return null;
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

/** A STRUCTURED, non-empty value: a non-empty object or array. A present-but-
 *  scalar/empty artifact is NOT structured — the typebox-schema re-exec fails it
 *  (a hollow presence-pass under the old proxy). PURE. */
function isStructuredNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/** Scan a produced artifact for an EXPLICIT gate-failure marker: a falsy pass
 *  flag (`pass`/`ok`/`passed` === false) or a failing `status` stamp
 *  (`fail`/`failed`/`error`). Conservative + shallow so it stays deterministic
 *  and does not false-fail on unrelated substrings. PURE. */
function hasFailureMarker(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  for (const flag of ["pass", "ok", "passed"] as const) {
    if (obj[flag] === false) return true;
  }
  const status = obj["status"];
  if (typeof status === "string") {
    const s = status.toLowerCase();
    if (s === "fail" || s === "failed" || s === "error") return true;
  }
  return false;
}

/**
 * Item #4 — the REAL live re-execution of a deterministic row. Replaces the
 * presence-proxy (`the artifact exists → mark it covered`) with an ACTUAL
 * checkMethod-keyed predicate over the artifact's LIVE content:
 *   - typebox-schema     : the produced artifact must be a STRUCTURED, non-empty
 *                          object/array — a present-but-malformed scalar now FAILS
 *                          instead of hollow-passing (real shape conformance).
 *   - gate               : the evidence must be present AND carry NO explicit
 *                          failure marker (fail-loud gate — `hasFailureMarker`).
 *   - deterministic-script: the produced artifact must be present + non-empty
 *                          (the script actually emitted its output).
 * Returns pass/fail when the criterion maps to a live bundle artifact; returns
 * `null` when NO artifact answers it offline — the caller then records the
 * documented seam-skip. A genuinely un-runnable row would require executing the
 * SUBJECT'S OWN script, which the judge-only cell never does (EV-051) and which
 * dispatches NO sub-agents (PR-ORCH-01). PURE + deterministic (no clock/random/
 * network) ⇒ C-PIN byte-identical reruns.
 */
export function reexecDeterministicCheck(
  criterion: Criterion,
  bundle: RunBundle,
): RowResultValue | null {
  const artifactKey = evidenceArtifactFor(criterion, bundle);
  if (artifactKey == null) return null; // no live artifact → not re-executable here
  const value = bundle.data[artifactKey];
  // HONESTY on the depth of each re-exec (do NOT mistake these for deep checks):
  //   - typebox-schema : a real SHAPE upgrade over presence (rejects a present-but-
  //                      scalar), but it is NOT a full TypeBox `Value.Check` against
  //                      the produced artifact's declared schema — it asserts
  //                      "structured + non-empty", not field-level conformance.
  //   - gate           : `hasFailureMarker` is TOP-LEVEL-ONLY (scans the object's own
  //                      pass/ok/passed/status keys) — it does NOT recurse into nested
  //                      gate evidence, so a failure buried in a child object is missed.
  //   - deterministic-script : semantically ≡ the OLD presence proxy (present +
  //                      non-empty). It is re-run against LIVE data (so it is a real
  //                      re-execution, not a cached verdict), but carries no deeper
  //                      predicate than presence. Deepening any of these to a true
  //                      re-run of the subject's own script is the documented seam
  //                      (out of scope for a judge-only / no-sub-agent cell).
  switch (criterion.checkMethod) {
    case CheckMethod.TypeboxSchema:
      return isStructuredNonEmpty(value) ? RowResult.Pass : RowResult.Fail;
    case CheckMethod.Gate:
      return isNonEmpty(value) && !hasFailureMarker(value) ? RowResult.Pass : RowResult.Fail;
    case CheckMethod.DeterministicScript:
    default:
      return isNonEmpty(value) ? RowResult.Pass : RowResult.Fail;
  }
}

export interface EvaluateOptions {
  /**
   * Item #4 — the LIVE RE-EXEC executor. When supplied it RUNS the real
   * deterministic check against live bundle data (see `reexecDeterministicCheck`,
   * the default) and its pass/fail return is authoritative — replacing the
   * presence-proxy that marked a row covered from mere artifact existence. A
   * `null` return means "this executor cannot answer this row" ⇒ the legacy
   * (byte-stable) path runs. ABSENT ⇒ no re-exec wired: fully back-compatible,
   * byte-identical to before (the presence proxy + documented seam-skip). The
   * executor is PURE + dispatches NO sub-agents (PR-ORCH-01) + never fixes the
   * subject (EV-051).
   */
  liveReexec?: (criterion: Criterion, bundle: RunBundle) => RowResultValue | null;
}

/**
 * Evaluate ONE deterministic criterion against the bundle. Never throws; returns
 * a binary pass/fail, or `skip` with a documented reason for a live-reexec seam.
 */
export function evaluateDeterministic(
  criterion: Criterion,
  bundle: RunBundle,
  opts: EvaluateOptions = {},
): ScorecardCriterion {
  const track = Track.Deterministic;

  // Item #4 — LIVE RE-EXEC FIRST. When an executor is wired it RUNS the real
  // deterministic check against live data; a pass/fail is authoritative and
  // REPLACES the presence-proxy (no more "an artifact exists → covered"). A null
  // return means the executor could not answer this row ⇒ fall through to the
  // (byte-stable) legacy path below.
  const live = opts.liveReexec?.(criterion, bundle) ?? null;
  if (live === RowResult.Pass || live === RowResult.Fail || live === RowResult.Incomplete) {
    return {
      dimension: criterion.dimension,
      severity: criterion.severity,
      checkMethod: criterion.checkMethod,
      track,
      result: live,
      detail: `live re-exec (${criterion.checkMethod}): real deterministic check over the produced artifact → ${live}`,
    };
  }

  const artifactKey = evidenceArtifactFor(criterion, bundle);

  if (artifactKey == null) {
    // No bundle artifact answers this row offline -> documented seam-skip. NOT
    // silent: the coverage-honesty warning (computeCoverage) surfaces it, and
    // fully executing it would require running the subject's OWN script — which
    // the judge-only cell never does (EV-051) and which dispatches no sub-agents.
    return {
      dimension: criterion.dimension,
      severity: criterion.severity,
      checkMethod: criterion.checkMethod,
      track,
      result: RowResult.Skip,
      detail:
        "INTEGRATION SEAM: requires live re-exec of the subject's own script (no bundle artifact answers this row offline); skipped rather than false-passed",
    };
  }

  // LEGACY presence proxy — reached ONLY when no live-reexec executor is wired
  // (kept for byte-identity with pre-Item-#4 callers). With the default executor
  // wired (audit-run.ts) this branch is never taken for a mapped row.
  const present = isNonEmpty(bundle.data[artifactKey]);
  return {
    dimension: criterion.dimension,
    severity: criterion.severity,
    checkMethod: criterion.checkMethod,
    track,
    result: present ? RowResult.Pass : RowResult.Fail,
    detail: present
      ? `evidence artifact '${artifactKey}' present + non-empty (presence proxy — no live re-exec wired)`
      : `evidence artifact '${artifactKey}' MISSING/empty in bundle (fail-loud)`,
  };
}

/** Judge-track placeholder — filled in by the pinned-judge seam. */
export function judgePlaceholder(criterion: Criterion): ScorecardCriterion {
  return {
    dimension: criterion.dimension,
    severity: criterion.severity,
    checkMethod: criterion.checkMethod,
    track: Track.Judge,
    result: RowResult.Skip,
    detail:
      "PINNED-JUDGE SEAM: requires pinned model (id + temp=0) reading transcript vs behavior-tree; deferred to run-judge.ts",
  };
}

export interface RunDeterministicResult {
  rows: DeterministicRowResult[];
  deterministicCount: number;
  judgeCount: number;
}

// ── Coverage honesty (EV-OUT-002) ──────────────────────────────────────────
/**
 * Default skip-rate at/above which a coverage WARNING is raised. Conservative
 * (0.5) so a run where more rows were skipped than graded can no longer claim a
 * silent PASS. This is a WARNING threshold ONLY — it never flips gate pass/fail.
 */
export const DEFAULT_SKIP_RATE_WARN_THRESHOLD = 0.5;

/** Fixed precision for skipRate so two audits serialize byte-identically. */
const SKIP_RATE_PRECISION = 4;

/** The pass/fail/skip tally `assembleScorecard` derives from the graded rows. */
export interface CoverageTotals {
  pass: number;
  fail: number;
  skip: number;
}

export interface CoverageOptions {
  /**
   * Skip-rate STRICTLY ABOVE which `coverageWarning` is set. Default
   * {@link DEFAULT_SKIP_RATE_WARN_THRESHOLD}. Warning-only — this never alters
   * the GATE's pass/fail decision; the honesty mechanism is the surfaced
   * warning, not a gate flip.
   */
  skipRateWarnThreshold?: number;
}

export interface Coverage {
  /** rows actually graded (pass + fail) — the non-vacuous denominator. */
  graded: number;
  /** every criterion (pass + fail + skip). */
  total: number;
  /** rows skipped (seam / no-bundle-artifact / judge placeholder). */
  skipped: number;
  /** skipped / total, rounded to fixed precision (0 when total is 0). */
  skipRate: number;
  /** the threshold that was applied. */
  skipRateWarnThreshold: number;
  /** true iff skipRate exceeds the threshold — surfaces a near-vacuous PASS. */
  coverageWarning: boolean;
}

/**
 * Derive the coverage-honesty stat from a pass/fail/skip tally. Pure +
 * deterministic: integer counts in, fixed-precision ratio out, no clock/random.
 *
 * A high skip-rate means most criteria were never graded — so a `gateRunPass`
 * of true is near-vacuous. `coverageWarning` makes that LOUD without changing
 * pass/fail semantics (the gate is decided entirely upstream by fail counts).
 */
export function computeCoverage(
  totals: CoverageTotals,
  opts: CoverageOptions = {},
): Coverage {
  const skipRateWarnThreshold =
    opts.skipRateWarnThreshold ?? DEFAULT_SKIP_RATE_WARN_THRESHOLD;
  const graded = totals.pass + totals.fail;
  const skipped = totals.skip;
  const total = graded + skipped;
  const rawRate = total === 0 ? 0 : skipped / total;
  const factor = 10 ** SKIP_RATE_PRECISION;
  const skipRate = Math.round(rawRate * factor) / factor;
  return {
    graded,
    total,
    skipped,
    skipRate,
    skipRateWarnThreshold,
    coverageWarning: skipRate > skipRateWarnThreshold,
  };
}

/**
 * Run the full deterministic pass over a matrix + bundle. Emits one row per
 * criterion: deterministic rows are graded now; judge rows are placeholders.
 */
export function runDeterministic(
  matrix: EvalMatrix,
  bundle: RunBundle,
  opts: EvaluateOptions = {},
): RunDeterministicResult {
  const rows: DeterministicRowResult[] = [];
  let deterministicCount = 0;
  let judgeCount = 0;

  for (const component of matrix.components as Component[]) {
    for (const criterion of component.criteria) {
      const track = trackForCheckMethod(criterion.checkMethod);
      if (track === Track.Deterministic) {
        deterministicCount += 1;
        rows.push({
          componentId: component.componentId,
          criterion: evaluateDeterministic(criterion, bundle, opts),
        });
      } else {
        judgeCount += 1;
        rows.push({
          componentId: component.componentId,
          criterion: judgePlaceholder(criterion),
        });
      }
    }
  }

  return { rows, deterministicCount, judgeCount };
}
