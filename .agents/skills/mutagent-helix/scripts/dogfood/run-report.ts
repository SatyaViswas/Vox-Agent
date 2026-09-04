#!/usr/bin/env bun
/**
 * scripts/dogfood/run-report.ts — the *dogfood report runner.
 *
 * Composes the pure dogfood functions (parse → reconstruct → extract → render) into a written
 * HTML "Live Status" report. The `dogfood-monitor` agent shells out to this; `*dogfood` is ALWAYS
 * a live monitor (DOG-0): the watch loop is the DEFAULT (re-render on the session file changing OR
 * every `--interval` seconds — default 180 = 3 min, matching the monitor cadence). Pass `--once`
 * for a single render + exit (internal/test only, NOT the operator path).
 *
 * When `config.dogfood.slack.enabled` (DOG-3), each render also drives a LIVE Slack THREAD: a root
 * message on start + typed threaded replies derived by diffing successive trajectories. Slack is a
 * strictly-optional sink — unconfigured/disabled ⇒ HTML report only, never an error.
 *
 * Usage:
 *   run-report.ts --session <id> --source-dir <dir> [--out <path>]
 *                 [--refresh <sec=180>] [--include-subagents] [--interval <sec=180>] [--once]
 */
import { reconstructTrajectory, parseSessionFile } from "./reconstruct-trajectory.ts";
import { extractFeedback } from "./extract-feedback.ts";
import { renderDogfoodReport } from "./render-dogfood-report.ts";
import { resolveSubagentPaths } from "./resolve-subagents.ts";
import { dogfoodThreadMessages } from "./slack-thread.ts";
import type { DogfoodEvent, DogfoodThreadMeta } from "./slack-thread.ts";
import type { FeedbackItem, Trajectory } from "./types.ts";
import { postMessage, postReply } from "../slack/post.ts";
import { writeFileSync, mkdirSync, statSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { setInterval } from "node:timers";

/** Options for a single report build. I/O reads happen here; `now` is INJECTED (testable). */
export interface BuildReportOpts {
  /** The main session JSONL path (explicit — the CLI derives it from session+source-dir). */
  mainPath: string;
  sessionId: string;
  sourceDir?: string;
  /** Dispatched subagent session JSONL paths (empty ⇒ none). */
  subagentPaths?: string[];
  /** Injected wall-clock (epoch ms) — the report's "as of" time. */
  now: number;
  /** Browser auto-reload cadence in seconds (0/undefined ⇒ static, no auto-reload). */
  refreshSeconds?: number;
  title?: string;
}

export interface BuildReportResult {
  html: string;
  stats: { commands: number; feedback: number; subagents: number };
  /** The reconstructed trajectory (exposed so the watch loop can diff for DOG-3). */
  trajectory: Trajectory;
  /** The extracted feedback items (exposed for the same diff). */
  feedback: FeedbackItem[];
}

/** Compose the pure pipeline into an HTML string + counts + structured outputs. Reads the session file(s). */
export async function buildReport(opts: BuildReportOpts): Promise<BuildReportResult> {
  const main = await parseSessionFile(opts.mainPath);
  if (main === null) {
    throw new Error(`run-report: no recognizable events in ${opts.mainPath}`);
  }
  const subagentPaths = opts.subagentPaths ?? [];
  const trajectory = await reconstructTrajectory({ mainPath: opts.mainPath, subagentPaths, now: opts.now });
  const feedback = extractFeedback(main);
  const html = renderDogfoodReport({
    trajectory,
    feedback,
    meta: {
      runId: `dogfood-${opts.now}`,
      sessionId: opts.sessionId,
      sourceDir: opts.sourceDir,
      generatedAt: new Date(opts.now).toISOString(),
      title: opts.title ?? "Helix Dogfood — Live Status",
      subagentCount: subagentPaths.length,
      refreshSeconds: opts.refreshSeconds && opts.refreshSeconds > 0 ? opts.refreshSeconds : undefined,
    },
  });
  return {
    html,
    stats: { commands: trajectory.commands.length, feedback: feedback.length, subagents: subagentPaths.length },
    trajectory,
    feedback,
  };
}

// ── DOG-0: watch decision (pure, unit-testable — no loop spawned) ─────────────

/**
 * `*dogfood` is ALWAYS a live monitor. Watch is the DEFAULT; the ONLY opt-out is
 * an explicit `--once` (a single render + exit — internal/test use only, never
 * the operator path). Pure over argv so it is testable WITHOUT arming the loop.
 */
export function shouldWatch(argv: string[]): boolean {
  return !argv.includes("--once");
}

// ── DOG-3: successive-trajectory diff → live-thread events (pure) ─────────────

/** A render snapshot the watch loop diffs between ticks. */
export interface DogfoodSnapshot {
  trajectory: Trajectory;
  feedback: FeedbackItem[];
}

/** Stable identity for a feedback item (order-independent diffing). */
function feedbackKey(f: FeedbackItem): string {
  return `${f.kind}:${f.evidencePointer.spanId}:${f.evidencePointer.turnIndex}`;
}

/**
 * Derive the NEW live-thread events between two render snapshots. PURE +
 * deterministic. Emits: stage-change (new timeline segment with a stage flip),
 * agent-dispatch (a subagent unseen in `prev`), feedback (a new `feedback-block`),
 * and signal (a new implicit signal). `prev` undefined ⇒ the first render (no
 * replies — the ROOT is posted separately from meta).
 */
export function diffDogfoodEvents(prev: DogfoodSnapshot | undefined, next: DogfoodSnapshot): DogfoodEvent[] {
  if (prev === undefined) return [];
  const events: DogfoodEvent[] = [];

  // stage-change — new timeline segments (append-only) with an actual stage flip
  const tl = next.trajectory.timeline;
  for (let i = prev.trajectory.timeline.length; i < tl.length; i++) {
    const to = tl[i].stage;
    const from = i > 0 ? tl[i - 1].stage : undefined;
    if (from !== to) events.push(from ? { type: "stage-change", to, from } : { type: "stage-change", to });
  }

  // agent-dispatch — subagents unseen in prev (by sessionId)
  const prevSubs = new Set(prev.trajectory.subagents.map((s) => s.sessionId));
  for (const s of next.trajectory.subagents) {
    if (!prevSubs.has(s.sessionId)) events.push({ type: "agent-dispatch", agent: s.agentName });
  }

  // feedback / signal — items whose identity is new
  const prevKeys = new Set(prev.feedback.map(feedbackKey));
  for (const f of next.feedback) {
    if (prevKeys.has(feedbackKey(f))) continue;
    if (f.kind === "feedback-block") events.push({ type: "feedback", text: f.observation, severity: f.severity });
    else events.push({ type: "signal", kind: f.kind, count: 1 });
  }

  return events;
}

// ── CLI (impure boundary: argv · clock · fs · watch · Slack post) ─────────────
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** The resolved dogfood Slack sink (config-gated). null ⇒ no Slack this run. */
interface SlackSink {
  channel: string;
  token: string;
  cadenceLabel: string;
}

/**
 * Resolve the Slack sink from `config.dogfood.slack` (DOG-3). Active ONLY when
 * enabled AND the `token_ref` env var is set. Guarded (never throws): any miss ⇒
 * null ⇒ HTML report only. The config module is imported LAZILY so the render
 * path never hard-depends on it (a consumer install without deps still renders;
 * Slack simply no-ops).
 */
async function resolveSlackSink(): Promise<SlackSink | null> {
  try {
    const { loadConfig } = await import("../config-schema.ts");
    const { resolveConfigPath } = await import("../resolve-paths.ts");
    const res = loadConfig(resolveConfigPath());
    if (!res.ok) return null;
    const slack = res.config.dogfood?.slack;
    if (slack === undefined || slack.enabled !== true) return null;
    const token = process.env[slack.token_ref];
    if (token === undefined || token.length === 0) return null;
    const cadence = res.config.dogfood?.cadence_seconds ?? 180;
    return { channel: slack.channel, token, cadenceLabel: `${Math.max(1, Math.round(cadence / 60))}m` };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sessionId = arg("session");
  const sourceDir = arg("source-dir");
  if (sessionId === undefined || sourceDir === undefined) {
    console.error("run-report: --session <id> and --source-dir <dir> are required");
    process.exit(2);
  }
  const mainPath = join(sourceDir, `${sessionId}.jsonl`);
  const outPath = arg("out", join(process.cwd(), ".mutagent", "dogfood", `${sessionId}.html`))!;
  const refreshSeconds = Number(arg("refresh", "180"));
  const intervalMs = Number(arg("interval", "180")) * 1000;

  // DOG-2: resolve dispatched subagent JSONLs by parent→child linkage (gated by
  // --include-subagents, which the monitor passes when config.include_subagents).
  const resolveSubs = (): string[] =>
    flag("include-subagents") ? resolveSubagentPaths({ sourceDir, sessionId, includeSubagents: true }) : [];

  // DOG-3: Slack live-thread state (config-gated; null ⇒ no Slack).
  const slack = await resolveSlackSink();
  let threadTs: string | null = null;
  let prevSnap: DogfoodSnapshot | undefined;

  const postThread = async (result: BuildReportResult): Promise<void> => {
    if (slack === null) return;
    const nextSnap: DogfoodSnapshot = { trajectory: result.trajectory, feedback: result.feedback };
    if (threadTs === null) {
      // First render: open the thread with the ROOT (from meta); baseline the diff.
      const meta: DogfoodThreadMeta = { sessionId, project: sourceDir, cadenceLabel: slack.cadenceLabel };
      const root = dogfoodThreadMessages([], meta)[0];
      const res = await postMessage({ channel: slack.channel, text: root.text, token: slack.token });
      threadTs = res?.ts ?? null;
    } else {
      // Subsequent renders: post one threaded reply per NEW event.
      const events = diffDogfoodEvents(prevSnap, nextSnap);
      for (const msg of dogfoodThreadMessages(events, { sessionId }).filter((m) => m.kind === "reply")) {
        await postReply({ channel: slack.channel, thread_ts: threadTs, text: msg.text, token: slack.token });
      }
    }
    prevSnap = nextSnap;
  };

  const renderOnce = async (reason: string): Promise<void> => {
    try {
      const result = await buildReport({
        mainPath, sessionId, sourceDir, subagentPaths: resolveSubs(), now: Date.now(), refreshSeconds,
      });
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, result.html);
      const { commands, feedback, subagents } = result.stats;
      console.info(`[dogfood] rendered (${reason}) → ${outPath} · commands=${commands} feedback=${feedback} subagents=${subagents}`);
      await postThread(result);
    } catch (e) {
      console.error(`[dogfood] render error (${reason}): ${(e as Error).message}`);
    }
  };

  await renderOnce("initial");

  // DOG-0: *dogfood is ALWAYS live — watch is the default; --once opts out.
  if (shouldWatch(process.argv)) {
    console.info(`[dogfood] watch ARMED — re-render on drift OR every ${intervalMs / 1000}s`);
    setInterval(() => void renderOnce("heartbeat"), intervalMs);
    let lastMtime = 0;
    try {
      watch(mainPath, { persistent: true }, () => {
        const m = statSync(mainPath).mtimeMs;
        if (m !== lastMtime) {
          lastMtime = m;
          void renderOnce("drift");
        }
      });
    } catch (e) {
      console.error(`[dogfood] cannot watch ${mainPath} for drift: ${(e as Error).message}`);
    }
  }
}

if (import.meta.main) {
  await main();
}
