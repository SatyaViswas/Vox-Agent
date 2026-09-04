// ---------------------------------------------------------------------------
// extract-feedback — turn a Helix session transcript into ACTIONABLE, rationale-
// backed feedback items. Two channels:
//
//   EXPLICIT  — verbatim `[feedback] … [feedback]` (or `[feedback] … [/feedback]`)
//               blocks the user typed. Captured VERBATIM with provenance.
//   IMPLICIT  — the P-0 deterministic signals reused from `mutagent-tools`:
//               negative-reaction (frustration/profanity wordlist) + chat-feedback
//               (a short evaluative reaction after an assistant turn).
//
// GROUNDING (anti-fabrication): every item carries an `evidencePointer` whose
// `quote` is verbatim from the transcript, and every `actionable` cites the turn it
// came from. We NEVER invent an observation the transcript doesn't support.
//
// PURITY: pure — no clock, no random, no I/O. Input is an already-parsed UniTF
// trace (the main session, via the shared claude-code adapter).
// ---------------------------------------------------------------------------

import { scanNegativeReaction } from "../../../mutagent-tools/src/signals/negative-reaction.ts";
import { detectChatFeedback } from "../../../mutagent-tools/src/signals/chat-feedback.ts";
import type { Span, UnifiedTrace } from "../../../mutagent-tools/src/format/unitf.ts";

import type { EvidencePointer, FeedbackItem } from "./types.ts";

/** A transcript is a parsed UniTF trace (the main Helix session). */
export type Transcript = UnifiedTrace;

/** Cap for a verbatim snippet quoted inside an `actionable`/`quote` (still verbatim-prefix). */
const SNIPPET_MAX = 280;

/** Best-effort deterministic stringify of a span input/output payload. */
function spanText(v: unknown): string {
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

/** Verbatim-prefix snippet (never paraphrased) for inline citation. */
function snippet(text: string): string {
  const t = text.trim();
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX)}…`;
}

interface UserTurn {
  /** Ordinal position among user turns (the transcript-line pointer). */
  ordinal: number;
  spanId: string;
  text: string;
}

/** The ordered user turns of a transcript (role === "user" spans). */
function userTurns(t: Transcript): UserTurn[] {
  const turns: UserTurn[] = [];
  let ordinal = 0;
  for (const span of t.spans) {
    if (span.role !== "user") continue;
    turns.push({ ordinal, spanId: span.spanId, text: spanText(span.output ?? span.input) });
    ordinal++;
  }
  return turns;
}

/** The `[feedback] … [feedback]` / `[feedback] … [/feedback]` block matcher. */
const FEEDBACK_BLOCK_RE = /\[feedback\]([\s\S]*?)\[\/?feedback\]/gi;

/**
 * DOG-1 — the explicit-`[feedback]` self-reference boundary (the reflexivity
 * ship-gate). A capability that READS text will read its OWN design docs: this
 * session literally contains `[feedback]` as documentation (a plan quoting its
 * trigger word). We must capture a REAL operator `[feedback]` directive — a turn
 * that IS the input — and DROP a turn that merely QUOTES a document mentioning
 * the token.
 *
 * `maskQuotedContext` returns a per-character boolean mask marking QUOTED regions
 * — fenced code blocks (``` / ~~~), blockquote lines (`> …`), and inline-code
 * spans (`` `…` ``). A `[feedback]` block whose OPENING delimiter falls inside a
 * masked region is documentation, not a directive, and is skipped. Genuine
 * top-level directives are never masked, so their verbatim body is preserved.
 */
export function maskQuotedContext(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const setRange = (start: number, end: number): void => {
    for (let i = start; i < end && i < text.length; i++) mask[i] = true;
  };

  let offset = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const trimmed = line.trimStart();
    const isFenceDelim = trimmed.startsWith("```") || trimmed.startsWith("~~~");

    if (isFenceDelim) {
      // The fence delimiter line itself is quoted context either way.
      setRange(lineStart, lineEnd);
      inFence = !inFence;
    } else if (inFence) {
      setRange(lineStart, lineEnd); // inside a fenced code block
    } else if (trimmed.startsWith(">")) {
      setRange(lineStart, lineEnd); // a blockquote line
    } else {
      // inline-code spans on this line (`…`, ``…``): mask the whole span
      const inlineCode = /(`+)[^\n]*?\1/g;
      let m: RegExpExecArray | null;
      while ((m = inlineCode.exec(line)) !== null) {
        setRange(lineStart + m.index, lineStart + m.index + m[0].length);
        if (m.index === inlineCode.lastIndex) inlineCode.lastIndex++; // guard zero-width
      }
    }
    offset = lineEnd + 1; // +1 for the consumed "\n"
  }
  return mask;
}

function evidence(sessionId: string, turn: UserTurn, quote: string): EvidencePointer {
  return { sessionId, spanId: turn.spanId, turnIndex: turn.ordinal, quote: snippet(quote) };
}

/**
 * Extract explicit + implicit feedback from a transcript → actionable items.
 * Deterministic order: explicit blocks (turn order) → negative-reaction turns
 * (turn order) → chat-feedback reaction (if any).
 */
export function extractFeedback(transcript: Transcript): FeedbackItem[] {
  const sessionId = transcript.sessionId ?? transcript.traceId;
  const turns = userTurns(transcript);
  const items: FeedbackItem[] = [];

  // ── EXPLICIT: verbatim [feedback] blocks (DOG-1 boundary) ───────────────────
  for (const turn of turns) {
    // Quoted-context mask: a [feedback] opening inside a fence/blockquote/inline-
    // code region is DOCUMENTATION (a doc-mention), not an operator directive.
    const mask = maskQuotedContext(turn.text);
    FEEDBACK_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FEEDBACK_BLOCK_RE.exec(turn.text)) !== null) {
      if (mask[m.index] === true) continue; // opening delimiter is quoted → not a directive
      const body = m[1].trim();
      if (body.length === 0) continue;
      const neg = scanNegativeReaction(body);
      items.push({
        source: "explicit",
        kind: "feedback-block",
        observation: body,
        actionable: `Act on the user's explicit feedback (turn ${turn.ordinal}): "${snippet(body)}"`,
        rationale: `Verbatim [feedback] block — a deliberate user signal (session ${sessionId}, turn ${turn.ordinal}).`,
        severity: neg.hit ? "high" : "med",
        evidencePointer: evidence(sessionId, turn, body),
      });
    }
  }

  // ── IMPLICIT: P-0 negative-reaction (per user turn) ─────────────────────────
  for (const turn of turns) {
    const neg = scanNegativeReaction(turn.text);
    if (!neg.hit) continue;
    items.push({
      source: "implicit",
      kind: "negative-reaction",
      observation: `Negative-reaction terms in a user turn: ${neg.terms.join(", ")}.`,
      actionable: `Review the assistant turn preceding turn ${turn.ordinal} — the user reacted negatively ("${snippet(turn.text)}").`,
      rationale: `P-0 negative-reaction signal (wordlist hit ×${neg.count}) over user-role text.`,
      severity: neg.count >= 2 ? "high" : "med",
      evidencePointer: evidence(sessionId, turn, turn.text),
    });
  }

  // ── IMPLICIT: P-0 chat-feedback (a short evaluative reaction after assistant) ─
  const chat = detectChatFeedback(transcript.spans as Span[]);
  if (chat.hasChatFeedback && chat.turnIndex !== undefined) {
    const span = transcript.spans[chat.turnIndex];
    if (span && span.role === "user") {
      // map the span back to its user-turn ordinal
      const turn = turns.find((t) => t.spanId === span.spanId);
      if (turn) {
        items.push({
          source: "implicit",
          kind: "chat-feedback",
          observation: `In-conversation evaluative reaction detected at turn ${turn.ordinal}.`,
          actionable: `Check whether the preceding assistant turn satisfied the user — an evaluative marker appears at turn ${turn.ordinal} ("${snippet(turn.text)}").`,
          rationale: `P-0 chat-feedback heuristic (short user reaction with an evaluative marker after an assistant turn).`,
          severity: "low",
          evidencePointer: evidence(sessionId, turn, turn.text),
        });
      }
    }
  }

  return items;
}
