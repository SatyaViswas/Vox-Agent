/**
 * scripts/monitor/session-store.ts — the durable inbox/outbox + per-thread transcript store
 * for the Slack control plane (Slack #1111 · monitoring-prd CP-1/CP-4 · ADR-21).
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT: the queue substrate that lets a Slack conversation survive across daemon
 * reconnects and Helix-session restarts, and lets the Monitor Agent relay inbound
 * commands to Helix exactly-once. Zero deps — native `node:fs` + JSONL, the same
 * pattern proven live in `mutagent-labs` (.mutagent/slack-inbox.jsonl +
 * slack-threads/<thread_ts>.jsonl) and in the `helix-monitor` reference (cursor +
 * dedup). This adds what neither had: a SESSION-ID namespace + a session header as
 * the FIRST jsonl line (Claude-Code-transcript style) + a mtime-diff prune.
 *
 * LAYOUT (session-id = the *monitor runId = the Helix session that armed the monitor):
 *   .mutagent/monitor/<session-id>/
 *     inbox.jsonl              line 1 = { type:"session", … } · then inbound records (daemon → Helix)
 *     outbox.jsonl             outbound records (Helix → daemon → Slack)
 *     threads/<thread_ts>.jsonl   per-thread transcript (role: asker | helix), like labs
 *
 * OWNERSHIP (answers "only the session that started monitor responds"): the Monitor
 * Agent runs INSIDE the Helix session that issued *monitor and owns exactly its
 * <session-id> dir. A different session gets a different id and never touches it.
 *
 * The pure record builders / codec / cursor / prune-selection are exported and
 * fully unit-tested; the fs seam is injectable (`StoreFs`) so tests need no disk.
 */
import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

// ── record shapes (each JSONL line is one of these) ─────────────────────────────

export interface SessionHeader {
  type: "session";
  session_id: string;
  channel?: string;
  created_at: string; // ISO — injected, never Date.now() in a pure builder
}
export interface InboundRecord {
  type: "inbound";
  id: string; // = the triggering message's dedupeKey (channel:thread:ts) — exactly-once key
  ts: string;
  thread_ts: string;
  channel: string;
  user?: string;
  rawText: string; // the operator's command, VERBATIM (Helix interprets — never the store)
}
export interface OutboundRecord {
  type: "outbound";
  id: string; // unique per outbound line
  in_reply_to: string; // the InboundRecord.id this answers (or "" for an unsolicited card)
  thread_ts: string;
  text: string;
  kind: "ack" | "reply" | "status"; // two-touch receipts + Helix's real result
}
/** One turn of a thread's transcript — mirrors mutagent-labs' {role,user,text}. */
export interface ThreadTurn {
  ts: string;
  role: "asker" | "helix";
  user?: string;
  text: string;
}

// ── PURE builders ───────────────────────────────────────────────────────────────

export function makeSessionHeader(sessionId: string, createdAtIso: string, channel?: string): SessionHeader {
  return { type: "session", session_id: sessionId, created_at: createdAtIso, ...(channel ? { channel } : {}) };
}

/** Inbound event → an InboundRecord. Carries the raw text only — NO stage / NO command. */
export function makeInboundRecord(e: {
  dedupeKey: string;
  ts: string;
  thread_ts: string;
  channel: string;
  user?: string;
  rawText: string;
}): InboundRecord {
  return {
    type: "inbound",
    id: e.dedupeKey,
    ts: e.ts,
    thread_ts: e.thread_ts,
    channel: e.channel,
    ...(e.user ? { user: e.user } : {}),
    rawText: e.rawText,
  };
}

export function makeOutboundRecord(o: {
  id: string;
  in_reply_to: string;
  thread_ts: string;
  text: string;
  kind: OutboundRecord["kind"];
}): OutboundRecord {
  return { type: "outbound", id: o.id, in_reply_to: o.in_reply_to, thread_ts: o.thread_ts, text: o.text, kind: o.kind };
}

export function makeThreadTurn(role: ThreadTurn["role"], t: { ts: string; user?: string; text: string }): ThreadTurn {
  return { ts: t.ts, role, ...(t.user ? { user: t.user } : {}), text: t.text };
}

// ── PURE codec + cursor + prune-selection (the testable core) ────────────────────

/** One object → one JSONL line (trailing newline). */
export function encodeLine(rec: unknown): string {
  return JSON.stringify(rec) + "\n";
}

/** JSONL text → parsed records. Blank lines skipped; a malformed line throws (fail-loud). */
export function decodeJsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

/**
 * Exactly-once cursor over an append-only record list — the reference's cursor-store
 * pattern, minimized to an offset int. `cursor` = number already consumed; returns the
 * fresh tail + the next cursor. Used for BOTH queues: the Monitor Agent drains the inbox,
 * the daemon drains the outbox.
 */
export function sliceNew<T>(items: T[], cursor: number): { records: T[]; cursor: number } {
  const start = Math.max(0, Math.trunc(cursor));
  return { records: items.slice(start), cursor: items.length };
}

/** Inbound cursor (header at index 0 already excluded by `inbound()`). */
export function readNewSince(inbound: InboundRecord[], cursor: number): { records: InboundRecord[]; cursor: number } {
  return sliceNew(inbound, cursor);
}

/** Drop records whose id is already in `seen` (dedup guard on top of the cursor). */
export function dedupeById<T extends { id: string }>(records: T[], seen: ReadonlySet<string>): T[] {
  return records.filter((r) => !seen.has(r.id));
}

/**
 * The EFFICIENT-DIFF prune selection (operator: "clean up inboxes older than 2 days …
 * use an efficient diff mechanism"). Decides purely from directory mtimes — a `stat`
 * per session dir, NO content read — which session-id dirs are stale. O(#sessions).
 */
export function selectStaleSessions(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
  nowMs: number,
  maxAgeDays: number,
): string[] {
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  return entries.filter((e) => e.mtimeMs < cutoff).map((e) => e.name);
}

// ── impure fs seam (injectable) ──────────────────────────────────────────────────

export interface StoreFs {
  exists(p: string): boolean;
  read(p: string): string;
  append(p: string, s: string): void;
  write(p: string, s: string): void;
  mkdirp(p: string): void;
  readdir(p: string): string[];
  mtimeMs(p: string): number;
  rmrf(p: string): void;
}

/** Default fs seam over `node:fs` (sync — JSONL appends are tiny). */
export const nodeFs: StoreFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf8"),
  append: (p, s) => appendFileSync(p, s),
  write: (p, s) => writeFileSync(p, s),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  readdir: (p) => (existsSync(p) ? readdirSync(p) : []),
  mtimeMs: (p) => statSync(p).mtimeMs,
  rmrf: (p) => rmSync(p, { recursive: true, force: true }),
};

// ── the store (thin fs orchestration over the pure core) ─────────────────────────

export class SessionStore {
  readonly dir: string; // .mutagent/monitor/<session-id>
  private readonly threadsDir: string;
  constructor(
    private readonly monitorRoot: string, // …/.mutagent/monitor
    readonly sessionId: string,
    private readonly fs: StoreFs = nodeFs,
  ) {
    this.dir = join(monitorRoot, sessionId);
    this.threadsDir = join(this.dir, "threads");
  }

  private get inboxPath(): string {
    return join(this.dir, "inbox.jsonl");
  }
  private get outboxPath(): string {
    return join(this.dir, "outbox.jsonl");
  }

  /** Create the session dir + write the session header as line 1 (idempotent). */
  init(createdAtIso: string, channel?: string): void {
    this.fs.mkdirp(this.threadsDir);
    if (!this.fs.exists(this.inboxPath)) {
      this.fs.write(this.inboxPath, encodeLine(makeSessionHeader(this.sessionId, createdAtIso, channel)));
    }
  }

  appendInbound(rec: InboundRecord): void {
    this.fs.append(this.inboxPath, encodeLine(rec));
  }
  appendOutbound(rec: OutboundRecord): void {
    this.fs.append(this.outboxPath, encodeLine(rec));
  }
  appendThreadTurn(threadTs: string, turn: ThreadTurn): void {
    this.fs.mkdirp(this.threadsDir);
    this.fs.append(join(this.threadsDir, `${threadTs}.jsonl`), encodeLine(turn));
  }

  /** The session header (line 1), or null if the inbox is absent. */
  header(): SessionHeader | null {
    if (!this.fs.exists(this.inboxPath)) return null;
    const recs = decodeJsonl(this.fs.read(this.inboxPath));
    const h = recs[0] as SessionHeader | undefined;
    return h && h.type === "session" ? h : null;
  }

  /** All inbound records (header excluded) — the Monitor Agent's queue. */
  inbound(): InboundRecord[] {
    if (!this.fs.exists(this.inboxPath)) return [];
    return decodeJsonl(this.fs.read(this.inboxPath)).filter(
      (r): r is InboundRecord => (r as { type?: string }).type === "inbound",
    );
  }

  /** Read the fresh inbound tail past `cursor` (exactly-once); returns tail + next cursor. */
  readInboxSince(cursor: number): { records: InboundRecord[]; cursor: number } {
    return readNewSince(this.inbound(), cursor);
  }

  /** All outbound records (Helix → daemon → Slack). */
  outbound(): OutboundRecord[] {
    if (!this.fs.exists(this.outboxPath)) return [];
    return decodeJsonl(this.fs.read(this.outboxPath)).filter(
      (r): r is OutboundRecord => (r as { type?: string }).type === "outbound",
    );
  }

  /** Read the fresh outbound tail past `cursor` — the daemon's drain (exactly-once). */
  readOutboxSince(cursor: number): { records: OutboundRecord[]; cursor: number } {
    return sliceNew(this.outbound(), cursor);
  }

  /** The full transcript of one thread (for "respond to follow-ups if relevant" context). */
  thread(threadTs: string): ThreadTurn[] {
    const p = join(this.threadsDir, `${threadTs}.jsonl`);
    if (!this.fs.exists(p)) return [];
    return decodeJsonl(this.fs.read(p)) as ThreadTurn[];
  }

  /**
   * Prune sibling session dirs older than `maxAgeDays`, using the mtime diff (no content
   * read). Skips THIS session. Returns the removed session-ids. Cheap enough to call on
   * every inbox change (operator: "while it detects changes").
   */
  prune(nowMs: number, maxAgeDays = 2): string[] {
    const names = this.fs.readdir(this.monitorRoot).filter((n) => n !== this.sessionId);
    const entries = names
      .map((name) => {
        try {
          return { name, mtimeMs: this.fs.mtimeMs(join(this.monitorRoot, name)) };
        } catch {
          return null;
        }
      })
      .filter((e): e is { name: string; mtimeMs: number } => e !== null);
    const stale = selectStaleSessions(entries, nowMs, maxAgeDays);
    for (const name of stale) this.fs.rmrf(join(this.monitorRoot, name));
    return stale;
  }
}
