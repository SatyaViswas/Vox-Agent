/**
 * scripts/memory/append.ts
 * PHASE 3 (PR-D) — project-level AutoMemory APPENDER.
 *
 * Appends a NEW (or UPDATES an existing) memory entry to `.mutagent/memory/` on
 * operator feedback, and refreshes the `MEMORY.md` index. Called at run FINALIZE
 * (finalize-gate / Step 9.9) when the operator gives feedback about the TOOL or a
 * standing preference — see the classification rubric in references/memory-format.md.
 *
 * Reuses the store.ts APPEND DISCIPLINE (deterministic writes; INJECTED clock; a
 * regenerated, sorted index) but NOT its per-entity keying — AutoMemory is keyed by
 * a content SLUG, one FACT per file, not per diagnosed-entity.
 *
 * DETERMINISM: `created` is INJECTED (`now`, a YYYY-MM-DD string) so tests are
 * byte-stable. Dedupe on append: an existing slug is UPDATED in place and its
 * `created` date REFRESHED (the plan's "dedupe on append: update + refresh date").
 *
 * Type A — Pure Script (file I/O; clock INJECTED; base dir INJECTABLE for tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  memoryRoot,
  memoryIndexPath,
  memoryEntryPath,
  parseMemoryEntry,
  type MemoryEntry,
  type MemoryType,
  type MemoryLifecycle,
} from "./read.ts";

export interface AppendMemoryInput {
  /** Kebab-case slug (also the entry filename). */
  slug: string;
  /** Frontmatter `name`. */
  name: string;
  /** Frontmatter `description` — the one-line relevance hint used at recall. */
  description: string;
  /** Classified type (rubric in references/memory-format.md; first-match wins). */
  type: MemoryType;
  /** ADL lifecycle tag. Defaults to "diagnose" for a diagnostics-run feedback. */
  lifecycle: MemoryLifecycle;
  /** The fact body (for feedback/project include **Why:** + **How to apply:** lines). */
  body: string;
  /** INJECTED absolute date (YYYY-MM-DD) — keeps writes deterministic in tests. */
  now: string;
}

export interface AppendResult {
  written: boolean;
  /** "created" a new entry or "updated" an existing slug (dedupe). */
  action: "created" | "updated";
  slug: string;
  entryPath: string;
  indexPath: string;
}

/** Deterministic kebab-case slug: lowercase, non-alphanumerics → "-", collapse, trim. */
export function memorySlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Render an entry to its committed markdown file shape (frontmatter + body). */
function renderEntry(input: AppendMemoryInput): string {
  return (
    `---\n` +
    `name: ${input.name}\n` +
    `description: ${input.description}\n` +
    `metadata:\n` +
    `  type: ${input.type}\n` +
    `  lifecycle: ${input.lifecycle}\n` +
    `  created: ${input.now}\n` +
    `---\n\n` +
    `${input.body.trim()}\n`
  );
}

/**
 * Append (or dedupe-update) an AutoMemory entry + refresh the index. Returns the
 * write outcome. Idempotent on the slug: a second append with the same slug UPDATES
 * the file and refreshes its `created` date rather than creating a duplicate.
 */
export function appendMemory(input: AppendMemoryInput, base?: string): AppendResult {
  const root = memoryRoot(base);
  ensureDir(root);

  const entryPath = memoryEntryPath(input.slug, base);
  const action: "created" | "updated" = existsSync(entryPath)
    ? "updated"
    : "created";

  writeFileSync(entryPath, renderEntry(input), "utf8");
  regenerateMemoryIndex(base);

  return {
    written: true,
    action,
    slug: input.slug,
    entryPath,
    indexPath: memoryIndexPath(base),
  };
}

/**
 * Regenerate `MEMORY.md` DETERMINISTICALLY from the on-disk entries: one
 * `- [Title](<slug>.md) — <hook>` line per entry, sorted by slug. Pure given disk
 * state (mirrors store.ts regenerateIndex). The hook is the entry's description.
 */
export function regenerateMemoryIndex(base?: string): void {
  const root = memoryRoot(base);
  ensureDir(root);

  const slugs = existsSync(root)
    ? readdirSync(root)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .map((f) => f.slice(0, -3))
        .sort()
    : [];

  const lines: string[] = [
    "# mutagent — project AutoMemory",
    "",
    "> Project-level, COMMITTED. Subject = the TOOL + operator preferences (NOT the",
    "> diagnosed agent). Claude-Code AutoMemory format; every entry DATED + classified",
    "> + lifecycle-tagged. See references/memory-format.md.",
    "",
  ];
  for (const slug of slugs) {
    const entry = loadEntry(slug, base);
    if (!entry) continue;
    lines.push(`- [${entry.name}](${slug}.md) — ${entry.description}`);
  }
  lines.push("");
  writeFileSync(memoryIndexPath(base), lines.join("\n"), "utf8");
}

/** Load + parse a single entry from disk, or null when absent/corrupt. */
function loadEntry(slug: string, base?: string): MemoryEntry | null {
  const p = join(memoryRoot(base), `${slug}.md`);
  if (!existsSync(p)) return null;
  try {
    return parseMemoryEntry(slug, readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// CLI usage: bun scripts/memory/append.ts <slug> <name> <description> <type> <lifecycle> <now> <body...> [--root <dir>]
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf("--root");
  const base = rootIdx !== -1 ? argv[rootIdx + 1] : process.cwd();
  const positional = rootIdx !== -1 ? argv.slice(0, rootIdx) : argv;
  const [slug, name, description, type, lifecycle, now, ...bodyParts] = positional;

  if (!slug || !name || !description || !type || !lifecycle || !now) {
    process.stderr.write(
      "Usage: bun scripts/memory/append.ts <slug> <name> <description> <type> <lifecycle> <YYYY-MM-DD> <body...> [--root <dir>]\n",
    );
    process.exit(1);
  }

  const result = appendMemory(
    {
      slug,
      name,
      description,
      type: type as MemoryType,
      lifecycle: lifecycle as MemoryLifecycle,
      body: bodyParts.join(" "),
      now,
    },
    base,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}
