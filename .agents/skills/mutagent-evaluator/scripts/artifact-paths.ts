/**
 * scripts/artifact-paths.ts — P8 (EV-REQ-058): the localized artifact hierarchy resolver.
 * ---------------------------------------------------------------------------
 * The EVALUATOR reference implementation of the operator's NO-SPILLOVER goal:
 * every durable artifact the engine writes resolves under ONE namespaced root
 * — `<workspace>/.mutagent/evaluator/` — the evaluator's stage sub-dir of the
 * unified LOCAL `.mutagent/` (sibling to the diagnostics `.mutagent/diagnostics/`
 * precedent; pattern, not import). A published skill
 * running in a CONSUMER's repo therefore never litters their tracked source tree:
 * the root is auto-gitignored (parity with `.mutagent/`).
 *
 * Hierarchy (deterministic):
 *   .mutagent/evaluator/
 *     runs/<runId>/{ingest,tasks,verdicts,packets,source-map,scorecard}/
 *     reports/<runId>/
 *     living-suite/
 *     datasets/
 *
 * PURE + deterministic: `runId` + `cwd` are PASSED IN — there is NO clock/random in
 * path construction (a runId is never `Date.now()` here), so the same inputs always
 * yield the same paths (C-PIN-safe: P8 changes WHERE artifacts land, never WHAT).
 *
 * NO-SPILLOVER guard: every resolver output flows through `assertUnderRoot`, which
 * THROWS if a path escapes the root (a `..` traversal or an absolute path outside)
 * — so even a malicious path-traversal `runId` fails loud instead of writing
 * outside the namespace.
 */
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The single namespaced root every durable artifact lives under — the evaluator's
 * stage sub-dir of the unified LOCAL `.mutagent/` (operator decision 2026-06-29;
 * relocated from the former per-stage dot-root).
 */
export const ARTIFACT_ROOT_NAME = ".mutagent/evaluator";

/** Resolve the artifact root: `<cwd>/.mutagent/evaluator`. `cwd` passed in (pure). */
export function artifactRoot(cwd: string = process.cwd()): string {
  return resolve(cwd, ARTIFACT_ROOT_NAME);
}

/**
 * NO-SPILLOVER guard. Resolve `path` and assert it is INSIDE `artifactRoot(cwd)`;
 * THROW otherwise (a `..` escape or an absolute path outside the root). Returns the
 * input path unchanged on success (so resolvers can `return assertUnderRoot(...)`).
 */
export function assertUnderRoot(path: string, cwd?: string): string {
  const root = artifactRoot(cwd);
  const rel = relative(root, resolve(path));
  if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error(
      `assertUnderRoot: path '${path}' ESCAPES the artifact root '${root}' — ` +
        "no-spillover invariant (EV-REQ-058): the engine writes ONLY under its " +
        "namespaced dot-root, never the consumer's tracked source tree.",
    );
  }
  return path;
}

/** Internal: join under the root + assert no escape (catches a traversal runId). */
function underRoot(cwd: string | undefined, ...segments: string[]): string {
  return assertUnderRoot(join(artifactRoot(cwd), ...segments), cwd);
}

// ── per-run hierarchy ───────────────────────────────────────────────────────

export function runDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId);
}
export function ingestDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "ingest");
}
export function tasksDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "tasks");
}
export function verdictsDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "verdicts");
}
export function packetsDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "packets");
}
export function sourceMapDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "source-map");
}
export function scorecardDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "runs", runId, "scorecard");
}

// ── cross-run hierarchy ─────────────────────────────────────────────────────

export function reportDir(runId: string, cwd?: string): string {
  return underRoot(cwd, "reports", runId);
}

// ── the three named report artifacts (evaluator-reports PRD R-1/R-3) ──────────
// Distinct names under ONE run folder — no `report.html` collision, and *audit no longer
// writes under `.mutagent/diagnostics/`. Single resolver = single source of truth.
/** `*evaluate` → the 5-tab judge report. */
export function evaluationReportPath(runId: string, cwd?: string): string {
  return underRoot(cwd, "reports", runId, "evaluation-report.html");
}
/** `*discover-evals` → the mined-criteria report. */
export function discoveryReportPath(runId: string, cwd?: string): string {
  return underRoot(cwd, "reports", runId, "discovery-report.html");
}
/** `*audit` → the 4-tab master-audit (now under the evaluator root, not diagnostics). */
export function masterAuditPath(runId: string, cwd?: string): string {
  return underRoot(cwd, "reports", runId, "master-audit.html");
}
export function livingSuiteDir(cwd?: string): string {
  return underRoot(cwd, "living-suite");
}
export function datasetsDir(cwd?: string): string {
  return underRoot(cwd, "datasets");
}
