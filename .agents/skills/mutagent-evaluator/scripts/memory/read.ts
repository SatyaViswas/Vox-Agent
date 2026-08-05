/**
 * scripts/memory/read.ts — project-level AutoMemory: READ (filter by lifecycle).
 * ---------------------------------------------------------------------------
 * Read the project-level AutoMemory store (`.mutagent/memory/`) at run START and
 * return the entries relevant to THIS stage. The evaluator reads entries whose
 * `lifecycle ∈ {evaluate, general}` (the run-start injection surface). The subject
 * is the TOOL + operator preferences — NOT the evaluated agent.
 *
 * Determinism (coding-rules): the PARSE + FILTER cores are PURE (string in, data
 * out); fs is confined to `readMemoryDir`. Tests exercise the pure cores against
 * committed fixture text. Standalone — no cross-skill import.
 *
 * Format: one FACT per `<slug>.md`, Claude-Code AutoMemory frontmatter
 * (`references/memory-format.md`). A malformed / partial entry is SKIPPED (never
 * throws) so one bad file can't blind a run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Lifecycle,
  MemoryType,
  type LifecycleValue,
  type MemoryTypeValue,
} from "./append.ts";

export interface ParsedMemoryEntry {
  slug: string;
  description: string;
  type: MemoryTypeValue;
  lifecycle: LifecycleValue;
  created: string;
  body: string;
}

const LIFECYCLE_VALUES = new Set<string>(Object.values(Lifecycle));
const TYPE_VALUES = new Set<string>(Object.values(MemoryType));

/**
 * Parse ONE `<slug>.md` entry (frontmatter + body). Returns null on a malformed /
 * partial entry (missing frontmatter, unknown type/lifecycle, absent date) — a bad
 * file is SKIPPED, never fatal. PURE — string in, entry out. `fallbackSlug` is the
 * file stem, used when the `name:` field is absent.
 */
export function parseMemoryEntry(text: string, fallbackSlug: string): ParsedMemoryEntry | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (m === null) return null;
  const front = m[1] ?? "";
  const body = (m[2] ?? "").trim();

  const scalar = (key: string): string | undefined => {
    // top-level `key: value` OR nested `  key: value` (metadata block).
    const re = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m");
    const mm = re.exec(front);
    return mm ? (mm[1] as string).trim() : undefined;
  };

  const slug = scalar("name") ?? fallbackSlug;
  const description = scalar("description") ?? "";
  const type = scalar("type");
  const lifecycle = scalar("lifecycle");
  const created = scalar("created");

  if (type === undefined || !TYPE_VALUES.has(type)) return null;
  if (lifecycle === undefined || !LIFECYCLE_VALUES.has(lifecycle)) return null;
  if (created === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(created)) return null;

  return {
    slug,
    description,
    type: type as MemoryTypeValue,
    lifecycle: lifecycle as LifecycleValue,
    created,
    body,
  };
}

/**
 * Keep only entries whose `lifecycle` is in `stages` (the recall filter). PURE.
 * For the evaluator run start: `stages = [Evaluate, General]`.
 */
export function filterByLifecycle(
  entries: ParsedMemoryEntry[],
  stages: LifecycleValue[],
): ParsedMemoryEntry[] {
  const want = new Set<string>(stages);
  return entries.filter((e) => want.has(e.lifecycle));
}

/** The default recall filter for an EVALUATE run: {evaluate, general}. */
export const EVALUATE_RECALL: LifecycleValue[] = [Lifecycle.Evaluate, Lifecycle.General];

export interface ReadMemoryResult {
  exists: boolean;
  /** entries matching the lifecycle filter, sorted by slug (deterministic). */
  entries: ParsedMemoryEntry[];
  /** files that failed to parse (skipped) — surfaced for honesty, never fatal. */
  skipped: string[];
}

/**
 * Read `<memoryDir>/*.md` (excluding the `MEMORY.md` index), parse each, and
 * return the entries matching `stages` (default = EVALUATE_RECALL). A missing dir
 * → `{ exists:false, entries:[] }`. A malformed file is SKIPPED (listed in
 * `skipped`). Deterministic: entries sorted by slug. The ONLY impure edge.
 */
export function readMemoryDir(
  memoryDir: string,
  stages: LifecycleValue[] = EVALUATE_RECALL,
): ReadMemoryResult {
  if (!existsSync(memoryDir)) return { exists: false, entries: [], skipped: [] };

  const files = readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort();

  const parsed: ParsedMemoryEntry[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const stem = f.replace(/\.md$/, "");
    let text: string;
    try {
      text = readFileSync(join(memoryDir, f), "utf8");
    } catch {
      skipped.push(f);
      continue;
    }
    const entry = parseMemoryEntry(text, stem);
    if (entry === null) {
      skipped.push(f);
      continue;
    }
    parsed.push(entry);
  }

  return { exists: true, entries: filterByLifecycle(parsed, stages), skipped };
}

/**
 * Render the recalled entries as a compact operator-preference context block for
 * injection at run start (one bullet per entry: type · slug · description). PURE.
 * EMPTY string when nothing recalled (a run with no AutoMemory is byte-identical
 * to the legacy no-memory path).
 */
export function renderRecallContext(entries: ParsedMemoryEntry[]): string {
  if (entries.length === 0) return "";
  const bullets = entries
    .map((e) => `- [${e.type}] ${e.slug} — ${e.description}`)
    .join("\n");
  return `AutoMemory (operator preferences · evaluate + general):\n${bullets}`;
}

// ── CLI — thin wrapper (print the recalled entries for a project root) ─────────
// bun scripts/memory/read.ts [project-root]

function memoryDirFor(projectRoot: string): string {
  return join(projectRoot, ".mutagent", "memory");
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  const projectRoot = argv[2] ?? process.cwd();
  const result = readMemoryDir(memoryDirFor(projectRoot));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}
