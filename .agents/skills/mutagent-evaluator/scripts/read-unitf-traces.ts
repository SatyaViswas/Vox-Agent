/**
 * scripts/read-unitf-traces.ts — the STRANGLER entry point.
 * ---------------------------------------------------------------------------
 * Loads a handed-over UniTF `.jsonl` (one `UnifiedTrace` record per line,
 * produced by `mutagent-cli trace fetch --export …`) → `EvalTrace[]` via the
 * `projectUnitfToEvalTrace` adapter. This is now the ONLY trace-intake path — it
 * replaced (and the flip DELETED) the former `ingest-sources.ts` fetcher-registry
 * + `load-traces.ts` `mapRecord` stack: fetch/normalize now lives ENTIRELY in
 * `mutagent-cli`; the evaluator reads a PATH and never fetches.
 *
 * Tolerant by design (mirrors `parseNdjsonTraces`): blank lines are skipped,
 * malformed lines are SKIPPED + COUNTED (surfaced, never swallowed — a large
 * export must not abort on one bad line). `parseUnitfJsonl` is PURE; only
 * `readUnitfAsEvalTraces` touches the filesystem.
 */
import type { EvalTrace } from "./contracts/eval-types.ts";
import {
  projectUnitfToEvalTrace,
  type UnifiedTraceLike,
} from "./unitf-to-evaltrace.ts";

export interface ParsedUnitfTraces {
  traces: EvalTrace[];
  /** lines that failed to parse OR lacked the minimal UniTF shape (surfaced). */
  skipped: number;
  /**
   * INF-1 — traceIds of records that carry a prompt-bearing span (a user/system
   * turn, or an assistant/agent GENERATION span) yet projected to an EMPTY
   * `input.prompt`. This is the exact silent-empty symptom that read 21/21 blank
   * on Claude Code traces: the reader must WARN, never emit empty in silence. The
   * effectful reader/CLI surfaces this list; a non-empty list is a projection miss.
   */
  emptyPromptTraceIds: string[];
}

/**
 * Does this record carry a span that SHOULD yield a prompt — an explicit user/
 * system turn, or a GENERATION span (kind llm/agent, the Langfuse shape whose
 * `input` holds the prompt)? Used to WARN when such a record still projects an
 * empty `input.prompt` (the INF-1 silent-empty class). PURE.
 */
function hasPromptBearingSpan(rec: UnifiedTraceLike): boolean {
  return rec.spans.some(
    (s) =>
      s.role === "user" ||
      s.role === "system" ||
      s.kind === "llm" ||
      s.kind === "agent",
  );
}

/**
 * A parsed JSON line is a usable UniTF record when it is an object carrying a
 * non-empty `traceId` and a `spans` array — the minimal shape the projection
 * reads. A line that parses as JSON but is not a UniTF record is counted as
 * skipped (never silently coerced). PURE.
 */
function asUnitfRecord(value: unknown): UnifiedTraceLike | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.traceId !== "string" || rec.traceId.length === 0) return null;
  if (!Array.isArray(rec.spans)) return null;
  return rec as unknown as UnifiedTraceLike;
}

/**
 * Parse UniTF JSONL text → EvalTrace[]. One record per line; blank lines
 * skipped; malformed / non-UniTF lines skipped + counted. PURE + deterministic.
 */
export function parseUnitfJsonl(text: string): ParsedUnitfTraces {
  const traces: EvalTrace[] = [];
  const emptyPromptTraceIds: string[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const rec = asUnitfRecord(parsed);
    if (rec === null) {
      skipped += 1;
      continue;
    }
    const trace = projectUnitfToEvalTrace(rec);
    traces.push(trace);
    // INF-1 — WARN, never silently emit empty: a record with a prompt-bearing span
    // that still projected an empty prompt is a projection miss (the Claude Code
    // 21/21-blank class). Recorded here; the CLI/reader surfaces it.
    if (hasPromptBearingSpan(rec) && (trace.input?.prompt ?? "").length === 0) {
      emptyPromptTraceIds.push(trace.id);
    }
  }
  return { traces, skipped, emptyPromptTraceIds };
}

/**
 * Read a handed-over UniTF `.jsonl` file → EvalTrace[] via the projection. The
 * effectful entry point the evaluator calls in place of `ingestSources`. THROWS
 * only when the path is missing/unreadable — a malformed LINE inside is tolerated
 * (skipped + counted), never fatal.
 */
export async function readUnitfAsEvalTraces(
  jsonlPath: string,
): Promise<ParsedUnitfTraces> {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(jsonlPath, "utf8");
  return parseUnitfJsonl(text);
}
