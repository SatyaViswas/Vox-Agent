// ---------------------------------------------------------------------------
// monitor/slack-notify — the External Monitor's OWN Slack emitter (EXT-1).
//
// The OUTWARD monitor's voice: a discrete NOTIFICATION (one standalone message)
// each time a trigger fires — human-readable + precise (trigger · what fired ·
// routed stage). This is NOT a live thread (that is the dogfood monitor's voice,
// dogfood/slack-thread.ts); it is a one-shot event notification.
//
// PURE message builder: `monitorNotifyMessage(match, meta) → SlackMsg` is
// `input → message`, no I/O/clock/random — identical input ⇒ byte-identical text
// (deterministic tests). Posting goes through `../slack/post` (the ONE shared
// impure seam), config-gated: an unconfigured sink ⇒ a no-op that touches ZERO
// network (the guard lives in slack/post — a broken/absent Slack never errors).
//
// SEPARATION (load-bearing — ADR-6/ADR-11): this emitter imports ONLY `../slack/*`
// (shared transport + primitives) + its sibling `./triggers.ts` (the TriggerMatch
// type). It NEVER imports the dogfood monitor's emitter (`../dogfood/*`). Shared
// transport, separate semantics — a test asserts the import boundary.
// ---------------------------------------------------------------------------

import { bold, code, italic } from "../slack/format.ts";
import { postMessage } from "../slack/post.ts";
import type { PostDeps, PostResult, SlackMsg } from "../slack/post.ts";
import type { TriggerMatch } from "./triggers.ts";

/** Routing ADL-stage → a compact display label with its circled numeral (self-contained). */
const STAGE_DISPLAY: Readonly<Record<string, string>> = {
  spec: "① SPEC",
  build: "② BUILD",
  evaluate: "③ EVALUATE",
  diagnose: "④ DIAGNOSE",
  optimize: "⑤ OPTIMIZE",
  audit: "③ EVALUATE (audit)",
};

/** Display a stage token; unknown tokens fall back to their upper-case form. */
function stageLabel(stage: string): string {
  return STAGE_DISPLAY[stage] ?? stage.toUpperCase();
}

/** Metadata for a monitor notification (optional context on the fired trigger). */
export interface MonitorNotifyMeta {
  /** Human project label (the monitored system), optional. */
  project?: string;
}

/**
 * Build the discrete notification for one fired trigger. PURE + deterministic —
 * identical (match, meta) ⇒ identical `SlackMsg`. `kind:"root"` because each
 * notification is a standalone top-level message (not a thread reply).
 */
export function monitorNotifyMessage(match: TriggerMatch, meta: MonitorNotifyMeta = {}): SlackMsg {
  const project = meta.project ? ` · project ${bold(meta.project)}` : "";
  const runs = match.run ? ` · runs ${code(match.run)}` : "";
  const text =
    `🛰️ ${bold("External Monitor")} — trigger ${code(match.rule.on)} fired → routed ` +
    `${bold(stageLabel(match.stage))}${project} · ${italic(match.reason)}${runs}`;
  return { kind: "root", text };
}

/**
 * The External Monitor's Slack sink config (mirrors `config.monitor.slack`). Kept
 * as a LOCAL structural type — this emitter deliberately does NOT import
 * `../config-schema.ts` (the separation boundary is `../slack/*` only). The agent
 * passes `config.monitor?.slack` in.
 */
export interface MonitorSlackConfig {
  enabled?: boolean;
  channel: string;
  /** The ENV-VAR NAME holding the bot token (xoxb-…) — a reference, never a secret. */
  token_ref: string;
}

/** A resolved Slack sink — a concrete channel + bot token ready to post with. */
export interface MonitorSink {
  channel: string;
  token: string;
}

/**
 * Resolve `config.monitor.slack` to a concrete sink, or null when Slack is not
 * configured. Active ONLY when `enabled:true` AND the `token_ref` env var is set
 * (same discipline as the dogfood sink / credentials_ref: `token_ref` is an
 * env-var NAME, never a raw secret). `env` is INJECTED so tests stay deterministic
 * (defaults to `process.env`).
 */
export function resolveMonitorSink(
  slack: MonitorSlackConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): MonitorSink | null {
  if (slack === undefined || slack.enabled !== true) return null;
  const token = env[slack.token_ref];
  if (token === undefined || token.length === 0) return null;
  return { channel: slack.channel, token };
}

/**
 * Post a monitor notification via the shared transport. CONFIG-GATED NO-OP: with a
 * null sink (Slack unconfigured/disabled) the underlying `postMessage` receives an
 * empty channel/undefined token and no-ops — returns null, ZERO network. `deps`
 * injects `fetch` for tests (mirrors slack/post).
 */
export async function postMonitorNotification(
  match: TriggerMatch,
  meta: MonitorNotifyMeta,
  sink: MonitorSink | null,
  deps: PostDeps = {},
): Promise<PostResult | null> {
  const msg = monitorNotifyMessage(match, meta);
  return postMessage({ channel: sink?.channel ?? "", text: msg.text, token: sink?.token }, deps);
}
