// ---------------------------------------------------------------------------
// dogfood — shared types + the ADL-stage mapping (the ONE place the *dogfood
// live-status pipeline agrees on its shapes). Pure: no clock, no random, no I/O.
//
// The *dogfood loop watches Helix being USED (in a DIFFERENT project than the one
// Helix is developed in — see dogfood-command-plan.md "BUILD-PROJECT ≠
// DOGFOOD-PROJECT") and continuously renders a live status report. These types are
// the contract between the three pure stages:
//
//   reconstruct-trajectory.ts  (session JSONL → Trajectory)
//   extract-feedback.ts        (transcript   → FeedbackItem[])
//   render-dogfood-report.ts   (Trajectory + FeedbackItem[] + meta → HTML)
// ---------------------------------------------------------------------------

/**
 * The hidden `dogfood` config block. Mirrors the shape the orchestrator's
 * config-schema.ts owns (`config.dogfood`); defined LOCALLY here so this pipeline
 * stays isolated — the lead reconciles the canonical schema at integration.
 *
 * `source_dir` is the DOGFOOD TARGET project's Claude-projects session dir
 * (e.g. `~/.claude/projects/-Users-…-mutagent-hackathon`) — NOT the build project.
 */
export interface DogfoodConfig {
  /** The dogfood target's `~/.claude/projects/<enc(project-path)>/` session dir. */
  source_dir: string;
  /** Optional glob for session files within `source_dir` (default: `*.jsonl`). */
  session_glob?: string;
  /** Whether to discover + tail dispatched subagent session JSONLs (default: true). */
  include_subagents?: boolean;
}

// ── ADL lifecycle stages ──────────────────────────────────────────────────────

/** The ADL lifecycle stages a `*command` maps to (+ `meta` for observe surfaces). */
export type AdlStage =
  | "spec"
  | "build"
  | "discover"
  | "evaluate"
  | "diagnose"
  | "optimize"
  | "meta";

/** Per-stage presentation metadata — the CSS color var + the owning skill. */
export interface StageMeta {
  /** The architecture.html per-stage CSS custom-property name (e.g. `--eval`). */
  colorVar: string;
  /** The skill/agent that owns this stage (the DAG "skill|agent" node label). */
  skill: string;
  /** A short human label for the stage. */
  label: string;
}

/** Presentation + ownership metadata keyed by ADL stage. Matches architecture.css vars. */
export const STAGE_META: Record<AdlStage, StageMeta> = {
  spec: { colorVar: "--spec", skill: "mutagent-agentspec", label: "SPEC" },
  build: { colorVar: "--build", skill: "mutagent-builder", label: "BUILD" },
  discover: { colorVar: "--cyan", skill: "discovery", label: "DISCOVER" },
  evaluate: { colorVar: "--eval", skill: "mutagent-evaluator", label: "EVALUATE" },
  diagnose: { colorVar: "--diag", skill: "mutagent-diagnostics", label: "DIAGNOSE" },
  optimize: { colorVar: "--optimize", skill: "mutagent-builder", label: "OPTIMIZE" },
  meta: { colorVar: "--muted", skill: "helix", label: "META" },
};

/**
 * `*command` → ADL stage. DATA (auditable, editable), not logic — an operator can
 * retune the routing without touching the reconstruction code. Unknown commands
 * fall back to `meta` (an observe/uncategorized surface). Keys are the bare command
 * token WITHOUT the leading `*`.
 */
export const COMMAND_STAGE: Readonly<Record<string, AdlStage>> = {
  // ① SPEC
  spec: "spec",
  agentspec: "spec",
  "sync-spec": "spec", // agentspec-owned spec-reconcile (delegates read → builder ai-architect #sync-spec)
  // ② BUILD
  build: "build",
  // DISCOVER (trace collection)
  discover: "discover",
  "discover-dataset": "discover",
  "discover-evals": "discover",
  "collect-traces": "discover",
  // ③ EVALUATE / AUDIT
  evaluate: "evaluate",
  eval: "evaluate",
  audit: "evaluate",
  "verify-evaluator": "evaluate",
  validate: "evaluate",
  // ④ DIAGNOSE
  diagnose: "diagnose",
  // ⑤ OPTIMIZE
  optimize: "optimize",
  apply: "optimize",
  // meta / observe surfaces
  dogfood: "meta",
  "dogfood-stop": "meta",
  sync: "meta",
  help: "meta",
};

/** Map a bare command token (no `*`) to its ADL stage; unknown → `meta`. */
export function stageForCommand(command: string): AdlStage {
  const bare = command.startsWith("*") ? command.slice(1) : command;
  return COMMAND_STAGE[bare] ?? "meta";
}

// ── Trajectory ────────────────────────────────────────────────────────────────

/** One `*command` invocation detected in a user turn of the main session. */
export interface CommandInvocation {
  /** The command WITH the leading `*` (e.g. `*evaluate`). */
  command: string;
  stage: AdlStage;
  /** ISO-8601 timestamp of the user turn that issued it (when the source has it). */
  timestamp?: string;
  /** The main-session span id the command was found on. */
  spanId: string;
  sessionId: string;
  /** Ordinal position among user turns (the transcript-line pointer). */
  turnIndex: number;
}

/** A lifecycle timeline segment — one command's active window. */
export interface StageSegment {
  stage: AdlStage;
  command: string;
  startTime?: string;
  /** The next command's start, or the injected `now` for the last segment. */
  endTime?: string;
  durationMs?: number;
}

/** Ordered `*command` (or skill) usage with a count. */
export interface CommandUsage {
  command: string;
  stage: AdlStage;
  count: number;
}

/** One key tool-step taken inside a dispatched subagent. */
export interface AgentStep {
  toolName: string;
  timestamp?: string;
  spanId: string;
}

/** A dispatched subagent's internal activity (from its own session JSONL). */
export interface SubagentActivity {
  agentName: string;
  sessionId: string;
  /** Ordered key tool-steps (tool spans). */
  steps: AgentStep[];
  /** toolName → count across the subagent session. */
  toolCounts: Record<string, number>;
}

/** A Call-Stack DAG node. */
export interface DagNode {
  id: string;
  label: string;
  kind: "helix" | "command" | "skill" | "agent" | "step";
}

/** A Call-Stack DAG edge. */
export interface DagEdge {
  from: string;
  to: string;
  kind: "dispatch" | "call";
}

/** The trajectory Call-Stack DAG: a {nodes,edges} spec + a mermaid flowchart string. */
export interface DagSpec {
  nodes: DagNode[];
  edges: DagEdge[];
  mermaid: string;
}

/** The reconstructed session trajectory — the render input. */
export interface Trajectory {
  sessionId: string;
  /** The injected wall-clock (epoch ms) this trajectory was reconstructed against. */
  now: number;
  startTime?: string;
  /** Ordered lifecycle segments (Gantt source). */
  timeline: StageSegment[];
  /** Ordered command invocations. */
  commands: CommandInvocation[];
  /** Ordered `*command` usage with counts. */
  commandUsage: CommandUsage[];
  /** Per-dispatched-subagent internal activity. */
  subagents: SubagentActivity[];
  /** The Call-Stack DAG. */
  dag: DagSpec;
}

// ── Feedback ────────────────────────────────────────────────────────────────

export type FeedbackSource = "explicit" | "implicit";
export type FeedbackKind = "feedback-block" | "negative-reaction" | "chat-feedback";
export type FeedbackSeverity = "high" | "med" | "low";

/** A verbatim, provenance-carrying pointer to the transcript line a signal came from. */
export interface EvidencePointer {
  sessionId: string;
  spanId: string;
  /** Ordinal position among user turns (the transcript-line pointer). */
  turnIndex: number;
  /** The VERBATIM snippet the signal was found on (never paraphrased). */
  quote: string;
}

/**
 * One captured feedback item, translated to actionable + rationale. NEVER
 * fabricated: `observation` + `evidencePointer.quote` are verbatim from the
 * transcript, and every `actionable` cites the line it came from.
 */
export interface FeedbackItem {
  source: FeedbackSource;
  kind: FeedbackKind;
  /** What was observed (verbatim for explicit blocks). */
  observation: string;
  /** The translated actionable (grounded in the observation — invents nothing). */
  actionable: string;
  /** WHY it is actionable — the signal provenance. */
  rationale: string;
  severity: FeedbackSeverity;
  evidencePointer: EvidencePointer;
}

// ── Render input ────────────────────────────────────────────────────────────

/** Metadata for the rendered status report (all values injected — no clock in core). */
export interface ReportMeta {
  runId: string;
  sessionId: string;
  /** The dogfood target session dir (documented in the report header). */
  sourceDir?: string;
  /** ISO-8601 render timestamp (INJECTED — render is pure). */
  generatedAt: string;
  /** Optional report title override. */
  title?: string;
  /** Count of subagent session files discovered. */
  subagentCount?: number;
  /**
   * If set, emit a `<meta http-equiv="refresh">` so the OPEN report auto-reloads every N
   * seconds — the "Live Status" property. The `*dogfood` monitor renders with the heartbeat
   * cadence (180 = 3 min). Omit (or 0) for a static one-shot render.
   */
  refreshSeconds?: number;
}

/** The full render input. */
export interface DogfoodReportInput {
  trajectory: Trajectory;
  feedback: FeedbackItem[];
  meta: ReportMeta;
}
