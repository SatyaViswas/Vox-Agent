import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// resolve-paths — the LOCAL `.mutagent/` source-of-truth resolver (operator
// decision 2026-06-29).
//
// Everything lives under ONE local `.mutagent/` rooted at the INSTALL/init dir —
// the dir where `mutagent … init` ran (the nearest ancestor that already has a
// `.mutagent/`). NEVER `~/.mutagent`: config + artifacts are project-local so a
// checkout is self-contained and two projects never share state.
//
//   <root>/.mutagent/
//     config.yaml                  ← the single global config (resolveConfigPath)
//     feedback.md                  ← the ADL feedback channel     (feedbackPath — INF-6)
//     evaluator/                   ← evaluator artifacts        (stageDir "evaluator")
//     diagnostics/{runId}/         ← diagnostics run artifacts  (stageDir "diagnostics")
//     diagnostics/library/         ← class-memory (per-install)
//     specs/{spec_id}/             ← agentspec build artifacts  (stageDir "specs")
//     skill-builder/               ← (stageDir "skill-builder")
//
// ARTIFACT-PLACEMENT RULE (ratified — DX-5): every stage's internal artifacts
// land under `.mutagent/<subject-or-stage>/` at the resolved root — NEVER
// colocated into a target agent's own source tree. The ONE sanctioned write into
// a target's tree is a diagnostics APPLY (the fix being applied to the agent).
// agentspec's spec dir is operator-overridable by design (an escape hatch); if it
// is ever pointed INTO a target's source tree, `checkSpecDirPlacement` warns.
//
// Design invariants (mirror config-schema.ts / resolve-credential.ts):
//   - Pure core with an INJECTED `exists` predicate → deterministic tests.
//   - A thin live wrapper binds real fs + process.cwd().
//   - Never throws; when no `.mutagent/` ancestor exists, fall back to the start
//     dir (that is where `init` will create it — first-run friendly).
// ---------------------------------------------------------------------------

/** The single local root dir name. Never `~/.mutagent`. */
export const MUTAGENT_DIR = ".mutagent" as const;

/** The ADL feedback-channel file name under `.mutagent/` (INF-6). */
export const FEEDBACK_FILE = "feedback.md" as const;

/** The canonical ADL stage sub-roots under `.mutagent/`. */
export const STAGE_DIRS = {
  evaluator: "evaluator",
  diagnostics: "diagnostics",
  specs: "specs",
  skillBuilder: "skill-builder",
} as const;
export type StageDirName = (typeof STAGE_DIRS)[keyof typeof STAGE_DIRS];

/**
 * Walk UP from `startDir` to the nearest ancestor that already contains a
 * `.mutagent/` directory; return that ancestor (the install/init root). If none
 * is found, return `startDir` (first run — `init` creates `.mutagent/` here).
 * Pure: directory existence is the injected `exists` predicate.
 */
export function findConfigRoot(
  startDir: string,
  exists: (p: string) => boolean,
): string {
  let dir = path.resolve(startDir);
  // Bounded by the filesystem root — path.dirname("/") === "/" terminates.
  for (;;) {
    if (exists(path.join(dir, MUTAGENT_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/** True iff `p` is an existing directory (real-fs predicate for the live wrapper). */
export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Live: the install/init root for the current process (nearest `.mutagent/` ancestor, else cwd). */
export function resolveConfigRoot(startDir: string = process.cwd()): string {
  return findConfigRoot(startDir, dirExists);
}

/** `<root>/.mutagent`. */
export function mutagentDir(root: string): string {
  return path.join(root, MUTAGENT_DIR);
}

/** The single global config path: `<root>/.mutagent/config.yaml`. */
export function configPath(root: string): string {
  return path.join(mutagentDir(root), "config.yaml");
}

/** Live: the resolved global config path for the current process. */
export function resolveConfigPath(startDir: string = process.cwd()): string {
  return configPath(resolveConfigRoot(startDir));
}

/** The single feedback-channel path: `<root>/.mutagent/feedback.md` (INF-6). */
export function feedbackPath(root: string): string {
  return path.join(mutagentDir(root), FEEDBACK_FILE);
}

/** Live: the resolved feedback-channel path for the current process. */
export function resolveFeedbackPath(startDir: string = process.cwd()): string {
  return feedbackPath(resolveConfigRoot(startDir));
}

/** A stage artifact root: `<root>/.mutagent/<stage>[/...segments]`. */
export function stageDir(root: string, stage: StageDirName, ...segments: string[]): string {
  return path.join(mutagentDir(root), stage, ...segments);
}

// ---------------------------------------------------------------------------
// DX-5 — artifact-placement guard: never colocate framework artifacts into a
// target agent's own source tree. Pure predicate over resolved paths (no fs).
// ---------------------------------------------------------------------------

/**
 * True iff `child` resolves to `parent` itself OR a path nested inside it.
 * Boundary-safe: `/a/b-sibling` is NOT inside `/a/b`. Pure (path math only).
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface SpecDirPlacementResult {
  /** false when the spec dir escaped into the target's source tree. */
  ok: boolean;
  /** Operator-facing warning (only when `ok:false`). */
  warning?: string;
}

/**
 * Guard the operator-overridable agentspec spec-dir escape hatch (DX-5).
 *
 * The DEFAULT spec dir is `.mutagent/specs/` (in-substrate — always `ok`). But the
 * spec dir is operator-overridable by flag/config, so it CAN be pointed into a
 * target agent's source tree. That colocates our artifacts with the target's code
 * — the one thing the placement rule forbids. This warns (does not throw): the
 * override is intentional, so the operator keeps control; they just get told.
 *
 * Pure: compares resolved paths only. `targetDir` absent ⇒ nothing to escape into
 * ⇒ `ok`.
 */
export function checkSpecDirPlacement(args: {
  specDir: string;
  targetDir?: string;
}): SpecDirPlacementResult {
  const { specDir, targetDir } = args;
  if (!targetDir) return { ok: true };
  if (isPathInside(specDir, targetDir)) {
    return {
      ok: false,
      warning:
        `[artifact-placement] agentspec spec dir "${specDir}" is inside the target's ` +
        `source tree "${targetDir}". The rule (DX-5) keeps framework artifacts under ` +
        `.mutagent/<subject>/, never colocated with the target's code. This is the ` +
        `operator-overridable escape hatch — keep it only if you intend to commit specs ` +
        `into the target repo; otherwise point the spec dir back under .mutagent/specs/.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CLI — print the resolved root + config path for the current dir:
//   bun run scripts/resolve-paths.ts [startDir]
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  const start = argv[2] ?? process.cwd();
  const root = resolveConfigRoot(start);
  console.info(`[resolve-paths] root:   ${root}`);
  console.info(`[resolve-paths] config: ${configPath(root)}`);
  return 0;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
