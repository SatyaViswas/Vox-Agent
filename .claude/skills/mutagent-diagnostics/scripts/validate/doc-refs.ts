/**
 * scripts/validate/doc-refs.ts
 * PRD-SO-02 — Doc-reference validator.
 * Type A — Pure Script (file-system reads only; deterministic; no LLM).
 *
 * Greps SKILL.md and references/reference.md for `references/...` paths,
 * then verifies each path exists as a real file under the skill root.
 * Exits non-zero (fail-loud) if any cross-ref is broken.
 *
 * Usage (CLI):
 *   bun scripts/cli/run.sh scripts/validate/doc-refs.ts [--skill-root <path>]
 *
 * Exported function:
 *   validateDocRefs(skillRoot: string): DocRefsResult
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrokenRef {
  /** The source file containing the reference (relative to skillRoot). */
  sourceFile: string;
  /** The referenced path as it appears in the source file. */
  ref: string;
  /** Absolute path that was checked (does not exist). */
  resolvedPath: string;
}

export interface DocRefsResult {
  ok: boolean;
  scanned: string[];
  checked: number;
  broken: BrokenRef[];
}

// ── Regex patterns ────────────────────────────────────────────────────────────

/**
 * The doc-subdir prefixes a cross-ref can be anchored on. `references/` is the
 * skill-root-relative form; the others (`workflows/`, `agents/`, …) are the BARE
 * forms reference.md's own mermaid DAG + tables use (relative to references/ or
 * assets/). Matching only `references/` was a BLIND SPOT: a bare `workflows/foo.md`
 * whose target was DELETED silently passed (the M9 drift). Glob tokens like
 * `source-platforms/*.md` are naturally skipped — `*` is not in the path class.
 */
const REF_PREFIXES = [
  "references",
  "workflows",
  "agents",
  "assets",
  "source-platforms",
  "target-platforms",
] as const;

const REF_RE = new RegExp(
  `((?:${REF_PREFIXES.join("|")})\\/[A-Za-z0-9_./-]+\\.md)`,
  "g",
);

/** Candidate base dirs a captured ref may be relative to (checked in order). */
function candidateBases(skillRoot: string): string[] {
  return [skillRoot, join(skillRoot, "references"), join(skillRoot, "assets")];
}

/**
 * Resolve a captured ref to an EXISTING file under one of the candidate bases,
 * or null if it resolves nowhere (a dangling link — the drift we must catch).
 */
export function resolveRef(skillRoot: string, ref: string): string | null {
  for (const base of candidateBases(skillRoot)) {
    const p = join(base, ref);
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Core implementation ───────────────────────────────────────────────────────

/**
 * Extract all doc cross-ref paths (any REF_PREFIXES-anchored `*.md`) from the
 * given source text. Deduplicates results.
 */
export function extractRefs(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(REF_RE.source, "g");
  while ((m = re.exec(content)) !== null) {
    found.add(m[1]);
  }
  return Array.from(found).sort();
}

/**
 * PRD-SO-02 — validate every `references/...` cross-ref found in the source
 * files against the skill root's actual filesystem.
 *
 * @param skillRoot  Absolute path to the skill root (the dir containing SKILL.md).
 */
export function validateDocRefs(skillRoot: string): DocRefsResult {
  const abs = resolve(skillRoot);

  // Source files to scan for cross-refs.
  const sourceFiles = [
    join(abs, "SKILL.md"),
    join(abs, "references", "reference.md"),
  ];

  const scanned: string[] = [];
  const broken: BrokenRef[] = [];
  const allRefs: { sourceFile: string; ref: string }[] = [];

  for (const srcPath of sourceFiles) {
    const rel = srcPath.slice(abs.length + 1);
    if (!existsSync(srcPath)) {
      // Source file itself missing — that's a hard error.
      broken.push({
        sourceFile: rel,
        ref: "<source file missing>",
        resolvedPath: srcPath,
      });
      continue;
    }
    scanned.push(rel);
    const content = readFileSync(srcPath, "utf-8");
    const refs = extractRefs(content);
    for (const ref of refs) {
      allRefs.push({ sourceFile: rel, ref });
    }
  }

  // Check each unique ref once (a ref may resolve under any candidate base:
  // skillRoot, references/, or assets/ — a bare `workflows/foo.md` lives under
  // references/, `agents/foo.md` under assets/). A ref that resolves NOWHERE is
  // a dangling link (fail-loud).
  const checkedRefs = new Set<string>();
  for (const { sourceFile, ref } of allRefs) {
    if (checkedRefs.has(ref)) continue;
    checkedRefs.add(ref);
    if (resolveRef(abs, ref) === null) {
      broken.push({ sourceFile, ref, resolvedPath: join(abs, ref) });
    }
  }

  return {
    ok: broken.length === 0,
    scanned,
    checked: checkedRefs.size,
    broken,
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  // Resolve skill root from args or default to 2 levels up from this file's dir.
  // This file lives at scripts/validate/doc-refs.ts; skill root is ../../
  const args = process.argv.slice(2);
  let skillRoot: string;

  const rootArgIdx = args.indexOf("--skill-root");
  if (rootArgIdx >= 0 && args[rootArgIdx + 1]) {
    skillRoot = resolve(args[rootArgIdx + 1]);
  } else {
    // Default: climb up from scripts/validate/ to skill root.
    const here = dirname(fileURLToPath(import.meta.url));
    skillRoot = resolve(here, "..", "..");
  }

  const result = validateDocRefs(skillRoot);

  console.info(`\ndoc-refs validator — skill root: ${skillRoot}`);
  console.info(`Scanned:  ${result.scanned.join(", ")}`);
  console.info(`Refs checked: ${result.checked}`);

  if (result.ok) {
    console.info(`\nOK — all ${result.checked} cross-refs resolve.`);
    process.exit(0);
  } else {
    console.error(`\nFAIL — ${result.broken.length} broken cross-ref(s):\n`);
    for (const b of result.broken) {
      console.error(`  [${b.sourceFile}]  ${b.ref}`);
      console.error(`    -> resolved: ${b.resolvedPath}`);
    }
    console.error(`\nFix: create the missing files or update the references in SKILL.md / references/reference.md.`);
    process.exit(1);
  }
}
