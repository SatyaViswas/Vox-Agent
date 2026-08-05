import {
  AdlStage,
  SubjectKind,
  makeHandoverBundle,
} from "./handover-contract.ts";
import type {
  AdlStageValue,
  Acceptance,
  ArtifactRef,
  ContextPack,
  HandoverBundle,
  Provenance,
  Subject,
  SubjectKindValue,
  EscalationPolicyValue,
} from "./handover-contract.ts";
import type { TopologyIndex } from "./sync-index.ts";

// ---------------------------------------------------------------------------
// O6 — dispatch wiring.
//
// resolveDispatch maps a resolved *command + an INJECTED context to a
// DispatchDescriptor: WHAT subject is being acted on, WHICH routing ADL stage
// it is, interactive|batch, gated, and (for a real route) the HandoverBundle
// that the orchestrator EMITS to the owning skill.
//
// THE TWO-ENUM MAPPING (the iter-3 cert flagged this as O6's core job — do NOT
// conflate the two enums):
//   - The *sync TOPOLOGY classifies a directory with one enum
//     (build|evaluate|diagnose|orchestrator|shared|unknown — a DIR classification).
//   - The routing/handover AdlStage is a different enum
//     (build|evaluate|diagnose|optimize|audit — a routed ACTION).
//   This module produces the ROUTING enum from the *command, and resolves the
//   target subject's PATH from the topology. The *audit case is the proof they
//   are not the same: *audit routes to the evaluator (topology stage "evaluate")
//   but its routing stage is Audit. The command — not the subject's topology
//   classification — decides the routing stage.
//
// Producer-side, orchestrator-owned. The actual cross-skill RUNTIME invocation
// (handing the bundle to a real sibling skill) is DECLARED in orchestrator.md,
// NOT wired here. This file is the deterministic engine: resolve → (gate) → emit
// a descriptor. The descriptor's `bundle` is what a future runtime step ships.
//
// Design invariants (mirror scripts/handover-contract.ts + scripts/sync-index.ts):
//   - Pure functions + (no CLI needed — this is a library used by the gate +
//     the orchestrator's documented execution flow). No clock, no random, no
//     network. Any timestamp / id / path is an INJECTED ctx field, so the same
//     command + ctx always yields a deep-equal descriptor.
//   - The topology index is INJECTED (from *sync) rather than re-scanned, so the
//     engine stays pure + deterministic against committed fixtures.
// ---------------------------------------------------------------------------

/** Where a command runs: on the parent session (interactive) or a sub-agent (batch). */
export type DispatchMode = "interactive" | "batch";

/**
 * One row of the command → route table. Mirrors routing.yaml. A `dispatch` row
 * carries the route_target skill name + the ROUTING adl_stage; a `local` row is
 * orchestrator-internal (no subject, no bundle). `gated` is the approval flag
 * the execution gate (scripts/gate.ts) reads.
 */
export interface RouteEntry {
  type: "dispatch" | "local";
  /** The skill the *command routes to (dispatch rows only). Resolved in the topology. */
  route_target?: string;
  /** The ROUTING ADL stage (dispatch rows only) — NOT the subject's topology stage. */
  adl_stage?: AdlStageValue;
  mode: DispatchMode;
  gated: boolean;
  /**
   * INV-SHIP-1 (ship PRD §1.4) — `operator-only` marks a route the router REFUSES to
   * dispatch unless the immediate caller is an operator utterance. A trigger, a chained
   * stage-advance, an agent, or a script attempting the route is rejected. Enforced in
   * scripts/gate.ts (the `invocation-refused` blocker). Absent ⇒ any invoker may route.
   */
  invocation?: "operator-only";
  /** Why a local command is orchestrator-internal (local rows only). */
  reason?: string;
  /**
   * Optional re-entrant SKILL→SKILL delegation (route FROM the skill level — never
   * agent-direct). The PRIMARY subject stays the command owner; this names a SECOND
   * SKILL + a `mode` that skill should run. Used by *sync-spec: agentspec owns the
   * command + the spec artifact, but Helix hands a `mode:sync-spec` sub-bundle to the
   * BUILDER skill, which runs its OWN ai-architect #sync-spec (read-only). Helix never
   * reaches into a skill's private agent — encapsulation preserved.
   */
  delegates_to?: { route_target: string; mode: string };
}

// The canonical command → route table. Data-driven mirror of routing.yaml's
// `commands` block (route_target · stage · mode · gated). The routing AdlStage
// is assigned PER COMMAND here — this is the two-enum mapping's source of truth.
const ROUTES: Readonly<Record<string, RouteEntry>> = {
  // ── dispatch commands (route to a subject, emit a bundle) ──────────────────
  "*spec": {
    type: "dispatch",
    route_target: "mutagent-agentspec",
    adl_stage: AdlStage.Spec,
    mode: "interactive", // the *spec interview runs on the parent session (AskUserQuestion is parent-only)
    gated: false, // spec gathering is read/author-only — no apply, so ungated
  },
  "*build": {
    type: "dispatch",
    route_target: "mutagent-builder",
    adl_stage: AdlStage.Build,
    mode: "batch",
    gated: true,
  },
  "*sync-spec": {
    // Canonical spec-reconcile (fuses former *spec-sync + *spec-from-impl). AGENTSPEC owns the
    // entry (it owns the spec artifact); it DELEGATES the target-read to the BUILDER skill (which
    // runs its own ai-architect #sync-spec) — skill-mediated, never agent-direct. Stage is SPEC.
    type: "dispatch",
    route_target: "mutagent-agentspec",
    adl_stage: AdlStage.Spec,
    mode: "batch",
    gated: true,
    delegates_to: { route_target: "mutagent-builder", mode: "sync-spec" },
  },
  "*evaluate": {
    type: "dispatch",
    route_target: "mutagent-evaluator",
    adl_stage: AdlStage.Evaluate,
    mode: "batch",
    gated: false,
  },
  "*audit": {
    type: "dispatch",
    route_target: "mutagent-evaluator", // SAME target as *evaluate …
    adl_stage: AdlStage.Audit, // … but a DIFFERENT routing stage (no conflation)
    mode: "batch",
    gated: false,
  },
  "*diagnose": {
    type: "dispatch",
    route_target: "mutagent-diagnostics",
    adl_stage: AdlStage.Diagnose,
    mode: "batch",
    gated: true, // the OPTIMIZE (apply) step downstream is approval-gated
  },
  // *optimize — the ⑤ OPTIMIZE stage's single owner is mutagent-optimize (DC-6, resolves
  // the KP-O1 split-brain). optimize CONDUCTS the closed Build→Eval→Diagnose→Optimize loop
  // and owns the apply-gate; it DELEGATES the write to ② builder, the judge to ③ evaluator,
  // the RCA to ④ diagnostics, and the transport to `mutagent-cli apply`. Routing stage is
  // Optimize — the two-enum split: a DIFFERENT routing stage with its OWN owner (not builder).
  // Gated: a DRAFT needs no target, but APPLY needs a resolvable global target + a known
  // apply.kind — the target floor (checkOnboardingComplete, at apply) + the approval floor
  // both bite before a fix is written.
  "*optimize": {
    type: "dispatch",
    route_target: "mutagent-optimize",
    adl_stage: AdlStage.Optimize,
    mode: "batch",
    gated: true, // apply is approval-gated (draft remedies gate at apply-time via the target floor)
  },
  // ── trace collection — `*discover` → the `discovery` SYSTEM AGENT ─────────────
  // `*discover` dispatches the INTENT-AWARE `discovery` agent
  // (mutagent-orchestrator/assets/agents/discovery.md), a kind:agent subject
  // resolved from the *sync topology (sync-index indexes assets/agents/). The agent
  // reads TraceQuery.operationIntent — `fetch` (DEFAULT: generic collect/list/monitor,
  // count+fetch only) | `evals`|`dataset` (fetch → select → classify → curated) — and
  // emits a HandoverBundle of UniTF JSONL + (Selection)Manifest for the consumer stage.
  // `*collect-traces` is retained as an internal ALIAS of the same route.
  //
  // TWO-ENUM NOTE — respects the frozen split. The routing AdlStage enum
  // (spec|build|evaluate|diagnose|optimize|audit) has NO dedicated "collect" member;
  // adding one would break the FROZEN HandoverBundle contract. Collection is a
  // sequential-pre-worker that feeds diagnose|evaluate, so it routes under its DEFAULT
  // downstream consumer stage — Diagnose. The routing stage classifies the ACTION's
  // consumer, not a new lifecycle phase — same spirit as *audit reusing the evaluator target.
  "*discover": {
    type: "dispatch",
    route_target: "discovery", // the discovery AGENT (kind:agent), resolved from the *sync topology
    adl_stage: AdlStage.Diagnose, // default downstream consumer (see TWO-ENUM NOTE) — NOT a new enum member
    mode: "batch",
    gated: false, // collection is read-only fetch/normalize — no apply; downstream diagnose/evaluate gates separately
  },
  "*collect-traces": {
    type: "dispatch",
    route_target: "discovery", // internal ALIAS of *discover — same target
    adl_stage: AdlStage.Diagnose,
    mode: "batch",
    gated: false,
  },
  // ── local-only commands (orchestrator-internal — no subject, no bundle) ────
  "*sync": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal topology index — runs scripts/sync-index.ts; routes to no subject",
  },
  // *dogfood — HIDDEN observe surface. Local: it spawns the `dogfood-monitor` BG agent to
  // live-tail a DOGFOOD-TARGET session (config.dogfood.source_dir) + render the status report.
  // No skill subject/bundle; read-only observation → ungated. *dogfood-stop ends the loop.
  "*dogfood": {
    type: "local",
    mode: "batch",
    gated: false,
    reason: "orchestrator-internal observe surface — spawns dogfood-monitor to tail config.dogfood.source_dir; routes to no skill subject",
  },
  "*dogfood-stop": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal — terminates a running *dogfood monitor loop",
  },
  // *monitor — the EXTERNAL Monitor (EXT-1). Local: it spawns the `monitor` BG agent to
  // arm a watch on the dormant config.triggers; on a match the agent emits a HandoverBundle
  // to the target stage (via the same dispatch model as *discover) + posts a Slack notification.
  // Ships DISABLED (no auto-fire until triggers.<stage>.enabled:true). No skill subject/bundle
  // fabricated HERE — arming the watch is read-only → ungated. *monitor-stop disarms the watch.
  "*monitor": {
    type: "local",
    mode: "batch",
    gated: false,
    reason: "orchestrator-internal observe surface — spawns the monitor agent to watch config.triggers; routes to no skill subject (ships DISABLED)",
  },
  "*monitor-stop": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal — disarms a running *monitor watch",
  },
  // ── ⑥ SHIP (ship PRD §1.4) — owned by the mutagent-ship skill (now SCAFFOLDED, P1–P4).
  //    These are LOCAL routes, not sub-agent dispatches BY DESIGN: the ship spine (entry gate →
  //    manifest → PR → merge gate → CI FSM → post-deploy watch) RUNS IN THE PARENT SESSION (the
  //    ship steward) — it owns every gate + AskUserQuestion — and it arms the run-scoped BG
  //    ship-monitor. So the orchestrator routes LOCALLY (no HandoverBundle fabricated here; the
  //    parent invokes the mutagent-ship skill + spawns the monitor). No topology `ship` stage is
  //    added (that stays P0 frozen-contract territory). `*ship` + `*rollback` carry
  //    `invocation: operator-only` (INV-SHIP-1) — gate.ts refuses a non-operator dispatch.
  "*ship": {
    type: "local",
    mode: "batch", // BG ship-monitor; the parent stays interactive for the merge gate
    gated: true, // merge + refinement pushes are approval-floored
    invocation: "operator-only", // INV-SHIP-1 — no trigger/chain/agent/script may launch *ship
    reason:
      "⑥ SHIP — routes into the mutagent-ship skill spine (entry gate → manifest → PR → merge " +
      "gate → CI FSM → post-deploy watch), which the PARENT session (ship steward) runs while " +
      "arming the run-scoped BG ship-monitor. Local by design — the spine is parent-run, not a " +
      "sub-agent handover; apply ≠ deploy (INV-SHIP-1/INV-SHIP-2). See ship-prd.md §1/§5.",
  },
  "*ship-status": {
    type: "local",
    mode: "interactive",
    gated: false, // pure read
    reason:
      "⑥ SHIP read surface — the mutagent-ship skill renders ship-run state from disk " +
      "(monitor-state.json + ship-manifest.yaml); a pure local read, no bundle (ship-prd.md §1.2)",
  },
  "*rollback": {
    type: "local",
    mode: "interactive", // the destructive-action gate IS the interaction
    gated: true,
    invocation: "operator-only", // INV-SHIP-1/INV-SHIP-5 — destructive act, operator-only, never automatic
    reason:
      "⑥ SHIP rollback — the mutagent-ship skill's gated, evidence-linked revert-PR act " +
      "(git revert of the ship merge → OPENS a revert PR, never merges it); the parent runs it, " +
      "never automatic (INV-SHIP-5). See ship-prd.md §1.3.",
  },
  "*status": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal state read — routes to no subject",
  },
  "*onboard": {
    type: "local",
    mode: "interactive",
    gated: true, // CLI install is ALWAYS approval-gated (§4)
    reason: "orchestrator-led onboarding/config — local; CLI install is approval-gated",
  },
  "*help": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal dashboard render — routes to no subject",
  },
};

// Command aliases (mirrors routing.yaml `aliases`). *config ⇒ *onboard.
const ALIASES: Readonly<Record<string, string>> = {
  "*config": "*onboard",
  "*optimize": "*optimize", // back-compat alias — the ⑤ stage renamed optimize→optimize
};

/** Normalize a command to its canonical `*name` form (adds a leading `*`, resolves aliases). */
function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const starred = trimmed.startsWith("*") ? trimmed : `*${trimmed}`;
  const lowered = starred.toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

/**
 * Look up a command's route entry (after normalization + alias resolution).
 * Returns undefined for an unrecognized command. Exported so the execution gate
 * (scripts/gate.ts) reuses the SAME route table — one source of truth for the
 * routing stage + gated flag.
 */
export function lookupRoute(command: string): RouteEntry | undefined {
  return ROUTES[normalizeCommand(command)];
}

// ── Descriptor types (discriminated union on `kind`) ─────────────────────────

/** A real stage route: a resolved subject + the HandoverBundle to emit. */
export interface DispatchDescriptor {
  kind: "dispatch";
  /** The normalized *command that produced this descriptor. */
  command: string;
  /** What is being acted on — resolved from the injected *sync topology. */
  target_subject: Subject;
  /** The ROUTING ADL stage (build|evaluate|diagnose|optimize|audit). */
  adl_stage: AdlStageValue;
  mode: DispatchMode;
  gated: boolean;
  /** The bundle the orchestrator EMITS to the target skill (declare-only runtime). */
  bundle: HandoverBundle;
  /**
   * Resolved skill-mediated delegation (from route.delegates_to), if any. The PRIMARY
   * subject owns the command; after it runs, the owner asks Helix to hand a `mode`
   * sub-bundle to this SECOND skill (route from the skill level — never a private agent).
   * *sync-spec: primary = agentspec, delegates_to = { builder, "sync-spec" }.
   */
  delegates_to?: { subject: Subject; mode: string };
}

/** A local-only command (orchestrator-internal): no subject, no bundle fabricated. */
export interface LocalDescriptor {
  kind: "local";
  command: string;
  mode: DispatchMode;
  gated: boolean;
  reason: string;
}

/** An unrecognized command — explicitly typed, never coerced into a fake route. */
export interface UnknownDescriptor {
  kind: "unknown";
  command: string;
  reason: string;
}

export type Descriptor =
  | DispatchDescriptor
  | LocalDescriptor
  | UnknownDescriptor;

/**
 * The injected context resolveDispatch needs. The topology comes from *sync; the
 * bundle inputs (acceptance · provenance · escalation_policy · inputs ·
 * context_pack) are all INJECTED — provenance.produced_at especially is a passed
 * stamp, never a self-read clock, so the engine is deterministic.
 */
export interface DispatchContext {
  /** The *sync topology index — injected, never re-scanned here. */
  topology: TopologyIndex;
  /** The raw NL ask that triggered the route, when one did (optional). */
  intent?: { utterance?: string };
  /** The downstream stage's goal + criteria. */
  acceptance: Acceptance;
  /** Who/when produced the bundle — both INJECTED (no clock). */
  provenance: Provenance;
  escalation_policy: EscalationPolicyValue;
  /** Artifacts crossing the boundary (optional; defaults to empty). */
  inputs?: ArtifactRef[];
  /** The curated context handed down (optional; defaults to empty). */
  context_pack?: Partial<ContextPack>;
}

/**
 * Map a topology entry kind to a HandoverBundle SubjectKind. The topology has three
 * kinds ("skill" | "agent" | "system_agent"); the FROZEN SubjectKind has two
 * (skill | agent). Only "skill" → Skill; both "agent" and "system_agent" → Agent
 * (a system_agent, e.g. `discovery`, is still an agent subject on the bundle).
 */
function toSubjectKind(kind: string): SubjectKindValue {
  return kind === SubjectKind.Skill ? SubjectKind.Skill : SubjectKind.Agent;
}

/**
 * Resolve a *command + injected ctx to a DispatchDescriptor.
 *
 *   - dispatch command → resolve the route_target in the injected topology, build
 *     the target Subject {kind,name,path}, and BUILD the HandoverBundle (routing
 *     adl_stage from the command, subject from the topology, everything else
 *     injected via ctx). Reuses makeHandoverBundle.
 *   - local command (*sync/*status/*onboard/*help) → a non-dispatch descriptor,
 *     no subject/bundle fabricated.
 *   - unknown command → an explicit unknown descriptor.
 *
 * Pure + deterministic: same command + ctx ⇒ deep-equal descriptor. THROWS only
 * on a precondition violation — a dispatch command whose route_target is not in
 * the topology (you must *sync before you can route; an un-indexed target is
 * surfaced loudly, not fabricated).
 */
export function resolveDispatch(
  command: string,
  ctx: DispatchContext,
): Descriptor {
  const normalized = normalizeCommand(command);
  const route = ROUTES[normalized];

  if (route === undefined) {
    return {
      kind: "unknown",
      command: normalized,
      reason: `unrecognized command '${normalized}' — not in the routing table`,
    };
  }

  if (route.type === "local") {
    return {
      kind: "local",
      command: normalized,
      mode: route.mode,
      gated: route.gated,
      reason: route.reason ?? "orchestrator-internal command (routes to no subject)",
    };
  }

  // dispatch — resolve the target subject from the injected topology.
  const targetName = route.route_target;
  const entry = ctx.topology.entries.find((e) => e.name === targetName);
  if (entry === undefined) {
    throw new Error(
      `resolveDispatch: route_target '${targetName}' for '${normalized}' is not ` +
        `in the topology index (run *sync first — an un-indexed target cannot be routed)`,
    );
  }

  const target_subject: Subject = {
    kind: toSubjectKind(entry.kind),
    name: entry.name,
    path: entry.path,
  };

  const adl_stage = route.adl_stage as AdlStageValue;

  const bundle = makeHandoverBundle({
    adl_stage,
    subject: target_subject,
    intent:
      ctx.intent?.utterance !== undefined
        ? { command: normalized, utterance: ctx.intent.utterance }
        : { command: normalized },
    acceptance: ctx.acceptance,
    provenance: ctx.provenance,
    escalation_policy: ctx.escalation_policy,
    inputs: ctx.inputs,
    context_pack: ctx.context_pack,
  });

  // Skill-mediated delegation (route FROM the skill level): resolve the SECOND skill's
  // subject from the SAME topology so an un-indexed delegate is surfaced loudly, not
  // fabricated. No sub-bundle here — the owning skill asks Helix to hand off at runtime.
  let delegates_to: DispatchDescriptor["delegates_to"];
  if (route.delegates_to !== undefined) {
    const dName = route.delegates_to.route_target;
    const dEntry = ctx.topology.entries.find((e) => e.name === dName);
    if (dEntry === undefined) {
      throw new Error(
        `resolveDispatch: delegates_to '${dName}' for '${normalized}' is not in the ` +
          `topology index (run *sync first — an un-indexed delegate cannot be routed)`,
      );
    }
    delegates_to = {
      subject: { kind: toSubjectKind(dEntry.kind), name: dEntry.name, path: dEntry.path },
      mode: route.delegates_to.mode,
    };
  }

  return {
    kind: "dispatch",
    command: normalized,
    target_subject,
    adl_stage,
    mode: route.mode,
    gated: route.gated,
    bundle,
    ...(delegates_to !== undefined ? { delegates_to } : {}),
  };
}
