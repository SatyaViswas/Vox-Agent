// ---------------------------------------------------------------------------
// monitor/triggers — the External Monitor's PURE rule engine (EXT-1).
//
// `evaluateTriggers(config, event, now)` reads the DORMANT `config.triggers`
// block (the evaluate/diagnose trigger rules) and returns every rule that FIRES
// for an incoming `MonitorEvent`. This is the OUTWARD monitor's condition source
// — distinct from the INWARD dogfood monitor (which observes a live session).
//
// SHIPS DISABLED (load-bearing): a stage block whose `enabled !== true` yields
// ZERO matches. The onboarding default is `enabled:false` with empty rules, so a
// freshly-installed monitor never fires until the operator opts in
// (triggers.<stage>.enabled:true). No cron, no auto-fire wired here — this is the
// pure predicate; arming the watch is the `monitor` agent's job.
//
// PURE + DETERMINISTIC: no clock, no random, no network, no fs. The wall-clock is
// INJECTED as `now` (epoch ms) and stamped onto each match as `firedAt` — same
// (config, event, now) ⇒ deep-equal `TriggerMatch[]`, so the engine is unit-
// testable against inline literals (mirrors scripts/dispatch.ts + config-schema.ts).
//
// SEPARATION: this is the CONDITION half of the External Monitor. The NOTIFICATION
// half is monitor/slack-notify.ts (its OWN Slack voice). Neither imports the
// dogfood monitor's engine — shared transport, separate semantics (ADR-6/ADR-11).
// ---------------------------------------------------------------------------

import { AdlStage } from "../handover-contract.ts";
import type { AdlStageValue } from "../handover-contract.ts";
import type { MutagentConfig, TriggerRule, TriggerStageBlock } from "../config-schema.ts";

/** The event kinds the External Monitor understands. Closed → exhaustive. */
export type MonitorEventKind = "trace-count" | "schedule" | "ci" | "manual";

/**
 * An incoming monitor event. Discriminated on `kind`. The scheduler / trace
 * collector / CI hook constructs one of these and hands it to `evaluateTriggers`.
 */
export type MonitorEvent =
  | { kind: "trace-count"; count: number }
  | { kind: "schedule"; at?: string }
  | { kind: "ci"; status?: string }
  | { kind: "manual"; command?: string };

/**
 * One fired trigger — names the rule, the target ADL stage (the `config.triggers`
 * block key, e.g. evaluate/diagnose), a human-readable reason, and the injected
 * `firedAt` stamp (for the notification; NO self-read clock).
 */
export interface TriggerMatch {
  /** The target ADL stage — the `config.triggers` block this rule lives under. */
  stage: AdlStageValue;
  /** The rule that fired (its `on` condition + optional `run` target). */
  rule: TriggerRule;
  /** Convenience mirror of `rule.run` (the stage/command to run) when present. */
  run?: string;
  /** Human-readable WHY the rule fired (precise: the matched condition). */
  reason: string;
  /** The injected wall-clock (epoch ms) — the "fired at" stamp, never self-read. */
  firedAt: number;
}

/**
 * The `config.triggers` keys are the routing AdlStage set MINUS `spec` (there is
 * no spec monitor). A fixed iteration order keeps the output deterministic.
 */
type TriggerStageKey = Exclude<AdlStageValue, typeof AdlStage.Spec>;
const STAGE_ORDER: readonly TriggerStageKey[] = [
  AdlStage.Build,
  AdlStage.Evaluate,
  AdlStage.Diagnose,
  AdlStage.Optimize,
  AdlStage.Audit,
  // ⑥ SHIP (#1202) — ships DISABLED like the rest; the always-on triggers.ship
  // monitor is FUTURE (ship PRD KP-6). Present here so an (enabled) ship block is
  // still evaluated deterministically; INV-SHIP-1 refusal lives at the router.
  AdlStage.Ship,
];

/** Parsed `on` grammar: an event kind + an OPTIONAL numeric threshold (trace-count). */
interface ParsedOn {
  kind: MonitorEventKind | null;
  op: ">=" | ">" | null;
  threshold: number | null;
}

/**
 * Parse a rule's `on` string. Grammar (deterministic, minimal — ADR-10):
 *   - `trace-count`            → fires on ANY trace-count event
 *   - `trace-count>=100`       → fires when count ≥ 100
 *   - `trace-count>100`        → fires when count > 100
 *   - `schedule` · `ci` · `manual` → fires on the matching event kind
 * Anything else ⇒ `kind:null` (an unparseable rule never fires).
 */
function parseOn(on: string): ParsedOn {
  const m = on
    .trim()
    .toLowerCase()
    .match(/^(trace-count|schedule|ci|manual)\s*(>=|>)?\s*(\d+)?$/);
  if (m === null) return { kind: null, op: null, threshold: null };
  return {
    kind: m[1] as MonitorEventKind,
    op: (m[2] as ">=" | ">" | undefined) ?? null,
    threshold: m[3] !== undefined ? Number(m[3]) : null,
  };
}

/**
 * Does `rule` fire for `event`? Returns a human-readable reason string when it
 * does, else null. Pure. The `on` kind must equal the event kind; a `trace-count`
 * rule with a threshold additionally requires the count to satisfy the comparator.
 */
function ruleReason(rule: TriggerRule, event: MonitorEvent): string | null {
  const p = parseOn(rule.on);
  if (p.kind === null || p.kind !== event.kind) return null;

  switch (event.kind) {
    case "trace-count": {
      if (p.threshold !== null) {
        const op = p.op ?? ">=";
        const ok = op === ">" ? event.count > p.threshold : event.count >= p.threshold;
        if (!ok) return null;
        return `trace-count ${event.count} ${op} ${p.threshold}`;
      }
      return `trace-count ${event.count}`;
    }
    case "schedule":
      return event.at !== undefined ? `schedule fired @ ${event.at}` : "schedule fired";
    case "ci":
      return event.status !== undefined ? `ci ${event.status}` : "ci event";
    case "manual":
      return event.command !== undefined ? `manual trigger (${event.command})` : "manual trigger";
  }
}

/**
 * Evaluate the DORMANT `config.triggers` against an incoming event → every fired
 * rule as a `TriggerMatch`. DISABLED-by-default: a stage block with
 * `enabled !== true` (the shipped default) contributes NOTHING, so a fresh
 * monitor never fires until explicitly enabled. Deterministic: stages iterate in
 * a fixed order, `now` is injected (no self-read clock).
 */
export function evaluateTriggers(
  config: MutagentConfig,
  event: MonitorEvent,
  now: number,
): TriggerMatch[] {
  const triggers = config.triggers;
  if (triggers === undefined) return [];

  const matches: TriggerMatch[] = [];
  for (const stage of STAGE_ORDER) {
    const block = triggers[stage] as TriggerStageBlock | undefined;
    // SHIPS DISABLED — only an explicitly-enabled block can fire.
    if (block === undefined || block.enabled !== true) continue;
    for (const rule of block.rules) {
      const reason = ruleReason(rule, event);
      if (reason === null) continue;
      matches.push({
        stage,
        rule,
        ...(rule.run !== undefined ? { run: rule.run } : {}),
        reason,
        firedAt: now,
      });
    }
  }
  return matches;
}
