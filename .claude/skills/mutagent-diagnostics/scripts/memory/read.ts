/**
 * scripts/memory/read.ts
 * PHASE 3 (PR-D) — project-level AutoMemory READER.
 *
 * The AutoMemory store (`.mutagent/memory/`) is COMMITTED, project-level, and shared
 * across the whole ADL lifecycle. Its SUBJECT is the TOOL + operator preferences —
 * NOT the diagnosed agent (that is the gitignored class-memory library). Format is
 * the Claude-Code AutoMemory shape (see references/memory-format.md):
 *
 *   .mutagent/memory/
 *     MEMORY.md              ← index: `- [Title](<slug>.md) — <hook>` one line/entry
 *     <slug>.md              ← one FACT per file (frontmatter name/description/metadata)
 *
 * This reader is consumed at run START (parse-brief / Step 3a): load the store,
 * FILTER by `metadata.lifecycle ∈ { diagnose, general }` (the diagnostics stage +
 * the always-relevant general facts), and hand the surviving entries to the
 * orchestrator so operator feedback + tool-lessons steer the run.
 *
 * Type A — Pure Script (file reads; the base dir is INJECTABLE for tests; no clock).
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/** The four Claude-Code memory types. */
export type MemoryType = "reference" | "user" | "feedback" | "project";

/** ADL lifecycle tag — which stage(s) an entry is relevant to. */
export type MemoryLifecycle =
  | "spec"
  | "build"
  | "evaluate"
  | "diagnose"
  | "optimize"
  | "general";

export interface MemoryEntry {
  /** Slug = the entry filename without `.md` (kebab-case). */
  slug: string;
  /** Frontmatter `name`. */
  name: string;
  /** Frontmatter `description` (used to decide relevance during recall). */
  description: string;
  type: MemoryType;
  lifecycle: MemoryLifecycle;
  /** Frontmatter `metadata.created` — the absolute date (YYYY-MM-DD). */
  created: string;
  /** The fact body (everything after the closing frontmatter fence). */
  body: string;
}

/** Root of the project-level AutoMemory store. Injectable base for tests. */
export function memoryRoot(base: string = process.cwd()): string {
  return join(base, ".mutagent", "memory");
}

export function memoryIndexPath(base?: string): string {
  return join(memoryRoot(base), "MEMORY.md");
}

export function memoryEntryPath(slug: string, base?: string): string {
  return join(memoryRoot(base), `${slug}.md`);
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "reference",
  "user",
  "feedback",
  "project",
]);
const VALID_LIFECYCLES: ReadonlySet<string> = new Set([
  "spec",
  "build",
  "evaluate",
  "diagnose",
  "optimize",
  "general",
]);

/**
 * Parse a single memory entry file (frontmatter + body). Returns null when the
 * file is malformed (no frontmatter fence, missing required fields, or an invalid
 * type/lifecycle) — a corrupt entry is SKIPPED, never throws (defensive read).
 */
export function parseMemoryEntry(slug: string, raw: string): MemoryEntry | null {
  // Frontmatter is delimited by the FIRST two `---` fences.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};

  // Flat key: value parse (frontmatter is intentionally shallow; `metadata.*`
  // keys are indented and read with a trimmed-key heuristic).
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // Strip surrounding quotes if present.
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    // Last-wins is fine — the shape has no key collisions across name/description
    // and the metadata.* leaf keys (type/lifecycle/created) are unique names.
    if (val !== "") fields[key] = val;
  }

  const name = fields.name;
  const description = fields.description;
  const type = fields.type;
  const lifecycle = fields.lifecycle;
  const created = fields.created;

  if (!name || !description || !type || !lifecycle || !created) return null;
  if (!VALID_TYPES.has(type)) return null;
  if (!VALID_LIFECYCLES.has(lifecycle)) return null;

  return {
    slug,
    name,
    description,
    type: type as MemoryType,
    lifecycle: lifecycle as MemoryLifecycle,
    created,
    body: body.trim(),
  };
}

/**
 * Read ALL entries from the AutoMemory store. The `MEMORY.md` index drives the read
 * (entries listed there, in index order); an entry file missing on disk is skipped.
 * When the index is absent, falls back to a deterministic dir scan (sorted slugs) so
 * a hand-authored store without an index still loads. Never throws.
 */
export function readAllMemory(base?: string): MemoryEntry[] {
  const root = memoryRoot(base);
  if (!existsSync(root)) return [];

  const slugs = orderedSlugs(base);
  const entries: MemoryEntry[] = [];
  for (const slug of slugs) {
    const p = memoryEntryPath(slug, base);
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const parsed = parseMemoryEntry(slug, raw);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/**
 * Read the AutoMemory store FILTERED to a stage. Keeps entries whose lifecycle is
 * the given stage OR `general` (always-relevant). For the diagnostics run this is
 * called with `diagnose` — yielding `{ diagnose, general }` (the plan's filter).
 */
export function readMemoryForStage(
  stage: MemoryLifecycle,
  base?: string,
): MemoryEntry[] {
  return readAllMemory(base).filter(
    (e) => e.lifecycle === stage || e.lifecycle === "general",
  );
}

/** Convenience: the diagnostics-stage filter — `lifecycle ∈ { diagnose, general }`. */
export function readDiagnoseMemory(base?: string): MemoryEntry[] {
  return readMemoryForStage("diagnose", base);
}

/**
 * The slugs to read, in order: parse `MEMORY.md` index links when present, else a
 * deterministic sorted dir scan of `*.md` (excluding the index itself).
 */
function orderedSlugs(base?: string): string[] {
  const indexPath = memoryIndexPath(base);
  if (existsSync(indexPath)) {
    try {
      const idx = readFileSync(indexPath, "utf8");
      const slugs: string[] = [];
      const linkRe = /^-\s+\[[^\]]*\]\(([^)]+?)\.md\)/gm;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(idx)) !== null) {
        const slug = m[1].replace(/^\.\//, "");
        if (slug && slug !== "MEMORY") slugs.push(slug);
      }
      if (slugs.length > 0) return slugs;
    } catch {
      // fall through to dir scan
    }
  }
  const root = memoryRoot(base);
  try {
    return readdirSync(root)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

// CLI usage: bun scripts/memory/read.ts [project-root] [stage]
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const stage = (process.argv[3] as MemoryLifecycle) ?? "diagnose";
  const entries = readMemoryForStage(stage, projectRoot);
  process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  process.exit(0);
}
