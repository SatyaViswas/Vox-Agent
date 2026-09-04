/**
 * scripts/monitor/event-bus.ts — the monitor's event MULTIPLEXER + notifier (CP-1/CP-6).
 * ═══════════════════════════════════════════════════════════════════════════════
 * "Monitor acts as event multiplexer / notifier in Helix." Multiple sources feed one
 * bus: the Slack socket (inbound commands), the trace-count collector, the scheduler,
 * CI. This bus MERGES their events into one deduped, time-ordered stream and gives each
 * a DISPOSITION:
 *   - a Slack inbound   → INBOX      (the relay loop — Helix conducts, §CP-4)
 *   - a trigger MATCH   → HANDOVER   (route a HandoverBundle to the stage + notify)  [outward]
 *   - no match          → DROP       (a clean no-op — never a fabricated route)
 *
 * The condition half is the EXISTING pure rule engine (triggers.ts `evaluateTriggers`);
 * this bus is the source-multiplexing + dispatch layer on top. The merge / dedupe /
 * disposition core is PURE + fully tested; the sinks (write inbox, emit handover, notify)
 * are injected, so a tick needs no real socket, disk, or Slack.
 *
 * SHIPS DISABLED stays intact: `evaluateTriggers` returns zero matches for a disabled
 * `config.triggers` block, so a non-Slack event with nothing armed always DROPS.
 */
import { evaluateTriggers, type MonitorEvent, type TriggerMatch } from "./triggers.ts";
import type { MutagentConfig } from "../config-schema.ts";

// ── the unified bus event (one shape per source lane) ────────────────────────────

/** A Slack inbound command lane — carries the raw relay envelope fields. */
export interface SlackBusEvent {
  id: string; // dedupe key (= the message dedupeKey)
  source: "slack";
  at: string; // ISO
  inbound: { rawText: string; channel: string; thread_ts: string; user?: string; ts: string; dedupeKey: string };
}
/** A condition-source lane (trace-count · schedule · ci · manual) → the rule engine. */
export interface TriggerBusEvent {
  id: string;
  source: "trace-count" | "schedule" | "ci" | "manual";
  at: string;
  event: MonitorEvent; // handed to evaluateTriggers
}
export type BusEvent = SlackBusEvent | TriggerBusEvent;

// ── PURE: merge · dedupe · disposition ───────────────────────────────────────────

/** Merge per-source batches into ONE stream, ordered by time then id (stable, deterministic). */
export function mergeEvents(batches: ReadonlyArray<ReadonlyArray<BusEvent>>): BusEvent[] {
  return batches
    .flat()
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Drop events whose id is already in `seen` (exactly-once across ticks). */
export function dedupeEvents(events: ReadonlyArray<BusEvent>, seen: ReadonlySet<string>): BusEvent[] {
  const local = new Set(seen);
  const out: BusEvent[] = [];
  for (const e of events) {
    if (!local.has(e.id)) {
      local.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/** What the multiplexer decides to do with one event. */
export type Disposition =
  | { kind: "inbox"; event: SlackBusEvent }
  | { kind: "handover"; event: TriggerBusEvent; matches: TriggerMatch[] }
  | { kind: "drop"; event: BusEvent; reason: string };

/**
 * The multiplexer's per-event routing decision (PURE). Slack inbound → the relay inbox;
 * a condition event → the rule engine (a match → handover + notify, none → drop). Never
 * fabricates a route: a disabled/empty `config.triggers` yields zero matches → drop.
 */
export function disposition(e: BusEvent, config: MutagentConfig, nowMs: number): Disposition {
  if (e.source === "slack") return { kind: "inbox", event: e };
  const matches = evaluateTriggers(config, e.event, nowMs);
  if (matches.length > 0) return { kind: "handover", event: e, matches };
  return { kind: "drop", event: e, reason: `no armed rule matched ${e.event.kind}` };
}

// ── the bus (thin dispatch over the pure core) ───────────────────────────────────

/** Where the bus routes each disposition. Injected so a tick needs no real I/O. */
export interface BusSinks {
  /** A Slack inbound command → the relay inbox (Helix conducts). */
  toInbox(e: SlackBusEvent): void;
  /** A fired trigger → route a HandoverBundle to the stage + post a notification. */
  toHandover(e: TriggerBusEvent, matches: TriggerMatch[]): void;
}

export class EventBus {
  private readonly seen = new Set<string>();
  constructor(
    private readonly config: MutagentConfig,
    private readonly sinks: BusSinks,
  ) {}

  /** One multiplex tick: merge the source batches → dedupe → dispatch each. Returns the dispositions. */
  tick(batches: ReadonlyArray<ReadonlyArray<BusEvent>>, nowMs: number): Disposition[] {
    if (this.seen.size >= 8000) this.seen.clear(); // bound the dedupe memory
    const fresh = dedupeEvents(mergeEvents(batches), this.seen);
    const out: Disposition[] = [];
    for (const e of fresh) {
      this.seen.add(e.id);
      const d = disposition(e, this.config, nowMs);
      if (d.kind === "inbox") this.sinks.toInbox(d.event);
      else if (d.kind === "handover") this.sinks.toHandover(d.event, d.matches);
      out.push(d);
    }
    return out;
  }
}
