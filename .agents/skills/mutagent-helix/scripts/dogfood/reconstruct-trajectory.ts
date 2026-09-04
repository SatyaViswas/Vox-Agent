// ---------------------------------------------------------------------------
// reconstruct-trajectory — a Helix session JSONL (+ its dispatched subagent
// JSONLs) → a structured Trajectory (lifecycle timeline · command usage ·
// per-subagent internal steps · a Call-Stack DAG). The `*dogfood` monitor calls
// this on every drift + on the 3m heartbeat.
//
// PURITY: the reconstruction CORE (`reconstructTrajectoryFromTraces`) is pure —
// no clock, no random, no I/O; the wall-clock `now` is INJECTED. The file wrapper
// (`reconstructTrajectory`) does the ONLY I/O: it reads the named JSONL paths
// THROUGH the shared `mutagent-tools` claude-code adapter → UniTF. We do NOT write
// a second transcript parser — the adapter is the single source of truth for the
// Claude Code session schema (api_error / compact_boundary / agentName / tool-use).
// ---------------------------------------------------------------------------

import { claudeCodeAdapter } from "../../../mutagent-tools/src/adapters/claude-code.ts";
import type { FetchContext } from "../../../mutagent-tools/src/adapters/types.ts";
import type { UnifiedTrace } from "../../../mutagent-tools/src/format/unitf.ts";

import {
  type CommandInvocation,
  type CommandUsage,
  type DagEdge,
  type DagNode,
  type DagSpec,
  type StageSegment,
  type SubagentActivity,
  type Trajectory,
  STAGE_META,
  stageForCommand,
} from "./types.ts";

// ── File → UniTF (via the shared adapter) ─────────────────────────────────────

/**
 * Parse ONE Claude Code session JSONL into a UniTF trace via the shared adapter.
 * The adapter's `collect` reads only `ctx.query.source.paths`; the rest of the
 * FetchContext is inert for a local file transform, so we hand it a minimal ctx.
 * Returns null when the file is unreadable / has no recognizable events.
 */
export async function parseSessionFile(path: string): Promise<UnifiedTrace | null> {
  const ctx = {
    query: { source: { paths: [path] } },
    now: 0,
    window: {},
    projectRoot: "",
  } as unknown as FetchContext;
  const res = await claudeCodeAdapter.transform!(ctx);
  return res.traces[0] ?? null;
}

// ── Span text extraction ──────────────────────────────────────────────────────

/** Best-effort deterministic stringify of a span input/output payload. */
function spanText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["text", "content", "response", "prompt", "message"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

// ── Command detection ─────────────────────────────────────────────────────────

/**
 * Detect the `*command` invocation in one user turn. A command is invoked by
 * being the LEADING token of the (trimmed) user message — exactly how Helix
 * commands are typed. This deliberately ignores `*command` MENTIONS mid-prose
 * (e.g. a `[feedback]` block that references `*evaluate`) and markdown emphasis
 * (`*like this*`), which are not invocations. Returns the leading command WITH its
 * `*` (at most one per turn), or an empty array.
 */
export function detectCommandTokens(text: string): string[] {
  const m = /^(\*[a-z][a-z0-9-]*)/.exec(text.trimStart());
  return m ? [m[1]] : [];
}

/** Extract the ordered `*command` invocations from a main-session trace. */
export function extractCommands(main: UnifiedTrace): CommandInvocation[] {
  const invocations: CommandInvocation[] = [];
  let turnIndex = 0;
  for (const span of main.spans) {
    if (span.role !== "user") continue;
    const text = spanText(span.output ?? span.input);
    const tokens = detectCommandTokens(text);
    for (const token of tokens) {
      const inv: CommandInvocation = {
        command: token,
        stage: stageForCommand(token),
        spanId: span.spanId,
        sessionId: main.sessionId ?? main.traceId,
        turnIndex,
      };
      if (span.startTime) inv.timestamp = span.startTime;
      invocations.push(inv);
    }
    turnIndex++;
  }
  return invocations;
}

// ── Timeline + usage ──────────────────────────────────────────────────────────

/** epoch-ms → ISO-8601 (for the injected `now`; not a self-read clock). */
function isoFromEpoch(now: number): string {
  return new Date(now).toISOString();
}

/**
 * Build the lifecycle stage timeline: each command opens a segment that closes
 * when the NEXT command opens (or at the injected `now` for the last one).
 */
export function buildTimeline(commands: CommandInvocation[], now: number): StageSegment[] {
  const nowIso = isoFromEpoch(now);
  return commands.map((c, i) => {
    const next = i + 1 < commands.length ? commands[i + 1] : undefined;
    const endTime = next?.timestamp ?? nowIso;
    const seg: StageSegment = { stage: c.stage, command: c.command };
    if (c.timestamp) seg.startTime = c.timestamp;
    if (endTime) seg.endTime = endTime;
    if (c.timestamp && endTime) {
      const d = Date.parse(endTime) - Date.parse(c.timestamp);
      if (Number.isFinite(d) && d >= 0) seg.durationMs = d;
    }
    return seg;
  });
}

/** Ordered `*command` usage with counts (first-seen order preserved). */
export function buildCommandUsage(commands: CommandInvocation[]): CommandUsage[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const c of commands) {
    if (!counts.has(c.command)) order.push(c.command);
    counts.set(c.command, (counts.get(c.command) ?? 0) + 1);
  }
  return order.map((command) => ({
    command,
    stage: stageForCommand(command),
    count: counts.get(command) ?? 0,
  }));
}

// ── Subagent activity ─────────────────────────────────────────────────────────

/** Derive a subagent's internal activity (key tool-steps) from its session trace. */
export function buildSubagentActivity(sub: UnifiedTrace): SubagentActivity {
  const steps: SubagentActivity["steps"] = [];
  const toolCounts: Record<string, number> = {};
  for (const span of sub.spans) {
    // tool_use spans carry a toolName; tool_result spans (role toolResult) do not.
    if (span.kind !== "tool" || !span.toolName) continue;
    const step: SubagentActivity["steps"][number] = {
      toolName: span.toolName,
      spanId: span.spanId,
    };
    if (span.startTime) step.timestamp = span.startTime;
    steps.push(step);
    toolCounts[span.toolName] = (toolCounts[span.toolName] ?? 0) + 1;
  }
  return {
    agentName: sub.agentName ?? sub.sessionId ?? sub.traceId,
    sessionId: sub.sessionId ?? sub.traceId,
    steps,
    toolCounts,
  };
}

// ── Call-Stack DAG ────────────────────────────────────────────────────────────

/** mermaid-safe node id (alphanumeric + underscore). */
function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "n";
}

/** Sanitize a label for a mermaid `["..."]` (strip quotes + collapse whitespace). */
function sanitizeLabel(s: string): string {
  return s.replace(/["[\]]/g, "").replace(/\s+/g, " ").trim();
}

/** Index of the command whose [start,end) window contains `iso`, else -1. */
function commandWindowFor(
  iso: string | undefined,
  commands: CommandInvocation[],
  now: number,
): number {
  if (!iso) return -1;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  for (let i = 0; i < commands.length; i++) {
    const start = commands[i].timestamp ? Date.parse(commands[i].timestamp as string) : NaN;
    if (!Number.isFinite(start)) continue;
    const next = i + 1 < commands.length ? commands[i + 1] : undefined;
    const end = next?.timestamp ? Date.parse(next.timestamp as string) : now;
    if (t >= start && t <= end) return i;
  }
  return -1;
}

/** Max tool-steps rendered per subagent in the DAG (the rest are in section 3). */
const MAX_DAG_STEPS = 6;

/**
 * Build the Call-Stack DAG: Helix → each `*command` → its stage skill → any
 * subagent dispatched during that command's window → up to MAX_DAG_STEPS steps.
 * Emits a {nodes,edges} spec + a deterministic mermaid flowchart string.
 */
export function buildDag(
  commands: CommandInvocation[],
  subagents: SubagentActivity[],
  now: number,
): DagSpec {
  const nodes: DagNode[] = [];
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  const addNode = (n: DagNode): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };

  addNode({ id: "helix", label: "🧬 Helix", kind: "helix" });

  // command + skill nodes
  commands.forEach((c, i) => {
    const cmdId = `cmd${i}`;
    addNode({ id: cmdId, label: c.command, kind: "command" });
    edges.push({ from: "helix", to: cmdId, kind: "dispatch" });
    const skillId = `skill_${c.stage}`;
    addNode({ id: skillId, label: STAGE_META[c.stage].skill, kind: "skill" });
    edges.push({ from: cmdId, to: skillId, kind: "call" });
  });

  // subagents attached under the skill of their active command (else under Helix)
  subagents.forEach((sub, si) => {
    const firstTs = sub.steps.find((s) => s.timestamp)?.timestamp;
    const cmdIdx = commandWindowFor(firstTs, commands, now);
    const agentId = `agent_${sanitizeId(sub.agentName)}_${si}`;
    addNode({ id: agentId, label: sub.agentName, kind: "agent" });
    if (cmdIdx >= 0) {
      const parentSkill = `skill_${commands[cmdIdx].stage}`;
      edges.push({ from: parentSkill, to: agentId, kind: "dispatch" });
    } else {
      edges.push({ from: "helix", to: agentId, kind: "dispatch" });
    }
    sub.steps.slice(0, MAX_DAG_STEPS).forEach((step, sti) => {
      const stepId = `step_${si}_${sti}`;
      addNode({ id: stepId, label: step.toolName, kind: "step" });
      edges.push({ from: agentId, to: stepId, kind: "call" });
    });
  });

  return { nodes, edges, mermaid: mermaidFromDag(nodes, edges) };
}

/** Render a {nodes,edges} DAG to a deterministic mermaid `flowchart TD` string. */
export function mermaidFromDag(nodes: DagNode[], edges: DagEdge[]): string {
  const lines: string[] = ["flowchart TD"];
  for (const n of nodes) {
    lines.push(`  ${n.id}["${sanitizeLabel(n.label)}"]`);
  }
  for (const e of edges) {
    lines.push(`  ${e.from} -->|${e.kind}| ${e.to}`);
  }
  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Pure reconstruction core — traces in, Trajectory out. No I/O, no clock. */
export function reconstructTrajectoryFromTraces(
  main: UnifiedTrace,
  subs: UnifiedTrace[],
  now: number,
): Trajectory {
  const commands = extractCommands(main);
  const subagents = subs.map(buildSubagentActivity);
  const traj: Trajectory = {
    sessionId: main.sessionId ?? main.traceId,
    now,
    timeline: buildTimeline(commands, now),
    commands,
    commandUsage: buildCommandUsage(commands),
    subagents,
    dag: buildDag(commands, subagents, now),
  };
  if (main.startTime) traj.startTime = main.startTime;
  return traj;
}



export interface ReconstructInput {
  /** The main Helix session JSONL path. */
  mainPath: string;
  /** The dispatched subagent session JSONL paths. */
  subagentPaths?: string[];
  /** Injected wall-clock (epoch ms) — the trajectory's "as of" time. */
  now: number;
}

/**
 * File wrapper: read the named session JSONL paths through the shared adapter,
 * then reconstruct. The ONLY I/O in this module. Throws if the main session is
 * unreadable / empty; skips unreadable subagent files (best-effort).
 */
export async function reconstructTrajectory(input: ReconstructInput): Promise<Trajectory> {
  const main = await parseSessionFile(input.mainPath);
  if (main === null) {
    throw new Error(`reconstruct-trajectory: no recognizable events in main session ${input.mainPath}`);
  }
  const subs: UnifiedTrace[] = [];
  for (const p of input.subagentPaths ?? []) {
    const t = await parseSessionFile(p);
    if (t !== null) subs.push(t);
  }
  return reconstructTrajectoryFromTraces(main, subs, input.now);
}
