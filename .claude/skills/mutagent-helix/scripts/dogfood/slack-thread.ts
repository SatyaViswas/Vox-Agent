// ---------------------------------------------------------------------------
// dogfood/slack-thread — the DOGFOOD-ONLY Slack emitter (DOG-3): a LIVE THREAD.
//
// One dogfood session ⇒ one Slack thread: a ROOT message on start + typed
// THREADED replies as the session moves (stage-change · agent-dispatch ·
// feedback · signal · progress-heartbeat · stop). Human-readable + precise —
// coworkers follow the pulse in Slack while the HTML report stays the deep view.
//
// PURE: `dogfoodThreadMessages(events, meta) → SlackMsg[]` is `input → messages`,
// no I/O/clock/random. The run-report watch loop diffs successive trajectories
// into `DogfoodEvent[]`, calls this, and posts via `slack/post` (the only impure
// seam). SEPARATION (load-bearing): this emitter imports ONLY `../slack/*` — it
// is the dogfood VOICE and never imports the External Monitor's (`../monitor/*`).
// ---------------------------------------------------------------------------

import { bold, code, italic } from "../slack/format.ts";
import type { SlackMsg } from "../slack/post.ts";

/**
 * A dogfood live-thread event (derived by the watch loop from successive
 * trajectory diffs). The union is closed so the emitter is exhaustive.
 */
export type DogfoodEvent =
  | { type: "stage-change"; to: string; from?: string }
  | { type: "agent-dispatch"; agent: string; stage?: string; role?: string }
  | { type: "feedback"; text: string; severity?: string }
  | { type: "signal"; kind: string; count?: number }
  | { type: "progress"; minutes: number; commands: number; feedback: number; subagents: number }
  | { type: "stop"; commands: number; feedback: number };

/** Metadata for the thread ROOT (posted once on start). */
export interface DogfoodThreadMeta {
  sessionId: string;
  /** Human project label (the dogfood target), optional. */
  project?: string;
  /** Cadence label for the root ("3m" etc.); default "3m". */
  cadenceLabel?: string;
}

/** ADL-stage → a compact display label with its circled numeral (self-contained). */
const STAGE_DISPLAY: Readonly<Record<string, string>> = {
  spec: "① SPEC",
  build: "② BUILD",
  discover: "◇ DISCOVER",
  evaluate: "③ EVALUATE",
  diagnose: "④ DIAGNOSE",
  optimize: "⑤ OPTIMIZE",
  meta: "· META",
};

/** Display a stage token; unknown tokens fall back to their upper-case form. */
function stageLabel(stage: string): string {
  return STAGE_DISPLAY[stage] ?? stage.toUpperCase();
}

/** Short session id for the root header (first 8 chars + ellipsis when longer). */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Render the thread ROOT message from the session meta. */
function rootText(meta: DogfoodThreadMeta): string {
  const project = meta.project ? ` · project ${bold(meta.project)}` : "";
  const cadence = meta.cadenceLabel ?? "3m";
  return `🧬 ${bold("Dogfood live")} — session ${code(shortId(meta.sessionId))}${project} · watching (${cadence} + on-drift)`;
}

/** Render ONE event to its threaded-reply text. */
function eventText(ev: DogfoodEvent): string {
  switch (ev.type) {
    case "stage-change": {
      const from = ev.from ? ` (from ${stageLabel(ev.from)})` : "";
      return `⏩ Stage → ${bold(stageLabel(ev.to))}${from}`;
    }
    case "agent-dispatch": {
      const parts: string[] = [];
      if (ev.stage) parts.push(stageLabel(ev.stage));
      if (ev.role) parts.push(ev.role);
      const suffix = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
      return `🤖 dispatched ${code(ev.agent)}${suffix}`;
    }
    case "feedback":
      return `💬 feedback — ${italic(`"${ev.text}"`)}`;
    case "signal": {
      const count = ev.count !== undefined ? ` ×${ev.count}` : "";
      return `⚠️ signal — ${ev.kind}${count}`;
    }
    case "progress":
      return `📊 ${ev.minutes}m · ${ev.commands} commands · ${ev.feedback} feedback · ${ev.subagents} subagents`;
    case "stop":
      return `🏁 watch ended · ${ev.commands} commands · ${ev.feedback} feedback · report attached`;
  }
}

/**
 * Build the full thread message list for a session: the ROOT (from meta) followed
 * by one threaded REPLY per event, in order. PURE + deterministic — identical
 * (events, meta) ⇒ identical `SlackMsg[]`.
 */
export function dogfoodThreadMessages(events: DogfoodEvent[], meta: DogfoodThreadMeta): SlackMsg[] {
  const msgs: SlackMsg[] = [{ kind: "root", text: rootText(meta) }];
  for (const ev of events) {
    msgs.push({ kind: "reply", text: eventText(ev) });
  }
  return msgs;
}
