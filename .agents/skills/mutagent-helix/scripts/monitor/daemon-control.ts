/**
 * scripts/monitor/daemon-control.ts — start/stop the Slack listener daemon (CP-1 · "Helix can
 * boot monitor").
 * ═══════════════════════════════════════════════════════════════════════════════
 * The concrete boot behind `*monitor` / `*monitor-stop`: the orchestrator shells out to
 *   bun run scripts/monitor/daemon-control.ts start --session <runId> --channel <C> [--relay]
 *   bun run scripts/monitor/daemon-control.ts stop  --session <runId>
 * `start` spawns `slack-listen.ts` DETACHED (survives the session) and records its pid at
 * `<root>/<session>/daemon.pid`; `stop` reads that pid and kills it. <session> = the *monitor
 * runId, so a session stops exactly the daemon IT started (single-owner).
 *
 * The arg-building + pid-path are PURE + tested; spawn/kill are the thin impure seam.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DaemonOpts {
  sessionId: string;
  channel: string;
  relay?: boolean;
  /** the listener entrypoint, relative to cwd (overridable for tests) */
  script?: string;
}

/** Build the `bun run …` argv for the listener (PURE). */
export function buildDaemonArgs(o: DaemonOpts): string[] {
  const args = ["run", o.script ?? "scripts/monitor/slack-listen.ts", "--session", o.sessionId, "--channel", o.channel];
  if (o.relay === true) args.push("--relay");
  return args;
}

/** Where the daemon's pid is recorded, under the session dir (PURE). */
export function pidPath(root: string, sessionId: string): string {
  return join(root, sessionId, "daemon.pid");
}

/** Where the detached daemon's stdout/stderr are captured (PURE). */
export function logPath(root: string, sessionId: string): string {
  return join(root, sessionId, "daemon.log");
}

/** Parse a pid file's contents → a positive int, or null (PURE). */
export function parsePid(text: string): number | null {
  const n = Number.parseInt(text.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function readPid(root: string, sessionId: string): number | null {
  const p = pidPath(root, sessionId);
  return existsSync(p) ? parsePid(readFileSync(p, "utf8")) : null;
}

/** Spawn the detached daemon, record its pid, and return it. */
export function startDaemon(root: string, opts: DaemonOpts): number {
  const p = pidPath(root, opts.sessionId);
  mkdirSync(dirname(p), { recursive: true });
  // Capture the detached daemon's output to <session>/daemon.log so the loop is observable
  // (append; the file survives restarts as a running ledger).
  const logFd = openSync(logPath(root, opts.sessionId), "a");
  const child = spawn("bun", buildDaemonArgs(opts), { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  child.unref();
  const pid = child.pid ?? 0;
  writeFileSync(p, String(pid));
  return pid;
}

/** Kill the daemon this session started; returns whether one was running. */
export function stopDaemon(root: string, sessionId: string): "stopped" | "not-running" {
  const pid = readPid(root, sessionId);
  if (pid === null) return "not-running";
  try {
    process.kill(pid);
  } catch {
    /* already gone — fall through to clear the stale pid file */
  }
  rmSync(pidPath(root, sessionId), { force: true });
  return "stopped";
}

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a !== undefined && a.startsWith("--")) {
      const next = rest[i + 1];
      flags[a.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
    }
  }
  const root = process.env.MONITOR_ROOT ?? ".mutagent/monitor";
  const session = flags.session;
  if (session === undefined) throw new Error("daemon-control: --session <id> is required");
  if (sub === "start") {
    if (flags.channel === undefined) throw new Error("daemon-control start: --channel <C> is required");
    const pid = startDaemon(root, { sessionId: session, channel: flags.channel, relay: flags.relay === "true" });
    console.info(`[daemon-control] started pid ${pid} · session ${session} · mode ${flags.relay === "true" ? "relay" : "standalone"}`);
  } else if (sub === "stop") {
    console.info(`[daemon-control] ${stopDaemon(root, session)} · session ${session}`);
  } else {
    throw new Error(`daemon-control: unknown subcommand "${sub ?? ""}" (start | stop)`);
  }
}
