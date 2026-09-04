/**
 * scripts/unitf-to-evaltrace.ts — the STRANGLER projection adapter.
 * ---------------------------------------------------------------------------
 * Projects one UniTF `UnifiedTrace` record → the evaluator's in-package
 * `EvalTrace` shape (MIGRATION-diagnostics-evaluator.md §3.2). This REPLACED (and
 * the flip DELETED) `load-traces.ts` `mapRecord` (raw Langfuse → EvalTrace):
 * instead of mapping a raw platform record, the evaluator reads a PRE-NORMALIZED
 * UniTF JSONL handed over by `mutagent-cli` and projects each record here. All
 * downstream (sample-traces / profile-subject / discover / judge / scorecard)
 * consumes the resulting `EvalTrace[]` UNCHANGED.
 *
 * STANDALONE — the UniTF type shape is PORTED (a minimal structural subset), NOT
 * imported from `@mutagent/tools`. The boundary between the CLI and this skill is
 * the JSONL file on disk, never a source import (avoids a cross-package cycle;
 * see the migration doc §6.1 "Circular import" risk row). Only the fields the
 * projection actually reads are ported.
 *
 * PURE + deterministic: no clock, no random, no I/O. (The effectful JSONL read
 * lives in `read-unitf-traces.ts`, which calls this.)
 */
import type { EvalTrace, TraceObservation } from "./contracts/eval-types.ts";

// ── Ported minimal UniTF shape (structural subset of @mutagent/tools unitf.ts) ──
//
// Intentionally a LOOSE structural mirror — a `UnifiedTrace` handed over on disk
// carries the full frozen schema, but the projection reads only these fields.
// Kept in-package so the skill never source-imports the tools package.

/** The message-style role a UniTF span may carry (transcript projection). */
export type UnitfRole = "user" | "assistant" | "system" | "tool" | "toolResult";

/** The OTel-aligned span kind. Kept as the literal union the projection branches on. */
export type UnitfSpanKind =
  | "llm"
  | "tool"
  | "retrieval"
  | "agent"
  | "event"
  | "span";

/** The OTel-aligned status a UniTF span (and the trace) may carry. */
export type UnitfStatus = "ok" | "error" | "unknown";

/** Token usage split (structural subset of @mutagent/tools `TokensSchema`). */
export interface UnitfTokens {
  input?: number;
  output?: number;
  total?: number;
}

/** One UniTF span (unifies a message AND an observation). Structural subset. */
export interface UnitfSpan {
  name: string;
  kind: UnitfSpanKind;
  role?: UnitfRole;
  /** XF-FIX Finding C — span-level status, used to derive the trace `errored` flag. */
  status?: UnitfStatus;
  input?: unknown;
  output?: unknown;
}

/** A raw platform score, carried through verbatim (Langfuse-style). */
export interface UnitfScore {
  name: string;
  value?: number | string | boolean;
  comment?: string;
  dataType?: string;
}

/** The `ext.eval` fidelity block the fidelity gate reads. Structural subset. */
export interface UnitfEvalExt {
  incomplete?: boolean;
  incompleteReason?: string;
}

/** The derived `computed` convenience block (structural subset). NEVER authoritative —
 *  read only as a fallback, exactly as the diagnostics adapter does. */
export interface UnitfComputed {
  hasError?: boolean;
  totalTokens?: number;
}

/** One UniTF record. Structural subset of the frozen `UnifiedTrace` contract. */
export interface UnifiedTraceLike {
  traceId: string;
  agentName?: string;
  latencyMs?: number;
  costUsd?: number;
  tags?: string[];
  scores?: UnitfScore[];
  spans: UnitfSpan[];
  /** XF-FIX Finding C — top-level trace status (`ok|error|unknown`). */
  status?: UnitfStatus;
  /** XF-FIX Finding D — trace-level token usage. */
  tokens?: UnitfTokens;
  /** XF-FIX Finding D — derived convenience block (hasError / totalTokens fallbacks). */
  computed?: UnitfComputed;
  ext?: {
    eval?: UnitfEvalExt;
  };
}

// ── Text derivation (ported from @mutagent/tools derive.ts `asText`) ─────────
//
// A span's input/output is `unknown` — real exports carry nested payloads. The
// evaluator's `EvalTrace.input.prompt` / `output.response` are strings, so a
// deterministic best-effort stringify is needed. Mirrors the tools-package
// `asText` (pull a known text-ish field, else stable JSON) so a value projected
// here matches what a diagnostics `messagesView` would render.

/** Best-effort deterministic stringify of a span payload. PURE. */
function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["text", "content", "response", "prompt", "message"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

// ── Role kind-fallback (XF-FIX Finding A) ────────────────────────────────────
//
// ROOT CAUSE of the Langfuse loss: `langfuse.ts obsToSpan` never sets `span.role`
// (a Langfuse observation carries no message role). The old projection derived
// the prompt from `role∈{user,system}` and the response from `role==="assistant"
// && kind==="llm"` — BOTH miss on a role-less span ⇒ `input.prompt` / `output.
// response` were empty for EVERY Langfuse trace. Diagnostics never had this bug:
// its `unitf-adapter.ts` `spanMessageRole` falls back to `kind` when `role` is
// absent. This mirrors that fallback so the evaluator lane survives the identical
// role-less input Diagnostics already reads fine (reader-side fix — the shared
// `langfuse.ts` producer is deliberately NOT touched, keeping the clean
// Diagnostics lane untouched).

/**
 * The span's effective message role. When an explicit `role` is present it wins;
 * otherwise it is inferred from `kind` (a role-less `llm`/`agent` span — the
 * Langfuse GENERATION shape — reads as `assistant`; a `tool` span as `tool`).
 * MIRRORS diagnostics `unitf-adapter.ts` `spanMessageRole`. PURE.
 *
 * NOTE: inference never yields `user`/`system` (a role-less span is never a user
 * turn), so prompt detection still requires an EXPLICIT user/system role — the
 * Langfuse prompt is recovered from the GENERATION span's own `input` instead
 * (see the response-span input fallback in the projection).
 */
function effectiveRole(span: UnitfSpan): UnitfRole {
  if (span.role !== undefined) return span.role;
  switch (span.kind) {
    case "llm":
    case "agent":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return "assistant";
  }
}

// ── Message-text pick (INF-1) ────────────────────────────────────────────────
//
// ROOT CAUSE of the Claude Code loss: the Claude Code exporter writes BOTH user
// and assistant TEXT into `span.output` (a user turn is `kind:"event", role:"user",
// output:<text>`; an assistant turn is `kind:"llm", role:"assistant", output:<text>`
// with `input` UNSET). The old projection read a user/system span's `.input` — empty
// for EVERY Claude Code trace ⇒ `input.prompt` silently empty for all 21/21.
//
// This VENDORS the shared reader's role-conditional pick + fallback
// (@mutagent/tools `messagesView`, derive.ts:173-174): a user/system turn's text is
// canonically in `input`, everything else in `output`, but the `?? input ?? output`
// fallback recovers the text WHICHEVER field a producer used. Vendored — never
// imported: the standalone-publish guard forbids the evaluator reaching into
// @mutagent/tools (MIGRATION-diagnostics-evaluator.md:417); diagnostics vendors its
// own copy and this mirrors that.

/**
 * The span's effective message TEXT: the role-conditional field pick with the
 * `?? input ?? output` fallback (mirrors @mutagent/tools `messagesView`). Recovers
 * a Claude Code turn (text in `output`) AND a Langfuse turn (text in `input`).
 * PURE; "" when the span carries no text.
 */
function messageText(span: UnitfSpan): string {
  const role = effectiveRole(span);
  const primary = role === "user" || role === "system" ? span.input : span.output;
  return asText(primary ?? span.input ?? span.output);
}

// ── Token total fallback (XF-FIX Finding D) ──────────────────────────────────
//
// MIRRORS diagnostics `unitf-adapter.ts` `fallbackTotalTokens` so both lanes
// report the SAME total: prefer `tokens.total`, else `input + output` when either
// is present, else undefined (NEVER 0 — an absent count stays absent).

/** Best-effort trace total from a `UnitfTokens` split. PURE; undefined-safe. */
function fallbackTotalTokens(t: UnitfTokens | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (t.total !== undefined) return t.total;
  if (t.input !== undefined || t.output !== undefined) {
    return (t.input ?? 0) + (t.output ?? 0);
  }
  return undefined;
}

/**
 * Project a UniTF record → EvalTrace (migration doc §3.2 mapping table).
 *
 *   id               ← ut.traceId
 *   name             ← ut.agentName
 *   output           ← LAST EFFECTIVE-assistant llm span WITH text → { response: <messageText> }
 *                      (XF-FIX A: role-less GENERATION spans read as assistant via kind;
 *                       INF-1: last-with-text, and messageText recovers Claude Code's `output`)
 *   input            ← first user|system span's messageText, ELSE the response span's own
 *                      input → { prompt } (XF-FIX A: Langfuse prompt; INF-1: Claude Code `output`)
 *   observations     ← ut.spans → { type: kind.toUpperCase(), name, input, output }
 *   errored/status   ← computed.hasError ?? (status==="error" || any span error) / ut.status (XF-FIX C)
 *   tokens/totalTokens← ut.tokens split / computed.totalTokens ?? tokens.total ?? in+out (XF-FIX D)
 *   scores           ← ut.scores (verbatim)
 *   tags             ← ut.tags
 *   latencyMs/costUsd← ut.latencyMs / ut.costUsd
 *   incomplete       ← ut.ext.eval.incomplete ?? false (the §9.4.2 fidelity marker)
 *   incompleteReason ← ut.ext.eval.incompleteReason
 *
 * PURE + deterministic — same record ⇒ same EvalTrace.
 */
export function projectUnitfToEvalTrace(ut: UnifiedTraceLike): EvalTrace {
  const observations: TraceObservation[] = ut.spans.map((span) => {
    const obs: TraceObservation = { type: span.kind.toUpperCase() };
    if (span.name !== undefined) obs.name = span.name;
    if (span.input !== undefined) obs.input = span.input;
    if (span.output !== undefined) obs.output = span.output;
    return obs;
  });

  const out: EvalTrace = {
    id: ut.traceId,
    observations,
  };

  if (ut.agentName !== undefined) out.name = ut.agentName;

  // output ← the LAST assistant LLM span WITH text, wrapped to { response }. The
  // assistant role is EFFECTIVE (XF-FIX Finding A): a role-less GENERATION span
  // (kind==="llm", the Langfuse shape) reads as assistant via `effectiveRole`. The
  // second INF-1 miss: the old code took the FIRST assistant span — on Claude Code
  // that is usually a tool_use turn with EMPTY output text, so the real reply (a
  // LATER assistant span) was dropped. Take the LAST assistant span that carries
  // text; the `messageText` pick recovers it from `output` (Claude Code) or `input`
  // (whichever field the producer used).
  const assistantSpans = ut.spans.filter(
    (s) => effectiveRole(s) === "assistant" && s.kind === "llm",
  );
  let responseSpan: UnitfSpan | undefined;
  for (const s of assistantSpans) {
    if (messageText(s).length > 0) responseSpan = s; // keep the LAST with text
  }
  // Fall back to the last assistant span even without text, so the response SLOT is
  // still derived from a real span (the empty case is WARNED at intake, not here).
  const lastAssistant =
    responseSpan ?? (assistantSpans.length > 0 ? assistantSpans[assistantSpans.length - 1] : undefined);
  if (responseSpan !== undefined) {
    out.output = { response: messageText(responseSpan) };
  }

  // input ← the first user|system span's TEXT, wrapped to { prompt }. `messageText`
  // recovers the text from `output` (Claude Code writes the user turn there) or
  // `input` (Langfuse). When there is no explicit user/system turn (the Langfuse
  // shape — one GENERATION span carrying the prompt in its OWN `input` and the
  // response in `output`) the prompt is recovered from the response span's `input`
  // SPECIFICALLY (not `messageText`, which for an assistant span would return the
  // response). Without these fallbacks `input.prompt` was empty for every Claude
  // Code trace (INF-1) and every Langfuse trace (Finding A).
  const promptSpan = ut.spans.find(
    (s) => effectiveRole(s) === "user" || effectiveRole(s) === "system",
  );
  let promptText = promptSpan !== undefined ? messageText(promptSpan) : "";
  if (promptText.length === 0 && lastAssistant !== undefined && lastAssistant.input !== undefined) {
    promptText = asText(lastAssistant.input);
  }
  if (promptText.length > 0) out.input = { prompt: promptText };

  // Finding C — carry structured error/status so an error-KIND criterion has a
  // field to read (previously error state survived only as textual span output).
  // `errored` mirrors diagnostics `computed.hasError ?? status==="error"`, extended
  // to also honor any span-level error. Always set (false = grounded not-errored).
  if (ut.status !== undefined) out.status = ut.status;
  out.errored =
    ut.computed?.hasError ??
    (ut.status === "error" || ut.spans.some((s) => s.status === "error"));

  // Finding D — carry token usage (undefined-safe; never coerced to 0) so a
  // token-budget criterion is supported at intake, alongside the already-carried
  // costUsd + latencyMs. `totalTokens` uses the diagnostics fallback chain.
  if (ut.tokens !== undefined) {
    const tk: { input?: number; output?: number; total?: number } = {};
    if (typeof ut.tokens.input === "number") tk.input = ut.tokens.input;
    if (typeof ut.tokens.output === "number") tk.output = ut.tokens.output;
    if (typeof ut.tokens.total === "number") tk.total = ut.tokens.total;
    if (tk.input !== undefined || tk.output !== undefined || tk.total !== undefined) {
      out.tokens = tk;
    }
  }
  const totalTokens = ut.computed?.totalTokens ?? fallbackTotalTokens(ut.tokens);
  if (totalTokens !== undefined) out.totalTokens = totalTokens;

  if (ut.scores !== undefined) out.scores = ut.scores;
  if (ut.tags !== undefined) {
    out.tags = ut.tags.filter((t): t is string => typeof t === "string");
  }
  if (typeof ut.latencyMs === "number") out.latencyMs = ut.latencyMs;
  if (typeof ut.costUsd === "number") out.costUsd = ut.costUsd;

  // §9.4.2 fidelity marker — projected DIRECTLY from ext.eval so an incomplete
  // trace never reaches the criteria walk unflagged.
  const incomplete = ut.ext?.eval?.incomplete ?? false;
  if (incomplete) out.incomplete = true;
  const reason = ut.ext?.eval?.incompleteReason;
  if (typeof reason === "string" && reason.length > 0) out.incompleteReason = reason;

  return out;
}
