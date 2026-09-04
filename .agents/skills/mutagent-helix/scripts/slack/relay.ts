/**
 * scripts/slack/relay.ts — the INBOUND Slack→Helix command relay (Slack control plane).
 * ═══════════════════════════════════════════════════════════════════════════════
 * The #1111 goal: an operator @-mentions Helix in a Slack channel with a command
 * (e.g. "@helix *diagnose the support agent" or plain "how are my evals?") and gets
 * Helix's real answer back IN THE THREAD.
 *
 * THE ONE HARD RULE (routing-ownership, see monitor-routing-ownership-report.md):
 *   This module is a DUMB TRANSPORT. It converts an inbound Slack event into a
 *   RelayEnvelope carrying the RAW message text + thread anchor, and posts a result
 *   back to that thread. It NEVER interprets intent, NEVER picks an ADL stage, NEVER
 *   decides a *command. That is HELIX's job (the orchestrator's resolveDispatch —
 *   Model-B / PR-ORCH-01: interpretation + routing + dispatch belong to the
 *   orchestrator, never to a script). The monitor may raise its hand; it may never
 *   choose the answer.
 *
 * This is the deterministic, testable core. The live Socket-Mode listener that
 * DELIVERS these events (a long-running connection) is a separate infra concern;
 * this module is what it feeds into and reads back from.
 */
import { postReply, type PostDeps, type PostResult } from "./post.ts";

/** A minimal inbound Slack event shape (app_mention / message). Extra fields ignored. */
export interface InboundSlackEvent {
  /** the message text, including the `<@BOTID>` mention token */
  text?: string;
  /** channel id (C…) the message landed in */
  channel?: string;
  /** the message's own ts */
  ts?: string;
  /** the thread the message belongs to (absent on a top-level message) */
  thread_ts?: string;
  /** the author's user id */
  user?: string;
  /** event type (app_mention / message) — carried for provenance only */
  type?: string;
}

/**
 * The dumb-transport payload handed to Helix. Carries the RAW command text and the
 * thread anchor — and DELIBERATELY nothing about which stage/command it is. Helix
 * decides that from `rawText`.
 */
export interface RelayEnvelope {
  /**
   * the operator's command: bot mention(s) stripped and whitespace-normalized (runs of
   * whitespace collapsed to a single space, trimmed). Otherwise the command is unaltered —
   * we do NOT parse, lowercase, or reinterpret it. Helix reads this raw.
   */
  rawText: string;
  /** channel to answer in */
  channel: string;
  /** the thread to answer in (the message's own ts if it started a new thread) */
  thread_ts: string;
  /** author user id, when present (provenance) */
  user?: string;
  /** the triggering message ts (dedupe / provenance) */
  ts: string;
  /** stable idempotency key for the triggering message (channel:thread:ts) */
  dedupeKey: string;
}

/** Strip every `<@USER>` mention token and collapse the surrounding whitespace. */
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Inbound event → RelayEnvelope, or `null` when there is nothing to relay.
 *
 * Returns null (a clean no-op, never an error) when: no channel, or the text is
 * empty AFTER stripping the mention (a bare "@helix" with no command). This does
 * ZERO interpretation of what the command means — it only extracts the raw text
 * and the thread anchor.
 */
export function parseInboundCommand(ev: InboundSlackEvent): RelayEnvelope | null {
  const channel = String(ev.channel ?? "");
  if (channel.length === 0) return null;

  const rawText = stripMentions(String(ev.text ?? ""));
  if (rawText.length === 0) return null; // bare mention, no command → nothing to relay

  const ts = String(ev.ts ?? "");
  // A reply inherits its thread; a top-level message STARTS a thread at its own ts.
  const thread_ts = String(ev.thread_ts ?? ev.ts ?? "");

  return {
    rawText,
    channel,
    thread_ts,
    user: ev.user ? String(ev.user) : undefined,
    ts,
    dedupeKey: `${channel}:${thread_ts}:${ts}`,
  };
}

/** Arguments for posting Helix's result back to the originating thread. */
export interface RelayResultArgs {
  envelope: RelayEnvelope;
  /** Helix's actual answer text (already Slack-formatted). */
  text: string;
  /** the bot token (name-ref resolved by the caller) — no token ⇒ no post, no error */
  token?: string;
}

/**
 * Post Helix's RESULT into the thread the command came from. Thin wrapper over the
 * shared `postReply` transport — config-gated no-op (no token/channel ⇒ null, no
 * network), threads via `envelope.thread_ts`.
 *
 * This is the RETURN leg of the round-trip (G3). It carries a RESULT, not a routing
 * ack — the caller passes Helix's real output.
 */
export async function relayResult(args: RelayResultArgs, deps: PostDeps = {}): Promise<PostResult | null> {
  return postReply(
    { channel: args.envelope.channel, thread_ts: args.envelope.thread_ts, text: args.text, token: args.token },
    deps,
  );
}
