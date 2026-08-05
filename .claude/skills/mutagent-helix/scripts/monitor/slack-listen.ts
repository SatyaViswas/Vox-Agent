/**
 * scripts/monitor/slack-listen.ts — the LIVE inbound Slack listener (Slack control plane, increment 2).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Completes the round-trip #1111: an operator @-mentions Helix in a channel and gets
 * a reply IN THE THREAD. This is the LIVE FEED that increment 1's relay contract was
 * waiting for.
 *
 * TRUNK-NATIVE, ZERO scratch dependency, ZERO npm dependency: Slack "Socket Mode" is
 * just `apps.connections.open` (→ a `wss://` URL) + a WebSocket. Bun ships WebSocket
 * natively, so we open the connection ourselves — no `@slack/socket-mode`.
 *
 * ROUTING OWNERSHIP (PR-ORCH-01) still holds: the listener parses the RAW text
 * (parseInboundCommand) and asks Helix's route table (lookupRoute) which command it
 * is — it never invents a command. This first live cut CONFIRMS THE ROUTE + replies;
 * CONDUCTING the routed stage (the full Model-B cell) is the next layer.
 *
 * Run:  SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… \
 *       bun run scripts/monitor/slack-listen.ts --channel C0BEXEP65K3
 */
import { lookupRoute, type RouteEntry } from "../dispatch.ts";
import { parseInboundCommand, relayResult, type RelayEnvelope } from "../slack/relay.ts";
import { SessionStore, makeInboundRecord, makeOutboundRecord, makeThreadTurn } from "./session-store.ts";

// ── PURE: route a raw utterance → a reply (the testable core) ──────────────────

export interface RouteReply {
  reply: string;
  routed: boolean;
  command?: string;
  stage?: string;
}

/** The first whitespace-delimited token of the utterance (the candidate command). */
function firstToken(rawText: string): string {
  return rawText.trim().split(/\s+/)[0] ?? "";
}

/**
 * Decide the reply for a raw utterance using Helix's OWN route table. This does NOT
 * conduct the stage — it confirms routing + answers in-thread (the live-round-trip
 * proof). NL utterances that aren't an explicit command get a Helix greeting; the
 * LLM intent-router + stage-conducting are the next layer.
 */
export function routeAndReply(rawText: string, lookup: (cmd: string) => RouteEntry | undefined = lookupRoute): RouteReply {
  const tok = firstToken(rawText);
  const entry = tok.length > 0 ? lookup(tok) : undefined;
  if (entry !== undefined) {
    const cmd = tok.startsWith("*") ? tok : `*${tok}`;
    const stage = entry.adl_stage ?? "local";
    const target = entry.route_target !== undefined ? ` → *${entry.route_target}*` : "";
    return {
      reply:
        `:compass: *Routing works.* \`${cmd}\` resolves to stage *${stage}*${target}.\n` +
        `_(This confirms the Slack round-trip: your message reached Helix, was routed, and replied in-thread. Conducting the stage is the next layer.)_`,
      routed: true,
      command: cmd,
      stage,
    };
  }
  return {
    reply:
      `:wave: *Hi — I'm Helix, and the Slack round-trip is live.* I received your message and replied right here in the thread.\n` +
      `I didn't spot a command in "${rawText}". Try an explicit one — \`*status\`, \`*diagnose <agent>\`, \`*evaluate <agent>\` — and I'll show you it routes. _(Natural-language routing is the next layer.)_`,
    routed: false,
  };
}

// ── IMPURE: the Socket-Mode listener shell (native WebSocket, no npm dep) ───────

interface ListenerConfig {
  appToken: string; // xapp-… (Socket Mode)
  botToken: string; // xoxb-… (chat.postMessage)
  channel?: string; // if set, only answer mentions in this channel
  store?: SessionStore; // if set, persist inbound/outbound + per-thread transcript (durable spine)
  relay?: boolean; // RELAY mode: defer the real reply to Helix via the outbox (CP-3/CP-4)
}

/** Touch-1 receipt posted immediately in relay mode while Helix conducts the stage. */
const ACK_TEXT = ":eyes: _Got it — handing this to Helix. I'll post the result here as it comes._";

/** Open a Socket-Mode connection and return its `wss://` URL. */
async function openSocketModeUrl(appToken: string): Promise<string> {
  const res = await globalThis.fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!body.ok || body.url === undefined) throw new Error(`apps.connections.open failed: ${body.error ?? "unknown"}`);
  return body.url;
}

/** bounded dedupe — one reply per triggering message. */
function makeSeen(cap = 2000): (key: string) => boolean {
  const seen = new Set<string>();
  return (key: string) => {
    if (seen.has(key)) return false;
    if (seen.size >= cap) seen.clear();
    seen.add(key);
    return true;
  };
}

/**
 * Decide whether an inbound event is FOR HELIX (PURE, testable). The rule that makes
 * threads usable: once Helix is in a thread, follow-ups there need NO re-mention.
 *   - bot's own / edited / system message → ignore.
 *   - an @-mention (anywhere) → handle, and the thread becomes "active".
 *   - a reply in a thread Helix is already in (thread_ts ∈ activeThreads) → handle
 *     as a follow-up, mention NOT required. This is where the conversation happens.
 *   - anything else (a top-level line, or a reply in a thread Helix isn't in) → ignore,
 *     so two people chatting in the channel don't trigger a reply.
 *
 * NOTE (next layer): within an ACTIVE thread this treats every follow-up as directed
 * at Helix. Telling "actually meant for Helix" apart from two humans side-chatting in
 * the same thread needs the LLM "is this addressed to me?" classifier — not here yet.
 */
export type InboundReason = "mention" | "thread-follow-up" | "ignored-bot-or-system" | "ignored-not-for-us";
export function classifyInbound(ev: Record<string, unknown>, activeThreads: ReadonlySet<string>): { handle: boolean; reason: InboundReason } {
  if (typeof ev.bot_id === "string" || ev.subtype !== undefined) return { handle: false, reason: "ignored-bot-or-system" };
  if (ev.type !== "app_mention" && ev.type !== "message") return { handle: false, reason: "ignored-bot-or-system" };
  const isMention = ev.type === "app_mention" || (typeof ev.text === "string" && /<@[^>]+>/.test(ev.text));
  if (isMention) return { handle: true, reason: "mention" };
  const threadTs = typeof ev.thread_ts === "string" ? ev.thread_ts : "";
  if (threadTs.length > 0 && activeThreads.has(threadTs)) return { handle: true, reason: "thread-follow-up" };
  return { handle: false, reason: "ignored-not-for-us" };
}

/** Handle one inbound Slack event: classify → parse → route → reply in-thread. */
async function handleEvent(
  ev: Record<string, unknown>,
  cfg: ListenerConfig,
  fresh: (k: string) => boolean,
  activeThreads: Set<string>,
): Promise<void> {
  const decision = classifyInbound(ev, activeThreads);
  if (!decision.handle) return;
  const envelope: RelayEnvelope | null = parseInboundCommand(ev as never);
  if (envelope === null) return;
  if (cfg.channel !== undefined && envelope.channel !== cfg.channel) return;
  if (!fresh(envelope.dedupeKey)) return;
  // Register/refresh the thread so later follow-ups need no re-mention. Bounded.
  if (activeThreads.size >= 4000) activeThreads.clear();
  activeThreads.add(envelope.thread_ts);
  // Durable spine: record the inbound message + asker turn BEFORE replying, so a
  // Helix session (or a restart) can pick the conversation up from disk exactly-once.
  if (cfg.store !== undefined) {
    cfg.store.appendInbound(makeInboundRecord(envelope));
    cfg.store.appendThreadTurn(
      envelope.thread_ts,
      makeThreadTurn("asker", { ts: envelope.ts, ...(envelope.user ? { user: envelope.user } : {}), text: envelope.rawText }),
    );
  }
  if (cfg.relay === true) {
    // RELAY MODE (CP-3/CP-4): the daemon does NOT answer. The inbound is on inbox.jsonl;
    // the Monitor Agent relays it to Helix, Helix CONDUCTS the stage and writes the real
    // result to outbox.jsonl, and the outbox-drain (below) posts it. We post touch-1 only.
    await relayResult({ envelope, text: ACK_TEXT, token: cfg.botToken });
    cfg.store?.prune(Date.now(), 2);
    console.info(`[slack-listen] ${decision.reason} ${envelope.dedupeKey} → inbox (relay) · acked`);
    return;
  }
  // STANDALONE MODE: the daemon route-confirms itself (the round-trip prover).
  const { reply } = routeAndReply(envelope.rawText);
  await relayResult({ envelope, text: reply, token: cfg.botToken });
  if (cfg.store !== undefined) {
    cfg.store.appendOutbound(
      makeOutboundRecord({ id: `${envelope.ts}-out`, in_reply_to: envelope.dedupeKey, thread_ts: envelope.thread_ts, text: reply, kind: "reply" }),
    );
    cfg.store.appendThreadTurn(envelope.thread_ts, makeThreadTurn("helix", { ts: envelope.ts, text: reply }));
    cfg.store.prune(Date.now(), 2); // clean sibling sessions >2 days old (efficient mtime diff)
  }
  console.info(`[slack-listen] ${decision.reason} ${envelope.dedupeKey} :: "${envelope.rawText.slice(0, 60)}" → replied`);
}

/**
 * The OUTBOX DRAIN (relay mode): poll outbox.jsonl and post each fresh outbound record
 * (Helix's real result, written by the Monitor Agent via relay-cli) into its thread.
 * Cursor-tracked so each result posts exactly once; starts at the current end so a
 * restart never re-posts history. Returns the interval handle.
 */
function startOutboxDrain(cfg: ListenerConfig): ReturnType<typeof globalThis.setInterval> | undefined {
  if (cfg.store === undefined) return undefined;
  const store = cfg.store;
  let cursor = store.outbound().length; // skip whatever's already there at boot
  const tick = async (): Promise<void> => {
    const { records, cursor: next } = store.readOutboxSince(cursor);
    cursor = next;
    for (const rec of records) {
      await relayResult(
        { envelope: { rawText: "", channel: cfg.channel ?? "", thread_ts: rec.thread_ts, ts: rec.thread_ts, dedupeKey: rec.id }, text: rec.text, token: cfg.botToken },
      );
      console.info(`[slack-listen] outbox → thread ${rec.thread_ts} (${rec.kind})`);
    }
  };
  return globalThis.setInterval(() => void tick(), 1500);
}

/** Connect + listen forever (reconnect on disconnect). */
export async function startListener(cfg: ListenerConfig): Promise<void> {
  if (cfg.appToken.length === 0 || cfg.botToken.length === 0) {
    throw new Error("startListener: SLACK_APP_TOKEN + SLACK_BOT_TOKEN are both required");
  }
  const fresh = makeSeen();
  const activeThreads = new Set<string>(); // threads Helix is in → follow-ups need no re-mention
  if (cfg.relay === true) startOutboxDrain(cfg); // relay mode: post Helix's outbox results into threads
  const connect = async (): Promise<void> => {
    const url = await openSocketModeUrl(cfg.appToken);
    const ws = new globalThis.WebSocket(url);
    ws.addEventListener("open", () => console.info(`[slack-listen] slack:live — connected${cfg.channel ? ` · channel ${cfg.channel}` : ""}`));
    ws.addEventListener("message", (e: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "hello") return;
      if (msg.type === "disconnect") {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      if (msg.type === "events_api") {
        if (typeof msg.envelope_id === "string") ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ACK
        const payload = msg.payload as { event?: Record<string, unknown> } | undefined;
        const event = payload?.event;
        if (event) void handleEvent(event, cfg, fresh, activeThreads);
      }
    });
    ws.addEventListener("close", () => {
      console.info("[slack-listen] disconnected — reconnecting in 2s");
      setTimeout(() => void connect(), 2000);
    });
    ws.addEventListener("error", () => {
      /* the close handler drives the reconnect */
    });
  };
  await connect();
}

// ── CLI entry ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const ch = argv.indexOf("--channel");
  const channel = ch >= 0 ? argv[ch + 1] : process.env.MONITOR_SLACK_CHANNEL;
  // session-id = the *monitor runId (the Helix session that armed the monitor). This dir
  // is what that session OWNS — "only the session that started monitor responds".
  const si = argv.indexOf("--session");
  const sessionId = (si >= 0 ? argv[si + 1] : process.env.MONITOR_SESSION_ID) ?? `sess-${Date.now()}`;
  const store = new SessionStore(process.env.MONITOR_ROOT ?? ".mutagent/monitor", sessionId);
  store.init(new Date().toISOString(), channel);
  const relay = argv.includes("--relay"); // defer the real reply to Helix via the outbox
  console.info(`[slack-listen] session ${sessionId} · store ${store.dir} · mode ${relay ? "relay" : "standalone"}`);
  void startListener({
    appToken: process.env.SLACK_APP_TOKEN ?? "",
    botToken: process.env.SLACK_BOT_TOKEN ?? "",
    channel,
    store,
    relay,
  });
}
