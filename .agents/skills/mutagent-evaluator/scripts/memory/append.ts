/**
 * scripts/memory/append.ts — project-level AutoMemory: APPEND (dated + classified).
 * ---------------------------------------------------------------------------
 * Append an operator-feedback entry to the project-level AutoMemory store
 * (`.mutagent/memory/`) in the Claude-Code AutoMemory format
 * (`references/memory-format.md`). The SUBJECT is the TOOL + operator preferences
 * — NOT the evaluated agent (subject findings go to the living-suite, never here).
 *
 * The store: one FACT per `<slug>.md` file + an index `MEMORY.md`
 * (`- [Title](<slug>.md) — <hook>` one line/entry). Every entry is DATED
 * (`metadata.created`) + lifecycle-tagged. DEDUPE on append: an entry with the
 * same slug is UPDATED (body + refreshed date), never duplicated.
 *
 * Determinism (coding-rules): the CORES are PURE — `now` (the date) is INJECTED,
 * never read from a clock; fs is done only in the thin writer at the bottom. Tests
 * exercise the pure cores with a fixed `now`. Standalone: no cross-skill import
 * (mirrors the diagnostics library-store APPEND DISCIPLINE, not its per-entity
 * keying — this store is flat + tool-scoped).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Categorical constants (no magic strings) ─────────────────────────────────

/** Claude Code's four memory types (the classification target). */
export const MemoryType = {
  User: "user",
  Feedback: "feedback",
  Project: "project",
  Reference: "reference",
} as const;
export type MemoryTypeValue = (typeof MemoryType)[keyof typeof MemoryType];

/** The ADL lifecycle tag (the recall filter axis). */
export const Lifecycle = {
  Spec: "spec",
  Build: "build",
  Evaluate: "evaluate",
  Diagnose: "diagnose",
  Optimize: "optimize",
  General: "general",
} as const;
export type LifecycleValue = (typeof Lifecycle)[keyof typeof Lifecycle];

// ── Classification (the memory-format.md rubric — first match wins) ───────────

/** The raw operator feedback to classify + persist. */
export interface FeedbackInput {
  /** the fact to store (verbatim operator text or a distilled summary). */
  text: string;
  /** optional caller hint (a URL / path) — strengthens the `reference` signal. */
  resourceHint?: string;
}

/**
 * Classify feedback into one of the four Claude-Code types by the memory-format.md
 * decision order (FIRST match wins): reference → user → feedback → project. PURE,
 * deterministic — regex + explicit hint, no I/O, no LLM. A caller may OVERRIDE the
 * classification explicitly (an operator who knows the type); this is the default.
 */
export function classifyFeedback(fb: FeedbackInput): MemoryTypeValue {
  const t = fb.text.trim();
  // 1 — external resource (URL / dashboard / ticket / dataset path).
  if (
    fb.resourceHint !== undefined ||
    /\bhttps?:\/\/\S+/i.test(t) ||
    /\b(?:dashboard|ticket|dataset|\S+\.(?:ndjson|jsonl|csv|parquet)(?:\.gz)?)\b/i.test(t)
  ) {
    return MemoryType.Reference;
  }
  // 2 — who the operator is (identity / standing preference about themselves).
  if (/\bI['’]?m\b|\bI am\b|\bmy (?:role|team|preference)\b|\bas the (?:lead|operator|owner)\b/i.test(t)) {
    return MemoryType.User;
  }
  // 3 — how the TOOL should behave (behavioral steer).
  if (/\b(?:stop|don['’]?t|do not|too verbose|next time|always|never|prefer)\b/i.test(t)) {
    return MemoryType.Feedback;
  }
  // 4 — ongoing work / goals / constraints (default).
  return MemoryType.Project;
}

// ── Slug + entry formatting ───────────────────────────────────────────────────

/** Kebab-case a title into a stable slug (deterministic — no random). */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "untitled" : s;
}

export interface MemoryEntry {
  /** kebab-case slug (the file name stem + `name:` frontmatter). */
  slug: string;
  /** one-line description (recall relevance). */
  description: string;
  type: MemoryTypeValue;
  lifecycle: LifecycleValue;
  /** YYYY-MM-DD (INJECTED — never a live clock). */
  created: string;
  /** the fact body (feedback/project carry **Why:** + **How to apply:** lines). */
  body: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Render a MemoryEntry to its `<slug>.md` file text (Claude-Code AutoMemory format). */
export function renderEntryMarkdown(entry: MemoryEntry): string {
  if (!DATE_RE.test(entry.created)) {
    throw new Error(
      `renderEntryMarkdown: created must be YYYY-MM-DD (got '${entry.created}'). Every memory is DATED — ` +
        "inject `now`, never read a clock.",
    );
  }
  return (
    "---\n" +
    `name: ${entry.slug}\n` +
    `description: ${entry.description}\n` +
    "metadata:\n" +
    `  type: ${entry.type}\n` +
    `  lifecycle: ${entry.lifecycle}\n` +
    `  created: ${entry.created}\n` +
    "---\n\n" +
    entry.body.trimEnd() +
    "\n"
  );
}

/** The one index line for an entry (`- [Title](<slug>.md) — <hook>`). */
export function indexLine(entry: MemoryEntry): string {
  return `- [${entry.slug}](${entry.slug}.md) — ${entry.description}`;
}

/**
 * Fold an entry's index line into an existing `MEMORY.md`, DEDUPED by slug (an
 * existing line for the same slug is REPLACED in place; a new slug is appended).
 * PURE — string in, string out. Preserves a leading title/header block.
 */
export function upsertIndex(existingIndex: string, entry: MemoryEntry): string {
  const newLine = indexLine(entry);
  const lineRe = new RegExp(`^- \\[${entry.slug}\\]\\(${entry.slug}\\.md\\).*$`);
  const lines = existingIndex.split("\n");
  let replaced = false;
  const out = lines.map((l) => {
    if (lineRe.test(l)) {
      replaced = true;
      return newLine;
    }
    return l;
  });
  if (replaced) return out.join("\n");
  // Append (ensure a header exists + trailing newline hygiene).
  const base =
    existingIndex.trim() === ""
      ? "# AutoMemory — index\n\n> Project-level operator-feedback + tool self-learning. One line per entry.\n"
      : existingIndex.replace(/\n*$/, "\n");
  return base + newLine + "\n";
}

// ── Filesystem writer (the ONLY impure edge) ──────────────────────────────────

export interface AppendResult {
  slug: string;
  entryFile: string;
  indexFile: string;
  /** true when an existing entry was UPDATED (dedupe hit) rather than created. */
  updated: boolean;
}

/**
 * Append (or UPDATE) an AutoMemory entry under `<memoryDir>/`. Writes the
 * `<slug>.md` file + upserts the `MEMORY.md` index line. DEDUPE: an existing
 * `<slug>.md` is overwritten (not duplicated) and its index line replaced.
 * `now` (YYYY-MM-DD) is INJECTED. The pure cores above do the formatting; this is
 * the thin fs edge.
 */
export function appendMemory(
  memoryDir: string,
  input: { title: string; description: string; lifecycle: LifecycleValue; feedback: FeedbackInput; type?: MemoryTypeValue },
  now: string,
): AppendResult {
  const slug = slugify(input.title);
  const type = input.type ?? classifyFeedback(input.feedback);
  const entry: MemoryEntry = {
    slug,
    description: input.description,
    type,
    lifecycle: input.lifecycle,
    created: now,
    body: input.feedback.text.trim(),
  };

  mkdirSync(memoryDir, { recursive: true });
  const entryFile = join(memoryDir, `${slug}.md`);
  const updated = existsSync(entryFile);
  writeFileSync(entryFile, renderEntryMarkdown(entry));

  const indexFile = join(memoryDir, "MEMORY.md");
  const existingIndex = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  writeFileSync(indexFile, upsertIndex(existingIndex, entry));

  return { slug, entryFile, indexFile, updated };
}

/** List the entry slugs currently in a memory dir (PURE-ish fs read; [] if absent). */
export function listEntrySlugs(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}
