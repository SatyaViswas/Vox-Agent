import * as fs from "node:fs";
import * as path from "node:path";

import { feedbackPath, resolveConfigRoot } from "./resolve-paths.ts";

// ---------------------------------------------------------------------------
// feedback — the ADL feedback channel (INF-6).
//
// Friction found while USING the ADL tools (Helix + the lifecycle stages) has no
// home of its own — findings get mis-filed against whatever system happened to be
// running. This is the durable feedback surface: an append-only markdown file at
// `<root>/.mutagent/feedback.md`, modelled on the auto-memory pattern (a header +
// appended, timestamped notes carrying markdown links to the finding/session).
//
// COMPOSITION (operator constraint): the file is the DURABLE STORE. A later
// `mutagent-cli feedback` command is just a WRITER on top of this — it calls
// `appendFeedback` rather than being a separate store. Build the file mechanism
// now; the CLI writes into it later. Keeping the append logic here (not in the CLI)
// is what makes that composition free.
//
// Design invariants (mirror resolve-credential.ts / resolve-paths.ts):
//   - Pure core (`formatFeedbackEntry`, `renderFeedbackAppend`) — no fs, no clock.
//   - `appendFeedback` takes INJECTED deps (reader + writer + clock) → deterministic
//     tests; a thin live wrapper binds real fs + the wall clock.
//   - First write seeds the file header; later writes append only the entry.
// ---------------------------------------------------------------------------

/** The banner written once, when feedback.md is first created. */
export const FEEDBACK_HEADER = `# ADL Feedback Channel

> Append-only notes about friction in the ADL tools (Helix + lifecycle stages).
> Auto-memory style: each entry is a timestamped note with markdown links to the
> originating finding/session. The durable store; a \`mutagent-cli feedback\`
> command writes into this same file.
`;

/** One feedback note. `links` are markdown-ready \`[text](target)\` targets. */
export interface FeedbackEntry {
  /** Short title for the note (becomes the entry heading). */
  title: string;
  /** The free-form note body (markdown). */
  note: string;
  /** Optional stage/source the friction was found in (e.g. "evaluate", "diagnose"). */
  stage?: string;
  /** Optional links to the finding/session — `{ text, target }` → `[text](target)`. */
  links?: { text: string; target: string }[];
  /** ISO timestamp; injected so the pure formatter stays deterministic. */
  at: string;
}

/** Pure: render ONE entry as a markdown block (no surrounding file state). */
export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const stageTag = entry.stage ? ` · \`${entry.stage}\`` : "";
  const lines: string[] = [`## ${entry.at}${stageTag} — ${entry.title}`, "", entry.note.trim()];
  if (entry.links && entry.links.length > 0) {
    lines.push("");
    for (const l of entry.links) lines.push(`- [${l.text}](${l.target})`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Pure: given the CURRENT file contents (or null if absent) and an entry, return
 * the full text to write back. Seeds the header on first write; otherwise appends
 * the entry after a blank-line separator. Never mutates input.
 */
export function renderFeedbackAppend(current: string | null, entry: FeedbackEntry): string {
  const block = formatFeedbackEntry(entry);
  if (current === null || current.trim() === "") {
    return `${FEEDBACK_HEADER}\n${block}`;
  }
  const base = current.endsWith("\n") ? current : current + "\n";
  return `${base}\n${block}`;
}

export interface AppendFeedbackDeps {
  /** Injected file reader → contents, or null if absent/unreadable. Never throws. */
  readFile: (p: string) => string | null;
  /** Injected file writer (creates parent dirs). */
  writeFile: (p: string, contents: string) => void;
  /** Injected clock → ISO string. */
  now: () => string;
}

/**
 * Append a feedback note to `feedback.md` at the given path. Pure-of-side-effects
 * except through the injected deps → deterministic under test. Returns the path
 * written and whether the file was freshly created.
 */
export function appendFeedback(
  filePath: string,
  entry: Omit<FeedbackEntry, "at"> & { at?: string },
  deps: AppendFeedbackDeps,
): { path: string; created: boolean } {
  const current = deps.readFile(filePath);
  const full: FeedbackEntry = { ...entry, at: entry.at ?? deps.now() };
  deps.writeFile(filePath, renderFeedbackAppend(current, full));
  return { path: filePath, created: current === null || current.trim() === "" };
}

// ---------------------------------------------------------------------------
// Live wrapper — binds real fs + wall clock. This is the entry point the future
// `mutagent-cli feedback` command reuses.
// ---------------------------------------------------------------------------

const liveDeps: AppendFeedbackDeps = {
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, contents) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents, "utf8");
  },
  now: () => new Date().toISOString(),
};

/** Live: append a note to the resolved `.mutagent/feedback.md` for the current process. */
export function recordFeedback(
  entry: Omit<FeedbackEntry, "at"> & { at?: string },
  startDir: string = process.cwd(),
): { path: string; created: boolean } {
  return appendFeedback(feedbackPath(resolveConfigRoot(startDir)), entry, liveDeps);
}
