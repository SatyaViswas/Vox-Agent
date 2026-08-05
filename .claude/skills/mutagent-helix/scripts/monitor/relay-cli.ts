/**
 * scripts/monitor/relay-cli.ts — the Monitor Agent's queue tool (Slack control plane · CP-4).
 * ═══════════════════════════════════════════════════════════════════════════════
 * The Monitor Agent runs INSIDE the Helix session that armed `*monitor`. It has Bash +
 * SendMessage but no direct socket. This CLI is how it drains the durable queue:
 *
 *   1. `read-inbox  --session <sid> --cursor <N>`  → { records:[…fresh inbound…], cursor:N' }
 *        The agent SendMessages each record's rawText to Helix (Helix interprets + conducts),
 *        then remembers the returned cursor so the next read is exactly-once.
 *   2. (Helix conducts the stage — the warm session, NOT this CLI.)
 *   3. `write-outbox --session <sid> --in-reply-to <id> --thread <tt> --text <…>`
 *        → appends Helix's REAL result; the daemon drains outbox.jsonl → the Slack thread.
 *   4. `thread --session <sid> --thread <tt>`  → the transcript, for "respond if relevant".
 *
 * ROUTING OWNERSHIP still holds (PR-ORCH-01): this CLI moves bytes; it NEVER interprets a
 * command or picks a stage. Helix does that between steps 1 and 3.
 *
 * Run:  bun run scripts/monitor/relay-cli.ts <subcommand> [--flags]
 *       (MONITOR_ROOT overrides the default `.mutagent/monitor` root.)
 */
import { SessionStore, makeOutboundRecord, makeThreadTurn } from "./session-store.ts";

/** Minimal `--flag value` parser (no deps). Returns a plain record of the flags seen. */
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== undefined && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
    }
  }
  return out;
}

function storeFor(flags: Record<string, string>): SessionStore {
  const session = flags.session;
  if (session === undefined || session.length === 0) throw new Error("relay-cli: --session <id> is required");
  return new SessionStore(process.env.MONITOR_ROOT ?? ".mutagent/monitor", session);
}

/** Execute one subcommand; returns the string to print (JSON for reads, a status for writes). */
export function runRelayCommand(sub: string, flags: Record<string, string>): string {
  const store = storeFor(flags);
  switch (sub) {
    case "read-inbox": {
      const cursor = Number.parseInt(flags.cursor ?? "0", 10) || 0;
      return JSON.stringify(store.readInboxSince(cursor));
    }
    case "write-outbox": {
      if (flags.thread === undefined || flags.text === undefined) throw new Error("write-outbox needs --thread and --text");
      store.appendOutbound(
        makeOutboundRecord({
          id: `${flags.thread}-${Date.now()}`,
          in_reply_to: flags["in-reply-to"] ?? "",
          thread_ts: flags.thread,
          text: flags.text,
          kind: (flags.kind as "ack" | "reply" | "status") ?? "reply",
        }),
      );
      store.appendThreadTurn(flags.thread, makeThreadTurn("helix", { ts: `${Date.now()}`, text: flags.text }));
      return "ok";
    }
    case "thread": {
      if (flags.thread === undefined) throw new Error("thread needs --thread");
      return JSON.stringify(store.thread(flags.thread));
    }
    case "header":
      return JSON.stringify(store.header());
    default:
      throw new Error(`relay-cli: unknown subcommand "${sub}" (read-inbox | write-outbox | thread | header)`);
  }
}

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === undefined) throw new Error("relay-cli: a subcommand is required (read-inbox | write-outbox | thread | header)");
  console.info(runRelayCommand(sub, parseFlags(rest)));
}
