/**
 * scripts/persist-eval-criteria.ts — the EVAL-LEG on-disk WRITER (Wave-2 FU57 · KP-003).
 * ---------------------------------------------------------------------------
 * The IO half of the eval-leg reconcile. `sync-eval-criteria.ts` COMPUTES the grown
 * criteria set as DATA (`reconcileEvalCriteria` — pure upsert-by-id, monotonic, never
 * drops); it never touches disk. This module is the deterministic WRITER the evaluator
 * SESSION calls to PERSIST that computed set back to the located eval-suite criteria
 * artifact — the write that bumps the artifact's freshness and thereby returns the eval
 * leg of `#sync-spec` to `in-sync` (the builder freshness probe reads the artifact's
 * mtime / `updatedAt`; a fresh write makes the eval criteria as new as the amended impl).
 *
 * SEPARATION OF CONCERNS (mirrors `artifact-paths.ts` + `aggregate-discover.ts` doing IO
 * while `living-suite.ts` stays pure): the reconcile COMPUTE is pure/C-PIN; this WRITE is
 * the IO layer. The SERIALIZATION here is still deterministic (stable key order, no clock
 * embedded unless the caller passes an explicit `updatedAt`), so a persisted artifact
 * round-trips byte-faithful.
 *
 * JUDGE-ONLY PRESERVED (EV-051): this file writes CRITERIA (the evaluator maintaining its
 * own eval-suite / code-quality criteria set) — it NEVER scores a subject, NEVER decides a
 * pass/fail, and NEVER dispatches an agent (Model-B: code is a deterministic writer; the
 * reconcile REASONING is the ai-architect's, session-dispatched).
 *
 * LOCATION + FORMAT (mirror the living-suite persistence; FLAGGED-for-operator, see
 * `EVAL_CRITERIA_ARTIFACT_FILENAMES`): the artifact lands under the evaluator's namespaced
 * `.mutagent/evaluator/living-suite/` root (`artifact-paths.ts` `livingSuiteDir`, auto-
 * gitignored, no-spillover-guarded) as one JSON file per LEG — the same dir + extension the
 * builder `check-sync-spec.ts` `locateEvalCriteria` auto-discovers.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { assertUnderRoot, livingSuiteDir } from "./artifact-paths.ts";
import {
  EvalCriterionSchema,
  EvalLegKind,
  reconcileEvalCriteria,
  type EvalCriteriaReconcileRequest,
  type EvalCriteriaReconcileResult,
  type EvalCriterion,
  type EvalLegKindValue,
} from "./sync-eval-criteria.ts";

// ── the on-disk artifact shape (mirror LivingSuite `{ …, provenance }`) ───────

/**
 * The persisted eval-criteria artifact — one per LEG. Mirrors the living-suite shape
 * (a keyed collection + provenance), specialized to the reconcile result: the maintained
 * `criteria` set, the reconcile `provenance` counters, and an OPTIONAL `updatedAt`
 * freshness marker. `updatedAt` is the ONE clock-bearing field and it is NEVER generated
 * here — the caller (the session, Model-B) passes it when it wants a content-level
 * freshness stamp the builder probe's `parseEvalUpdatedAt` can read; omitted, freshness
 * rides on the file's mtime alone (write bumps it). `additionalProperties: false` keeps the
 * header tight while each criterion stays forward-parsing (EvalCriterionSchema is open).
 */
export const EvalCriteriaArtifactSchema = Type.Object(
  {
    subjectId: Type.String({ minLength: 1 }),
    leg: Type.Union([
      Type.Literal(EvalLegKind.EvalSuite),
      Type.Literal(EvalLegKind.CodeQuality),
    ]),
    criteria: Type.Array(EvalCriterionSchema),
    provenance: Type.Object(
      { added: Type.Number(), updated: Type.Number(), total: Type.Number() },
      { additionalProperties: false },
    ),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type EvalCriteriaArtifact = Static<typeof EvalCriteriaArtifactSchema>;

/**
 * FLAGGED-for-operator: the per-leg artifact FILENAME under `.mutagent/evaluator/living-suite/`.
 * The sensible default that mirrors the living-suite location AND the builder probe's
 * conventional fallback names (`eval-criteria` / `code-quality-criteria`), one file per leg
 * so the two legs never collide. Both are `.json` under the dir `check-sync-spec.ts`
 * `locateEvalCriteria` walks (`*.{yaml,yml,json}`), so a written artifact is auto-discovered
 * as the eval-leg freshness anchor with no extra wiring. (A workspace evaluates ONE subject,
 * so only its leg's file exists; multi-subject-per-workspace would want a `<subjectId>/`
 * sub-dir — deferred, flagged.)
 */
export const EVAL_CRITERIA_ARTIFACT_FILENAMES: Readonly<Record<EvalLegKindValue, string>> = {
  [EvalLegKind.EvalSuite]: "eval-suite.criteria.json",
  [EvalLegKind.CodeQuality]: "code-quality.criteria.json",
};

/**
 * Resolve the located eval-criteria artifact path for a leg:
 * `<cwd>/.mutagent/evaluator/living-suite/<leg>.criteria.json`. Routes through the
 * `artifact-paths.ts` no-spillover guard (`assertUnderRoot`), so the writer can NEVER
 * escape the evaluator's namespaced root. `cwd` passed in (pure path construction).
 */
export function evalCriteriaArtifactPath(leg: EvalLegKindValue, cwd?: string): string {
  return assertUnderRoot(join(livingSuiteDir(cwd), EVAL_CRITERIA_ARTIFACT_FILENAMES[leg]), cwd);
}

// ── serialize / build (pure, deterministic — no clock) ───────────────────────

/** Build the on-disk artifact from a reconcile RESULT. Pure. `updatedAt` passed in. */
export function evalCriteriaArtifactFromResult(
  result: EvalCriteriaReconcileResult,
  updatedAt?: string,
): EvalCriteriaArtifact {
  return {
    subjectId: result.subjectId,
    leg: result.leg,
    criteria: result.criteria,
    provenance: result.provenance,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/**
 * Serialize an artifact to its on-disk JSON — DETERMINISTIC: explicit key order, 2-space
 * indent, trailing newline. Same artifact → byte-identical string (round-trip faithful);
 * no clock unless the artifact already carries a caller-supplied `updatedAt`.
 */
export function serializeEvalCriteriaArtifact(artifact: EvalCriteriaArtifact): string {
  const ordered: EvalCriteriaArtifact = {
    subjectId: artifact.subjectId,
    leg: artifact.leg,
    criteria: artifact.criteria,
    provenance: artifact.provenance,
    ...(artifact.updatedAt !== undefined ? { updatedAt: artifact.updatedAt } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Guarded parse of a persisted artifact. THROWS with the first schema error. PURE. */
export function parseEvalCriteriaArtifact(value: unknown): EvalCriteriaArtifact {
  if (!Value.Check(EvalCriteriaArtifactSchema, value)) {
    const first = [...Value.Errors(EvalCriteriaArtifactSchema, value)][0];
    throw new Error(
      `parseEvalCriteriaArtifact: schema violation at '${first?.path ?? "(root)"}': ` +
        `${first?.message ?? "invalid eval-criteria artifact"}`,
    );
  }
  return value;
}

// ── the WRITER + reader (the IO layer) ───────────────────────────────────────

/** The result of a persist: WHERE it landed + WHAT was written (artifact + bytes). */
export interface PersistEvalCriteriaResult {
  /** the located artifact path the criteria were written to. */
  path: string;
  /** the artifact that was serialized. */
  artifact: EvalCriteriaArtifact;
  /** the exact bytes written (for a byte-faithful round-trip assertion). */
  json: string;
}

/**
 * PERSIST a reconcile result's `criteria` back to the located eval-suite criteria artifact
 * — the WRITE that returns the eval leg to `in-sync`. Resolves the per-leg path under
 * `.mutagent/evaluator/living-suite/` (no-spillover-guarded via `artifact-paths.ts`),
 * ensures the dir, and writes the deterministic JSON. Handles BOTH legs by `result.leg`:
 * the eval-suite leg (agent/skill/composite subject) and the code-quality leg (a code
 * subject, incl. an operator-overridden code-quality set). The freshness bump is the file
 * write itself (mtime advances → the builder probe reads the eval leg as fresh); pass
 * `options.updatedAt` (ISO 8601) to ALSO stamp a content-level freshness marker the probe's
 * `parseEvalUpdatedAt` reads. IO — NOT pure (that is its job); serialization is deterministic.
 */
export function persistEvalCriteria(
  result: EvalCriteriaReconcileResult,
  options: { cwd?: string; updatedAt?: string } = {},
): PersistEvalCriteriaResult {
  const artifact = evalCriteriaArtifactFromResult(result, options.updatedAt);
  const path = evalCriteriaArtifactPath(result.leg, options.cwd);
  const json = serializeEvalCriteriaArtifact(artifact);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  return { path, artifact, json };
}

/** Read + validate a persisted artifact (round-trip). THROWS on a schema violation. */
export function readEvalCriteriaArtifact(path: string): EvalCriteriaArtifact {
  return parseEvalCriteriaArtifact(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * Load the CURRENTLY-persisted criteria for a leg (the `existing` set the next reconcile
 * grows). Returns `[]` when no artifact exists yet (the cold / first-reconcile case) so a
 * caller can feed it straight into an `EvalCriteriaReconcileRequest.existing`. Reads only.
 */
export function loadExistingEvalCriteria(leg: EvalLegKindValue, cwd?: string): EvalCriterion[] {
  const path = evalCriteriaArtifactPath(leg, cwd);
  if (!existsSync(path)) return [];
  return readEvalCriteriaArtifact(path).criteria;
}

/**
 * The eval-criteria artifact's effective freshness epoch (seconds) — the evaluator-side
 * MIRROR of the builder `check-sync-spec.ts` eval-leg compare: `max(updatedAt, mtime)`
 * (git omitted — kept in-package + git-independent). `null` when the artifact is absent.
 * Feed this as `evalCriteriaEpoch` to `flagEvalLegDrift` to confirm a fresh write closed
 * the loop (`in-sync`). Reads mtime (IO).
 */
export function evalCriteriaEffectiveEpoch(path: string): number | null {
  if (!existsSync(path)) return null;
  const epochs: number[] = [];
  try {
    const parsed = readEvalCriteriaArtifact(path);
    if (parsed.updatedAt !== undefined) {
      const ms = Date.parse(parsed.updatedAt);
      if (Number.isFinite(ms)) epochs.push(Math.floor(ms / 1000));
    }
  } catch {
    // a corrupt artifact still has an mtime — fall back to it for freshness.
  }
  epochs.push(Math.floor(statSync(path).mtimeMs / 1000));
  return Math.max(...epochs);
}

/**
 * Convenience for the session: COMPUTE the reconcile (pure) THEN PERSIST it (IO) in one
 * call — the exact "reconcile → write → in-sync" step the `#sync-spec` eval leg performs.
 * Still Model-B: the criteria DELTA (`request.proposed`) is the ai-architect's reasoning;
 * this only applies it deterministically and writes it. Returns the compute result + the
 * persist result together.
 */
export function reconcileAndPersistEvalCriteria(
  request: EvalCriteriaReconcileRequest,
  options: { cwd?: string; updatedAt?: string } = {},
): { result: EvalCriteriaReconcileResult; persisted: PersistEvalCriteriaResult } {
  const result = reconcileEvalCriteria(request);
  const persisted = persistEvalCriteria(result, options);
  return { result, persisted };
}
