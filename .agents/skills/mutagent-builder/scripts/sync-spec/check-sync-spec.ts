#!/usr/bin/env bun
/**
 * scripts/sync-spec/check-sync-spec.ts
 *
 * Deterministic freshness probe for the `ai-architect #sync-spec` mode. AgentSpec's `*sync-spec`
 * command delegates here (Helix-mediated); `*build` reuses it build-internally on drift.
 *
 * ACCEPTED LIMITATION — recency ≠ divergence. This probe measures RECENCY (git commit timestamps of
 * impl/eval paths vs the card's status.updated_at), not semantic DIVERGENCE: a commit that only
 * touched whitespace still reads as "newer", so a `needs-sync` verdict means "the impl moved after the
 * card was stamped", not "the impl and the spec actually disagree". The reconcile step (`ai-architect
 * #sync-spec`) is what confirms real divergence; a timestamp probe cannot, and deliberately does not, try.
 *
 * CLI:
 *   scripts/cli/run.sh scripts/sync-spec/check-sync-spec.ts --spec <agentspec.yaml?> --target <target-root> [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface Freshness {
  updatedAt?: string | null;
  gitCommitEpoch: number | null;
  fileMtimeEpoch: number | null;
  effectiveEpoch: number | null;
}

/**
 * The eval-leg (third leg of the def → impl → eval triad, W2I5) freshness verdict.
 * `not-applicable` = no eval-criteria artifact was requested or located (the 2-leg
 * spec↔impl reconcile is unaffected — additive). The other three MIRROR the spec-leg
 * semantics so both legs agree on "impl is newer → reconcile".
 */
export type EvalLegStatus = "not-applicable" | "missing-eval" | "in-sync" | "needs-sync" | "unknown";

export interface SyncSpecStatus {
  status: "missing-spec" | "in-sync" | "needs-sync" | "unknown" | "error";
  specPath: string | null;
  targetRoot: string;
  specFreshness: { updatedAt: string | null; gitCommitEpoch: number | null; fileMtimeEpoch: number | null; effectiveEpoch: number | null };
  codeFreshness: { gitCommitEpoch: number | null; fileMtimeEpoch: number | null; effectiveEpoch: number | null; newestPath: string | null };
  /**
   * The EVAL leg (W2I5 · KP-003). Detects when the impl amended past the eval criteria
   * that ground the subject's evaluation. Subject-kind-agnostic at THIS layer — the
   * predicate only stats the criteria artifact's freshness vs the impl; WHICH criteria
   * (agent/skill eval-suite vs code code-quality) is the reconcile's concern
   * (`ai-architect #sync-spec` + evaluator `sync-eval-criteria.ts`).
   */
  evalStatus: EvalLegStatus;
  evalFreshness: { path: string | null; updatedAt: string | null; gitCommitEpoch: number | null; fileMtimeEpoch: number | null; effectiveEpoch: number | null };
  reason: string;
}

interface CliArgs {
  spec?: string;
  target?: string;
  evalCriteria?: string;
  json: boolean;
}

function emptySpecFreshness(): SyncSpecStatus["specFreshness"] {
  return { updatedAt: null, gitCommitEpoch: null, fileMtimeEpoch: null, effectiveEpoch: null };
}

function emptyCodeFreshness(targetRoot = ""): SyncSpecStatus["codeFreshness"] {
  void targetRoot;
  return { gitCommitEpoch: null, fileMtimeEpoch: null, effectiveEpoch: null, newestPath: null };
}

function emptyEvalFreshness(): SyncSpecStatus["evalFreshness"] {
  return { path: null, updatedAt: null, gitCommitEpoch: null, fileMtimeEpoch: null, effectiveEpoch: null };
}

/** The eval leg is not-applicable when no criteria artifact was requested/located. */
function notApplicableEval(): { evalStatus: EvalLegStatus; evalFreshness: SyncSpecStatus["evalFreshness"] } {
  return { evalStatus: "not-applicable", evalFreshness: emptyEvalFreshness() };
}

function epochSeconds(ms: number): number | null {
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeCandidate(base: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
}

function isPrunedDir(absDir: string, targetRoot: string): boolean {
  const rel = path.relative(targetRoot, absDir);
  if (!rel || rel === "") return false;
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules") || parts.includes(".git") || parts.includes("dist") || parts.includes("coverage")) return true;
  const mutagentIdx = parts.indexOf(".mutagent");
  if (mutagentIdx >= 0 && parts[mutagentIdx + 2] === "runs") return true; // .mutagent/<subject>/runs
  // The evaluator's namespaced artifact root (.mutagent/evaluator/**) is eval OUTPUT, never
  // implementation — pruning it keeps eval-suite criteria / datasets from masquerading as impl
  // drift (they are the EVAL leg, compared separately). W2I5.
  if (mutagentIdx >= 0 && parts[mutagentIdx + 1] === "evaluator") return true;
  return false;
}

function isGeneratedReport(absFile: string, targetRoot: string): boolean {
  const rel = path.relative(targetRoot, absFile);
  const parts = rel.split(path.sep);
  const file = parts.at(-1) ?? "";
  if (!parts.includes(".mutagent")) return false;
  if (/^(build-)?report\.(md|json|html)$/i.test(file)) return true;
  if (/^verdict\.(md|json)$/i.test(file)) return true;
  return false;
}

function walkFiles(root: string, predicate: (abs: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isPrunedDir(abs, root)) stack.push(abs);
      } else if (entry.isFile() && predicate(abs)) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function locateSpec(targetRoot: string, explicitSpec?: string): string | null {
  if (explicitSpec) {
    const abs = normalizeCandidate(process.cwd(), explicitSpec);
    try {
      const stat = fs.statSync(abs);
      return stat.isFile() ? abs : null;
    } catch {
      return null;
    }
  }

  const direct = path.join(targetRoot, "agentspec.yaml");
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const mutagentSpecs = path.join(targetRoot, ".mutagent", "specs");
  if (fs.existsSync(mutagentSpecs)) {
    const found = walkFiles(mutagentSpecs, (abs) => path.basename(abs) === "agentspec.yaml");
    if (found.length) return found[0];
  }

  const found = walkFiles(targetRoot, (abs) => path.basename(abs) === "agentspec.yaml");
  return found[0] ?? null;
}

/**
 * The card-side freshness anchor is the INTERNAL top-level `status.updated_at` stamp (agentspec
 * ORCH-07 / R7 — supersedes the 0.2 `meta.loop_state.updated_at` location). It is the authoritative
 * "when the card was last reconciled/stamped"; the impl side is compared against it. A malformed
 * YAML is an error; a missing/malformed stamp yields a null epoch (→ an honest `unknown` verdict, we
 * never fall back to mtime).
 */
function parseUpdatedAt(specPath: string): { updatedAt: string | null; epoch: number | null; error?: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { updatedAt: null, epoch: null, error: `specPath: failed to parse YAML: ${message}` };
  }
  const updatedAt = (parsed as any)?.status?.updated_at;
  if (typeof updatedAt !== "string") return { updatedAt: null, epoch: null };
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return { updatedAt: null, epoch: null };
  return { updatedAt, epoch: Math.floor(ms / 1000) };
}

function gitEpochForPaths(targetRoot: string, files: string[]): number | null {
  if (!files.length) return null;
  let best: number | null = null;
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100).map((f) => path.relative(targetRoot, f));
    const result = spawnSync("git", ["-C", targetRoot, "log", "-1", "--format=%ct", "--", ...batch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) continue;
    const text = result.stdout.trim().split(/\s+/).find(Boolean);
    const n = text ? Number(text) : NaN;
    if (Number.isFinite(n)) best = best == null ? n : Math.max(best, n);
  }
  return best;
}

function fileMtimeEpoch(file: string): number | null {
  try {
    return epochSeconds(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function newestMtime(files: string[]): { epoch: number | null; path: string | null } {
  let bestEpoch: number | null = null;
  let bestPath: string | null = null;
  for (const file of files) {
    const epoch = fileMtimeEpoch(file);
    if (epoch != null && (bestEpoch == null || epoch > bestEpoch)) {
      bestEpoch = epoch;
      bestPath = file;
    }
  }
  return { epoch: bestEpoch, path: bestPath };
}

function implementationFiles(targetRoot: string, specPath: string | null, evalPath?: string | null): string[] {
  const normalizedSpec = specPath ? path.resolve(specPath) : null;
  const normalizedEval = evalPath ? path.resolve(evalPath) : null;
  return walkFiles(targetRoot, (abs) => {
    const resolved = path.resolve(abs);
    if (normalizedSpec && resolved === normalizedSpec) return false;
    // The eval-criteria artifact is the EVAL leg, never impl — exclude it so it can never
    // count as its own drift source (mirror of the spec exclusion). W2I5.
    if (normalizedEval && resolved === normalizedEval) return false;
    if (isGeneratedReport(abs, targetRoot)) return false;
    return true;
  });
}

/**
 * Locate the eval-criteria artifact (the EVAL leg's freshness anchor). An explicit path
 * wins; otherwise auto-locate under the evaluator's namespaced root
 * (`.mutagent/evaluator/living-suite/*.{yaml,yml,json}` — the discovered eval-suite
 * criteria) or a conventional criteria file at the target root. Returns `{ path, existed }`:
 * an explicit-but-missing path yields `existed:false` (→ `missing-eval`); no path found
 * yields `path:null` (→ `not-applicable`, additive no-op). W2I5.
 */
function locateEvalCriteria(targetRoot: string, explicit?: string): { path: string | null; existed: boolean } {
  if (explicit) {
    const abs = normalizeCandidate(process.cwd(), explicit);
    try {
      return { path: abs, existed: fs.statSync(abs).isFile() };
    } catch {
      return { path: abs, existed: false };
    }
  }
  const criteriaExt = (abs: string): boolean => /\.(ya?ml|json)$/i.test(abs);
  const livingSuite = path.join(targetRoot, ".mutagent", "evaluator", "living-suite");
  if (fs.existsSync(livingSuite)) {
    const found = walkFiles(livingSuite, criteriaExt);
    if (found.length) return { path: found[0], existed: true };
  }
  for (const name of ["eval-criteria", "code-quality-criteria"]) {
    for (const ext of ["yaml", "yml", "json"]) {
      const candidate = path.join(targetRoot, `${name}.${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, existed: true };
    }
  }
  return { path: null, existed: false };
}

/** Parse an optional freshness marker from an eval-criteria artifact (best-effort). */
function parseEvalUpdatedAt(evalPath: string): { updatedAt: string | null; epoch: number | null } {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(evalPath, "utf8"));
  } catch {
    return { updatedAt: null, epoch: null };
  }
  const raw =
    (parsed as any)?.meta?.loop_state?.updated_at ??
    (parsed as any)?.updatedAt ??
    (parsed as any)?.updated_at ??
    (parsed as any)?.generatedAt;
  if (typeof raw !== "string") return { updatedAt: null, epoch: null };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { updatedAt: null, epoch: null };
  return { updatedAt: raw, epoch: Math.floor(ms / 1000) };
}

/**
 * Compute the EVAL leg (status + freshness) given the code (impl) effective epoch. The
 * `not-applicable` / `missing-eval` / `in-sync` / `needs-sync` verdict mirrors the spec
 * leg's semantics so the two legs agree on "impl newer → reconcile". Deterministic. W2I5.
 */
function evalLeg(
  targetRoot: string,
  explicit: string | undefined,
  codeGitEpoch: number | null,
): { evalStatus: EvalLegStatus; evalFreshness: SyncSpecStatus["evalFreshness"] } {
  const located = locateEvalCriteria(targetRoot, explicit);
  if (located.path == null) return notApplicableEval();
  if (!located.existed) {
    return { evalStatus: "missing-eval", evalFreshness: { ...emptyEvalFreshness(), path: located.path } };
  }
  const updated = parseEvalUpdatedAt(located.path);
  const git = gitEpochForPaths(targetRoot, [located.path]);
  const mtime = fileMtimeEpoch(located.path); // reported only — never drives the verdict
  const evalFreshness = {
    path: located.path,
    updatedAt: updated.updatedAt,
    gitCommitEpoch: git,
    fileMtimeEpoch: mtime,
    effectiveEpoch: git, // GIT-anchored: the criteria's last commit (no mtime)
  };
  // GIT-derived + honest UNKNOWN: eval drifts if the impl was committed after the criteria's last
  // commit. When either side lacks git history we refuse an mtime guess and report `unknown`.
  let evalStatus: EvalLegStatus;
  if (codeGitEpoch == null || git == null) evalStatus = "unknown";
  else evalStatus = codeGitEpoch > git ? "needs-sync" : "in-sync";
  return { evalStatus, evalFreshness };
}

/**
 * The legs that DRIFTED — the triad's headline surface. `spec` drifts on `missing-spec`
 * (cold construct) or `needs-sync`; `eval` drifts on `missing-eval` or `needs-sync`. The
 * reconcile (ai-architect) reads this to reconcile BOTH legs when an impl amends. W2I5.
 */
export function driftedLegs(status: SyncSpecStatus): Array<"spec" | "eval"> {
  const legs: Array<"spec" | "eval"> = [];
  if (status.status === "missing-spec" || status.status === "needs-sync") legs.push("spec");
  if (status.evalStatus === "missing-eval" || status.evalStatus === "needs-sync") legs.push("eval");
  return legs;
}

export function checkSyncSpec(args: { targetRoot: string; specPath?: string; evalCriteriaPath?: string }): SyncSpecStatus {
  const targetRoot = path.resolve(args.targetRoot);
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(targetRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      specPath: null,
      targetRoot,
      specFreshness: emptySpecFreshness(),
      codeFreshness: emptyCodeFreshness(),
      ...notApplicableEval(),
      reason: `targetRoot: unreadable target root: ${message}`,
    };
  }
  if (!targetStat.isDirectory()) {
    return {
      status: "error",
      specPath: null,
      targetRoot,
      specFreshness: emptySpecFreshness(),
      codeFreshness: emptyCodeFreshness(),
      ...notApplicableEval(),
      reason: "targetRoot: target root is not a directory",
    };
  }

  const specPath = locateSpec(targetRoot, args.specPath);
  if (!specPath) {
    const files = implementationFiles(targetRoot, null, locateEvalCriteria(targetRoot, args.evalCriteriaPath).path);
    const newest = newestMtime(files);
    const codeGit = gitEpochForPaths(targetRoot, files); // GIT-derived (no mtime in the verdict)
    return {
      status: "missing-spec",
      specPath: null,
      targetRoot,
      specFreshness: emptySpecFreshness(),
      codeFreshness: {
        gitCommitEpoch: codeGit,
        fileMtimeEpoch: newest.epoch, // reported only
        effectiveEpoch: codeGit,
        newestPath: newest.path,
      },
      ...evalLeg(targetRoot, args.evalCriteriaPath, codeGit),
      reason: "no agentspec.yaml found; derive spec from implementation",
    };
  }

  const updated = parseUpdatedAt(specPath);
  if (updated.error) {
    return {
      status: "error",
      specPath,
      targetRoot,
      specFreshness: emptySpecFreshness(),
      codeFreshness: emptyCodeFreshness(),
      ...notApplicableEval(),
      reason: updated.error,
    };
  }

  const specGit = gitEpochForPaths(targetRoot, [specPath]);
  const specMtime = fileMtimeEpoch(specPath);
  const cardEpoch = updated.epoch; // card-side freshness = status.updated_at ONLY (authoritative)
  const specFreshness = {
    updatedAt: updated.updatedAt,
    gitCommitEpoch: specGit,
    fileMtimeEpoch: specMtime, // reported only — never drives the verdict
    effectiveEpoch: cardEpoch,
  };

  const evalLocated = locateEvalCriteria(targetRoot, args.evalCriteriaPath);
  const files = implementationFiles(targetRoot, specPath, evalLocated.path);
  const codeGit = gitEpochForPaths(targetRoot, files); // GIT-derived impl drift (no mtime)
  const codeMtime = newestMtime(files);
  const codeFreshness = {
    gitCommitEpoch: codeGit,
    fileMtimeEpoch: codeMtime.epoch, // reported only
    effectiveEpoch: codeGit,
    newestPath: codeMtime.path,
  };
  const evalResult = evalLeg(targetRoot, args.evalCriteriaPath, codeGit);

  // Honest UNKNOWN over an mtime guess: impl drift is GIT-derived, so if the impl paths carry no git
  // history (not a repo, or untracked/uncommitted files) we cannot compare — and if the card carries
  // no status.updated_at stamp we have no card-side anchor. Either way → `unknown`, never mtime.
  if (codeGit == null) {
    return {
      status: "unknown",
      specPath,
      targetRoot,
      specFreshness,
      codeFreshness,
      ...evalResult,
      reason:
        "implementation drift cannot be determined from git (not a repo, or impl files are untracked); refusing an mtime-based verdict",
    };
  }
  if (cardEpoch == null) {
    return {
      status: "unknown",
      specPath,
      targetRoot,
      specFreshness,
      codeFreshness,
      ...evalResult,
      reason: "card carries no status.updated_at stamp to anchor freshness against",
    };
  }

  if (codeGit > cardEpoch) {
    return {
      status: "needs-sync",
      specPath,
      targetRoot,
      specFreshness,
      codeFreshness,
      ...evalResult,
      reason: "implementation changed in git after the card's status.updated_at",
    };
  }

  return {
    status: "in-sync",
    specPath,
    targetRoot,
    specFreshness,
    codeFreshness,
    ...evalResult,
    reason: "no implementation commits newer than the card's status.updated_at",
  };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--spec") args.spec = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--eval-criteria") args.evalCriteria = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: scripts/cli/run.sh scripts/sync-spec/check-sync-spec.ts --spec <agentspec.yaml?> --target <target-root> [--eval-criteria <path?>] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.target) throw new Error("--target is required");
  return args;
}

function formatSummary(status: SyncSpecStatus): string {
  const lines = [
    `[sync-spec] ${status.status}: ${status.reason}`,
    `targetRoot: ${status.targetRoot}`,
    `specPath: ${status.specPath ?? "<none>"}`,
    `specFreshness: updatedAt=${status.specFreshness.updatedAt ?? "null"} git=${status.specFreshness.gitCommitEpoch ?? "null"} mtime=${status.specFreshness.fileMtimeEpoch ?? "null"} effective=${status.specFreshness.effectiveEpoch ?? "null"}`,
    `codeFreshness: git=${status.codeFreshness.gitCommitEpoch ?? "null"} mtime=${status.codeFreshness.fileMtimeEpoch ?? "null"} effective=${status.codeFreshness.effectiveEpoch ?? "null"} newestPath=${status.codeFreshness.newestPath ?? "null"}`,
    `evalStatus: ${status.evalStatus}  (eval leg — W2I5 triad)`,
    `evalFreshness: path=${status.evalFreshness.path ?? "<none>"} updatedAt=${status.evalFreshness.updatedAt ?? "null"} git=${status.evalFreshness.gitCommitEpoch ?? "null"} mtime=${status.evalFreshness.fileMtimeEpoch ?? "null"} effective=${status.evalFreshness.effectiveEpoch ?? "null"}`,
    `driftedLegs: ${driftedLegs(status).join("+") || "<none>"}`,
  ];
  return lines.join("\n");
}

export function runCli(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status: SyncSpecStatus = {
      status: "error",
      specPath: null,
      targetRoot: "",
      specFreshness: emptySpecFreshness(),
      codeFreshness: emptyCodeFreshness(),
      ...notApplicableEval(),
      reason: `args: ${reason}`,
    };
    console.error(JSON.stringify(status, null, 2));
    return 1;
  }
  const status = checkSyncSpec({ targetRoot: args.target!, specPath: args.spec, evalCriteriaPath: args.evalCriteria });
  const out = args.json ? JSON.stringify(status, null, 2) : formatSummary(status);
  if (status.status === "error") console.error(out);
  else console.log(out);
  return status.status === "error" ? 1 : 0;
}

if (import.meta.main) process.exit(runCli(process.argv.slice(2)));
