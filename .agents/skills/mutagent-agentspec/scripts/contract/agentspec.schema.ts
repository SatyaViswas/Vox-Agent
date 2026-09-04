/**
 * scripts/contract/agentspec.schema.ts
 * TypeBox schema + TypeScript types for the portable agentspec.yaml — AgentSpec 0.3.0.
 * Type A — Pure Script (schema + types + a pure validate function — no I/O side effects).
 *
 * AgentSpec 0.3.0 is the FIRST canonical versioned baseline (N01/F01 — no 0.2 migration/history).
 * It is ONE closed resource envelope with a strict `kind` discriminator:
 *
 *   apiVersion: agentspec.mutagent.io/v0.3.0   # compatibility contract (D12), not a package version
 *   kind:       Agent | Skill | MultiAgent | Workflow    # inferred AFTER intent (D01/D03)
 *   metadata:   { id · name · version · description }     # one coherent card identity
 *   spec:                                                  # requirements-first, target-independent
 *     intent        — problem · outcomes · long-form SOP (before derived jobs) · constraints ·
 *                     nonGoals · assumptions · unknowns          (requirements-first Intent)
 *     context[]     — inbound information + its read access, together                     (D16)
 *     actions[]     — outbound side effects: binding · approval · evidence · onFailure    (D16)
 *     capabilities  — local code · loadable skills · delegates (requirements before targets)
 *     <kind body>   — EXACTLY ONE of agent | skill | multiAgent | workflow                (D01/D03)
 *     targets[]     — one or more destinations + artifact.format/path (supersedes `medium`, FU-69)
 *     evaluation    — criteria · scenarios · datasets (dataset-local categories, D18/D19)
 *     decisionsRef? — optional relative pointer to one colocated agentspec.decisions.md   (N03)
 *
 * STRUCTURAL vs SEMANTIC. This file is the STRUCTURAL floor: every object is CLOSED
 * (additionalProperties:false) so undeclared fields (a typo or a smuggled block) are REJECTED
 * (F02 fully-closed core). It intentionally does NOT enforce cross-reference / graph / cycle /
 * bounded-loop / kind-leakage rules — those are the SEMANTIC layer in `../validate/semantic-validator.ts`
 * (the exit checks: unknown fields fail · kind leakage fails · member cycles fail · bounded Workflow
 * loops pass · target/decision-file/context-action/dataset references resolve).
 *
 * Mirrors the handover-contract.ts pattern: a compiled TypeCompiler checker + a pure
 * `validateAgentSpec(obj) => { ok, errors[] }`. Fail-loud, never throws.
 */

import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

/**
 * The FROZEN compatibility identifier (D12/F01). Fail loudly on any incompatible shape.
 * 0.3.0 is the first canonical versioned baseline — there is no previous-version or migration field.
 */
export const AGENTSPEC_API_VERSION = "agentspec.mutagent.io/v0.3.0" as const;
/** The bare semantic version, for tooling that wants it without the domain prefix. */
export const AGENTSPEC_SCHEMA_VERSION = "0.3.0" as const;

// ── Categorical constants (no magic strings) ───────────────────────────────────

/** Top-level resource taxonomy — inferred after intent, used as a strict discriminator (D01/D03). */
export const Kind = {
  Agent: "Agent",
  Skill: "Skill",
  MultiAgent: "MultiAgent",
  Workflow: "Workflow",
} as const;
export type KindValue = (typeof Kind)[keyof typeof Kind];

/** How an Agent operates (Agent-body only). */
export const OperatingType = {
  Conversational: "conversational",
  Automation: "automation",
  Orchestrator: "orchestrator",
} as const;
export type OperatingTypeValue = (typeof OperatingType)[keyof typeof OperatingType];

/** How an Agent is ACTIVATED — inbound event sources (Agent-body only). */
export const TriggerKind = {
  A2a: "a2a",
  Webhook: "webhook",
  Schedule: "schedule",
  Queue: "queue",
  Event: "event",
  Mcp: "mcp",
  Manual: "manual",
} as const;
export type TriggerKindValue = (typeof TriggerKind)[keyof typeof TriggerKind];

/** Eval criterion check type — binary-actionable (D19). */
export const EvalType = {
  LlmJudge: "llm-judge",
  CodeCheck: "code-check",
} as const;
export type EvalTypeValue = (typeof EvalType)[keyof typeof EvalType];

/**
 * The CLOSED binding-kind vocabulary for context `access` and action `binding` (operator ruling R3,
 * 2026-07-22). A kind outside this set FAILS validation (fail-loud, consistent with F02's closed
 * core). Future kinds arrive via a 0.3.x minor bump — never by silently accepting an unknown string.
 */
export const BindingKind = {
  Cli: "cli",
  Saas: "saas",
  Mcp: "mcp",
  Sdk: "sdk",
  HostTool: "host-tool",
} as const;
export type BindingKindValue = (typeof BindingKind)[keyof typeof BindingKind];

/**
 * The CLOSED executor-kind vocabulary for a Workflow node's typed executor (F03 LOCKED; operator
 * ruling R4, 2026-07-22). A step invokes a member, an Agent/Skill capability, a bounded action, an
 * integration, or a code operation. Required INPUT (context reads) stays SEPARATE on the node as
 * `contextRefs` — it is NOT an executor form.
 */
export const ExecutorKind = {
  Member: "member",
  Agent: "agent",
  Skill: "skill",
  Action: "action",
  Integration: "integration",
  Code: "code",
} as const;
export type ExecutorKindValue = (typeof ExecutorKind)[keyof typeof ExecutorKind];

/**
 * Target destination family (D08/D15). `type` names the environment class; `name` the concrete
 * ecosystem identity (e.g. harness + claude-code). `custom` covers internal/bespoke frameworks —
 * a normal target with path/doc references, not a schema extension (F02).
 */
export const TargetType = {
  Harness: "harness",
  Framework: "framework",
  Platform: "platform",
  Custom: "custom",
} as const;
export type TargetTypeValue = (typeof TargetType)[keyof typeof TargetType];

/**
 * Generated artifact shape (supersedes the prior `medium` term, FU-69). Drives the Builder gate:
 * `markdown` → harness agent/skill files; `code` → source (may add implementation.*);
 * `platform-config` → managed-platform declarative config.
 */
export const ArtifactFormat = {
  Markdown: "markdown",
  Code: "code",
  PlatformConfig: "platform-config",
} as const;
export type ArtifactFormatValue = (typeof ArtifactFormat)[keyof typeof ArtifactFormat];

/**
 * The ADL lifecycle stages in loop order (spec → build → evaluate → diagnose → optimize → ship).
 * Used ONLY by the INTERNAL `status` profile (below) to record where a subject card currently sits
 * in the loop. It is NOT part of the public portable contract — a published card carries no
 * lifecycle position. `ship` (⑥ SHIP) was admitted in the #1202 coordinated frozen-contract pass so
 * a `ship:PASS` / `ship:FAIL` loop-position stamp validates (ship PRD §8). This enum intentionally
 * omits `audit` (a routing sibling, not a loop-order stage).
 */
export const AdlStage = {
  Spec: "spec",
  Build: "build",
  Evaluate: "evaluate",
  Diagnose: "diagnose",
  Optimize: "optimize",
  Ship: "ship",
} as const;
export type AdlStageValue = (typeof AdlStage)[keyof typeof AdlStage];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** A closed object — undeclared fields rejected (F02 fully-closed core). */
function closed<T extends Parameters<typeof Type.Object>[0]>(props: T) {
  return Type.Object(props, { additionalProperties: false });
}
/** A non-empty string (identity / description fields must carry content). */
const Str = () => Type.String({ minLength: 1 });
/** An array of non-empty strings. */
const StrArray = () => Type.Array(Str());
/** A closed literal-union from a const enum object's values (fail-loud on any unlisted value). */
function enumUnion(values: readonly string[]) {
  return Type.Union(values.map((v) => Type.Literal(v)));
}
const BINDING_KIND = enumUnion(Object.values(BindingKind));
const EXECUTOR_KIND = enumUnion(Object.values(ExecutorKind));

// ── ENVELOPE: metadata ────────────────────────────────────────────────────────

/** One coherent card identity (distinct from apiVersion and from any package release version). */
export const MetadataSchema = closed({
  id: Str(),
  name: Str(),
  version: Str(),
  description: Str(),
});
export type Metadata = Static<typeof MetadataSchema>;

// ── spec.intent (requirements-first) ────────────────────────────────────────────

/**
 * A long-form Standard Operating Procedure entry — the fuller procedural intent that PRECEDES the
 * derived `jobs[]` slices. `onFailure` is the safe-failure contract for this procedure.
 */
export const SopEntrySchema = closed({
  id: Str(),
  when: Str(),
  description: Str(),
  onFailure: Type.Optional(Str()),
});
export type SopEntry = Static<typeof SopEntrySchema>;

/** A derived job-to-be-done — a traceable slice of the SOP (jobs feed requirements/evals/fidelity). */
export const JobSchema = closed({
  id: Str(),
  description: Str(),
  expectedOutput: Str(),
});
export type Job = Static<typeof JobSchema>;

/**
 * Requirements-first Intent (before kind/target). The long-form `sop` comes before derived `jobs`
 * (requirements-first). `assumptions`/`unknowns` keep unverified beliefs from masquerading as facts
 * and force the Builder to stop-or-ask rather than guess.
 */
export const IntentSchema = closed({
  problem: Str(),
  outcomes: StrArray(),
  sop: Type.Array(SopEntrySchema),
  jobs: Type.Array(JobSchema),
  constraints: StrArray(),
  nonGoals: StrArray(),
  assumptions: StrArray(),
  unknowns: StrArray(),
});
export type Intent = Static<typeof IntentSchema>;

// ── spec.context[] / spec.actions[] (D16 separate contracts) ─────────────────────

/**
 * The read access for one context item — the binding, allowed read operations, and an optional
 * auth/config reference. Access is nested WITH the information it supplies (D16): no separate mode
 * axis or cross-list reference is needed. `kind` is a CLOSED binding vocabulary — cli · saas · mcp ·
 * sdk · host-tool (operator ruling R3, 2026-07-22); an unlisted kind FAILS validation.
 */
export const AccessSchema = closed({
  kind: BINDING_KIND,
  ref: Str(),
  allowedOperations: StrArray(),
  authRef: Type.Optional(Str()),
});
export type Access = Static<typeof AccessSchema>;

/** An inbound information requirement + the forms it can take + how it is read (D16). */
export const ContextSchema = closed({
  id: Str(),
  description: Str(),
  modalities: StrArray(),
  source: Str(),
  freshness: Type.Optional(Str()),
  sensitivity: Type.Optional(Str()),
  access: AccessSchema,
});
export type ContextItem = Static<typeof ContextSchema>;

/** The connector binding for an outbound action. `kind` is the CLOSED binding vocabulary (R3). */
export const BindingSchema = closed({
  kind: BINDING_KIND,
  ref: Str(),
  authRef: Type.Optional(Str()),
});
export type Binding = Static<typeof BindingSchema>;

/** Human-gate policy for an outbound action (makes side-effect control testable). */
export const ApprovalSchema = closed({
  policy: Str(),
  when: Str(),
});
export type Approval = Static<typeof ApprovalSchema>;

/**
 * An outbound side-effect requirement (D16) — kept SEPARATE from context reads. `allowedOperations`
 * bounds a broad connector to specific writes; `approval`/`evidence`/`onFailure` make the effect
 * gated, auditable, and safe on failure.
 */
export const ActionSchema = closed({
  id: Str(),
  description: Str(),
  binding: BindingSchema,
  allowedOperations: StrArray(),
  approval: ApprovalSchema,
  evidence: Str(),
  onFailure: Str(),
});
export type ActionItem = Static<typeof ActionSchema>;

// ── spec.capabilities (requirements before target selection) ─────────────────────

/** A local/generated code capability the subject needs (each target later proves a binding). */
export const CodeCapabilitySchema = closed({
  id: Str(),
  description: Str(),
  constraints: Type.Optional(closed({ sandbox: Type.Boolean() })),
});
export type CodeCapability = Static<typeof CodeCapabilitySchema>;

/**
 * Local capability requirements (curated from the 0.2 tool buckets). `skills` are loadable
 * capability refs; `delegates` are downward-dispatch member/agent ids. These are REQUIREMENTS
 * declared before any target is chosen; a target later proves a native binding or reports a gap.
 */
export const CapabilitiesSchema = closed({
  code: Type.Array(CodeCapabilitySchema),
  skills: StrArray(),
  delegates: StrArray(),
});
export type Capabilities = Static<typeof CapabilitiesSchema>;

// ── Canonical Workflow graph (one dialect: top-level, embedded, referenced) ──────

/**
 * A node executor binding — the STRICT typed reference `{ kind, ref }` (F03 LOCKED; operator ruling
 * R4, 2026-07-22). `kind` is the closed executor vocabulary; `ref` is the id it invokes:
 *   { kind: member,      ref: <member-id> }   — dispatch a multiAgent.members[] member
 *   { kind: action,      ref: <action-id> }   — invoke a spec.actions[] side effect
 *   { kind: agent|skill, ref: <id> }          — invoke an Agent/Skill capability
 *   { kind: integration|code, ref: <id> }     — invoke an integration / code operation
 * Required INPUT (context reads) is NOT an executor form — it lives on the node as `contextRefs`.
 * The provisional 0.3-draft forms (`actionRef` / `memberRef` / `contextRefs`-inside-executor) are
 * REMOVED; the closed object rejects them. The semantic validator resolves action/member refs.
 */
export const ExecutorSchema = closed({
  kind: EXECUTOR_KIND,
  ref: Str(),
});
export type Executor = Static<typeof ExecutorSchema>;

/**
 * A returning/branching edge's termination contract (N02). Any edge that can revisit a node must
 * declare an enforceable bound — `maxIterations` and/or `exitWhen`. The semantic validator rejects
 * an unbounded cycle; the structural schema only shapes the field.
 */
export const LoopSchema = closed({
  maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
  exitWhen: Type.Optional(Str()),
});
export type Loop = Static<typeof LoopSchema>;

/** One outgoing control-flow edge owned by a node. */
export const EdgeSchema = closed({
  to: Str(),
  condition: Type.Optional(Str()),
  loop: Type.Optional(LoopSchema),
});
export type Edge = Static<typeof EdgeSchema>;

/**
 * A workflow step. Verbose `description` is normative (a bare id is insufficient for a Builder).
 * `executor` is the STRICT typed {kind, ref} invocation (F03/R4); `contextRefs` is the SEPARATE
 * required-input contract (context reads are not an executor form) resolving to spec.context ids.
 */
export const NodeSchema = closed({
  id: Str(),
  description: Str(),
  executor: Type.Optional(ExecutorSchema),
  contextRefs: Type.Optional(StrArray()),
  edges: Type.Optional(Type.Array(EdgeSchema)),
  terminal: Type.Optional(Type.Boolean()),
});
export type Node = Static<typeof NodeSchema>;

/** The canonical Workflow graph body — one schema for standalone AND embedded graphs. */
export const WorkflowBodySchema = closed({
  state: Str(),
  entry: Str(),
  nodes: Type.Array(NodeSchema),
});
export type WorkflowBody = Static<typeof WorkflowBodySchema>;

/** An optional embedded-or-referenced workflow (Agent / MultiAgent bodies): inline graph OR a ref. */
export const WorkflowSlotSchema = closed({
  inline: Type.Optional(WorkflowBodySchema),
  ref: Type.Optional(Str()),
});
export type WorkflowSlot = Static<typeof WorkflowSlotSchema>;

// ── spec.agent (one autonomous subject) ──────────────────────────────────────────

/** Operative identity, tone, boundaries, stance — verbose YAML data (Agent-only). */
export const PersonaSchema = closed({
  role: Str(),
  description: Str(),
});
export type Persona = Static<typeof PersonaSchema>;

/** How an Agent is activated — an inbound event source (Agent-only). */
export const TriggerSchema = closed({
  id: Str(),
  description: Str(),
  kind: Type.Union([
    Type.Literal(TriggerKind.A2a),
    Type.Literal(TriggerKind.Webhook),
    Type.Literal(TriggerKind.Schedule),
    Type.Literal(TriggerKind.Queue),
    Type.Literal(TriggerKind.Event),
    Type.Literal(TriggerKind.Mcp),
    Type.Literal(TriggerKind.Manual),
  ]),
});
export type Trigger = Static<typeof TriggerSchema>;

/**
 * The Agent design body — how one autonomous subject realizes the shared intent. `systemPrompt` is
 * the ACTUAL runtime prompt (sacred text carried verbatim, not a summary). An Agent may carry an
 * optional canonical Workflow (same contract as kind: Workflow) instead of a bespoke decision graph.
 */
export const AgentBodySchema = closed({
  persona: PersonaSchema,
  systemPrompt: Str(),
  operatingType: Type.Union([
    Type.Literal(OperatingType.Conversational),
    Type.Literal(OperatingType.Automation),
    Type.Literal(OperatingType.Orchestrator),
  ]),
  triggers: Type.Optional(Type.Array(TriggerSchema)),
  workflow: Type.Optional(WorkflowSlotSchema),
});
export type AgentBody = Static<typeof AgentBodySchema>;

// ── spec.skill (a loadable capability, not an Agent with a label) ────────────────

/** A named input a Skill expects. */
export const SkillInputSchema = closed({
  name: Str(),
  description: Str(),
  required: Type.Optional(Type.Boolean()),
});
export type SkillInput = Static<typeof SkillInputSchema>;

/** A named output a Skill renders. */
export const SkillOutputSchema = closed({
  name: Str(),
  description: Str(),
});
export type SkillOutput = Static<typeof SkillOutputSchema>;

/** A reference/script/asset the Skill bundles (supports progressive disclosure + packaging checks). */
export const SkillResourceSchema = closed({
  id: Str(),
  kind: Str(),
  path: Str(),
  description: Str(),
});
export type SkillResource = Static<typeof SkillResourceSchema>;

/**
 * The Skill design body — host-loadable capability semantics, deliberately NOT Agent anatomy.
 * `invocation` replaces Agent inbound-trigger assumptions with host-aware activation;
 * `hostRequirements` names the context/action ids the host must provide (declares needs without
 * pretending to own the host's connectors); `failureBehavior` prevents silent partial execution.
 */
export const SkillBodySchema = closed({
  purpose: Str(),
  invocation: Str(),
  instructions: Str(),
  inputs: Type.Array(SkillInputSchema),
  outputs: Type.Array(SkillOutputSchema),
  resources: Type.Array(SkillResourceSchema),
  hostRequirements: StrArray(),
  failureBehavior: Str(),
  progressiveDisclosure: Type.Boolean(),
  subagents: Type.Optional(StrArray()),
});
export type SkillBody = Static<typeof SkillBodySchema>;

// ── spec.multiAgent (envelope + embedded members + wiring) ───────────────────────

/**
 * An embedded member spec. A member reuses the parent's shared intent/context/actions by REFERENCE
 * (`intentRef` / `contextRefs` / `actionRefs`) OR carries its own — either way it is a complete
 * Agent/Skill card with its own design body. The reference graph across members must be finite and
 * acyclic (N02) — enforced by the semantic validator.
 */
export const MemberSpecSchema = closed({
  intentRef: Type.Optional(Str()),
  contextRefs: Type.Optional(StrArray()),
  actionRefs: Type.Optional(StrArray()),
  intent: Type.Optional(IntentSchema),
  context: Type.Optional(Type.Array(ContextSchema)),
  actions: Type.Optional(Type.Array(ActionSchema)),
  capabilities: Type.Optional(CapabilitiesSchema),
  agent: Type.Optional(AgentBodySchema),
  skill: Type.Optional(SkillBodySchema),
});
export type MemberSpec = Static<typeof MemberSpecSchema>;

/** An inline embedded member resource card (same envelope; kind restricted to Agent|Skill). */
export const MemberCardSchema = closed({
  apiVersion: Type.Literal(AGENTSPEC_API_VERSION),
  kind: Type.Union([Type.Literal(Kind.Agent), Type.Literal(Kind.Skill)]),
  metadata: MetadataSchema,
  spec: MemberSpecSchema,
});
export type MemberCard = Static<typeof MemberCardSchema>;

/** A member entry — an inline embedded card OR a reference to a complete sibling card (N02). */
export const MemberEntrySchema = Type.Union([
  MemberCardSchema,
  closed({ specRef: Str() }),
]);
export type MemberEntry = Static<typeof MemberEntrySchema>;

/**
 * Member wiring, kept SEPARATE from control flow. `subagents` = dispatch relation (a member an
 * orchestrator dispatches downward); `observes` = watch relation (a watchdog monitors without
 * dispatching). Keeping them distinct is what makes governance/watch testable apart from delegation.
 */
export const RelationsSchema = closed({
  subagents: Type.Record(Type.String(), StrArray()),
  observes: Type.Record(Type.String(), StrArray()),
});
export type Relations = Static<typeof RelationsSchema>;

/** The MultiAgent design body — one root orchestrator, embedded members, wiring, and a graph. */
export const MultiAgentBodySchema = closed({
  orchestrator: Str(),
  members: Type.Array(MemberEntrySchema),
  relations: RelationsSchema,
  workflow: WorkflowSlotSchema,
});
export type MultiAgentBody = Static<typeof MultiAgentBodySchema>;

// ── spec.targets[] (one vocabulary, multiple destinations) ───────────────────────

/** The generated artifact shape + destination path. `format` supersedes the prior `medium`. */
export const ArtifactSchema = closed({
  format: Type.Union([
    Type.Literal(ArtifactFormat.Markdown),
    Type.Literal(ArtifactFormat.Code),
    Type.Literal(ArtifactFormat.PlatformConfig),
  ]),
  path: Str(),
});
export type Artifact = Static<typeof ArtifactSchema>;

/** Purpose-labeled authoritative guidance for a destination (lets the Builder learn conventions). */
export const DocumentationSchema = closed({
  purpose: Str(),
  url: Str(),
});
export type Documentation = Static<typeof DocumentationSchema>;

/** Optional generated-code constraints — code targets ONLY (N04). Omitted for markdown/platform. */
export const ImplementationSchema = closed({
  language: Str(),
  toolchain: Str(),
});
export type Implementation = Static<typeof ImplementationSchema>;

/**
 * A supported destination + its generated-artifact contract (D08/D14/D15/N04). `type`/`name`
 * identify the environment; `artifact` identifies output; `implementation` (code only) adds
 * source-generation constraints; `documentation` teaches custom/internal conventions without a
 * schema extension; `capabilityFit` records how the target satisfies required behavior.
 */
export const TargetSchema = closed({
  id: Str(),
  type: Type.Union([
    Type.Literal(TargetType.Harness),
    Type.Literal(TargetType.Framework),
    Type.Literal(TargetType.Platform),
    Type.Literal(TargetType.Custom),
  ]),
  name: Str(),
  artifact: ArtifactSchema,
  implementation: Type.Optional(ImplementationSchema),
  capabilityFit: Str(),
  documentation: Type.Array(DocumentationSchema),
});
export type Target = Static<typeof TargetSchema>;

// ── spec.evaluation (universal closure; dataset-local categories, D18/D19) ───────

/** A binary, actionable pass/fail claim (every kind closes with measurable correctness). */
export const CriterionSchema = closed({
  id: Str(),
  description: Str(),
  type: Type.Union([
    Type.Literal(EvalType.LlmJudge),
    Type.Literal(EvalType.CodeCheck),
  ]),
  goal: Str(),
});
export type Criterion = Static<typeof CriterionSchema>;

/** A broad behavior/use-case contract; every dataset item references one scenario directly. */
export const ScenarioSchema = closed({
  id: Str(),
  description: Str(),
  expectedBehavior: Str(),
  edgeCase: Type.Optional(Type.Boolean()),
});
export type Scenario = Static<typeof ScenarioSchema>;

/** Direct mapping of a dataset back to Intent jobs, scenarios, and criteria (traceability). */
export const DatasetMapsToSchema = closed({
  jobs: Type.Optional(StrArray()),
  scenarios: Type.Optional(StrArray()),
  criteria: Type.Optional(StrArray()),
});
export type DatasetMapsTo = Static<typeof DatasetMapsToSchema>;

/**
 * A dataset-LOCAL semantic slice (D18) — kept next to the dataset it shapes (no separate global
 * category layer). `generationGuidance` steers an LLM toward representative, non-repetitive
 * construction; `requiredCases` optionally pins combinations that must appear.
 */
export const DatasetCategorySchema = closed({
  id: Str(),
  description: Str(),
  generationGuidance: Type.Optional(Str()),
  requiredCases: Type.Optional(Type.Array(Type.Record(Type.String(), Type.String()))),
});
export type DatasetCategory = Static<typeof DatasetCategorySchema>;

/** One dataset-specific case dimension + its allowed values (models an independent variation axis, D18). */
export const CaseDimensionSchema = closed({
  description: Str(),
  values: StrArray(),
});
export type CaseDimension = Static<typeof CaseDimensionSchema>;

/**
 * One dataset item (D18) — auditable row by row. `case` classifies the item along the dataset's
 * `caseDimensions`. `input`/`expected` carry kind-specific payloads (Agent response/actionCalls,
 * Skill outputs/hostActions, MultiAgent member/node outputs, Workflow path/nodeOutputs). Those
 * payloads are opaque YAML DATA (downstream LLMs/agents read them), so they are not sub-schema'd —
 * but the item envelope itself is closed.
 */
export const DatasetItemSchema = closed({
  id: Str(),
  category: Type.Optional(Str()),
  scenarioRef: Str(),
  case: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  input: Type.Optional(Type.Unknown()),
  expected: Type.Optional(Type.Unknown()),
});
export type DatasetItem = Static<typeof DatasetItemSchema>;

/**
 * One planned or materialized evaluation collection (D18/D19). Items may be inline (`items`) OR a
 * manifest pointer (`itemsRef`) using the same row contract — so construction stays auditable
 * without forcing thousands of rows into the card. Several datasets can cover different slices.
 */
export const DatasetSchema = closed({
  id: Str(),
  description: Str(),
  mapsTo: DatasetMapsToSchema,
  categories: Type.Array(DatasetCategorySchema),
  caseDimensions: Type.Optional(Type.Record(Type.String(), CaseDimensionSchema)),
  items: Type.Optional(Type.Array(DatasetItemSchema)),
  itemsRef: Type.Optional(Str()),
});
export type Dataset = Static<typeof DatasetSchema>;

/**
 * The universal evaluation contract — closes EVERY kind with "is it right?" (F05: arrays may remain
 * draft/empty during the interview; the approved spec still shows missing links honestly).
 */
export const EvaluationSchema = closed({
  criteria: Type.Array(CriterionSchema),
  scenarios: Type.Array(ScenarioSchema),
  datasets: Type.Array(DatasetSchema),
});
export type Evaluation = Static<typeof EvaluationSchema>;

// ── spec (the discriminated resource spec) ───────────────────────────────────────

/**
 * The resource spec. The kind-native body is one of `agent`/`skill`/`multiAgent`/`workflow`; all
 * four are structurally OPTIONAL here and the semantic validator enforces "exactly the one matching
 * `kind`, no leakage" (the kind-leakage exit check) — this yields a precise semantic error rather
 * than an opaque union mismatch.
 */
export const SpecSchema = closed({
  intent: IntentSchema,
  context: Type.Array(ContextSchema),
  actions: Type.Array(ActionSchema),
  capabilities: CapabilitiesSchema,
  agent: Type.Optional(AgentBodySchema),
  skill: Type.Optional(SkillBodySchema),
  multiAgent: Type.Optional(MultiAgentBodySchema),
  workflow: Type.Optional(WorkflowBodySchema),
  targets: Type.Array(TargetSchema),
  evaluation: EvaluationSchema,
  decisionsRef: Type.Optional(Str()),
});
export type Spec = Static<typeof SpecSchema>;

// ── ROOT ──────────────────────────────────────────────────────────────────────────

/** Shared root props — the ONE envelope, reused by the public schema and the internal profile below. */
const agentSpecRootProps = {
  apiVersion: Type.Literal(AGENTSPEC_API_VERSION),
  kind: Type.Union([
    Type.Literal(Kind.Agent),
    Type.Literal(Kind.Skill),
    Type.Literal(Kind.MultiAgent),
    Type.Literal(Kind.Workflow),
  ]),
  metadata: MetadataSchema,
  spec: SpecSchema,
} as const;

/**
 * The full PUBLIC AgentSpec 0.3.0 resource card. Closed envelope — undeclared top-level fields are
 * rejected. In particular it carries NO `status` field: a status-bearing card FAILS public validation
 * as an unknown field (the internal-status-on-public negative fixture). This is the portable contract.
 */
export const AgentSpecSchema = closed(agentSpecRootProps);
export type AgentSpec = Static<typeof AgentSpecSchema>;

// ── INTERNAL PROFILE: top-level `status` (dev-internal only — stripped on publish) ──

/**
 * The ADL loop-state stamp — a CONTROLLED EXTENSION of the same contract, NOT a forked second schema.
 * It is a CLOSED object of EXACTLY three fields; a fourth key fails.
 *   adl_stage    — where the subject currently sits in the ADL loop (closed AdlStage enum).
 *   updated_at   — ISO-8601 UTC instant the stamp was last written (pattern-checked).
 *   last_verdict — the most recent stage verdict, STAGE-QUALIFIED as "<stage>:<VERDICT>"
 *                  (e.g. "evaluate:PASS"). Stage-qualified — not a bare "PASS" — was chosen so the
 *                  orchestrator build-index (loop position) and check-sync-spec (freshness) can read
 *                  WHICH stage produced the verdict without a second lookup. (operator ruling 2026-07-23)
 *
 * WHY it exists (operator rulings 2026-07-22 / 2026-07-23): it SUPERSEDES the 0.2 principle that
 * "the spec IS the subject record / there is no external registry" for INTERNAL loop tracking only —
 * a card gains a private, self-contained loop-state stamp. It never ships: `sanitizeForPublish` strips
 * it, and public validation rejects it.
 */
const ADL_STAGE = enumUnion(Object.values(AdlStage));
/** ISO-8601 UTC instant, e.g. 2026-07-23T12:00:00Z (documented convention; pattern-enforced). */
const IsoUtcInstant = () =>
  Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" });

/**
 * STAGE-QUALIFIED verdict, "<stage>:<VERDICT>" (e.g. "evaluate:PASS"). ENFORCED (not just documented):
 * the stage prefix MUST be an AdlStage value and the verdict MUST be UPPERCASE. A bare/unqualified
 * verdict ("PASS") FAILS — the downstream consumers (build-index loop position, check-sync-spec) parse
 * the stage prefix, so an unqualified verdict is a contract violation, not a stylistic nit. The prefix
 * alternation is built from AdlStage (single source of truth) so the enum and the pattern never drift.
 */
const StageQualifiedVerdict = () =>
  Type.String({ pattern: `^(${Object.values(AdlStage).join("|")}):[A-Z][A-Z_]*$` });

export const StatusSchema = closed({
  adl_stage: ADL_STAGE,
  updated_at: IsoUtcInstant(),
  last_verdict: StageQualifiedVerdict(),
});
export type Status = Static<typeof StatusSchema>;

/**
 * The INTERNAL profile = the public root + an OPTIONAL top-level `status`, built from the SAME
 * `agentSpecRootProps` (a controlled superset, one contract file — never a divergent second schema).
 */
export const AgentSpecInternalSchema = closed({
  ...agentSpecRootProps,
  status: Type.Optional(StatusSchema),
});
export type AgentSpecInternal = Static<typeof AgentSpecInternalSchema>;

/** The internal-only top-level fields the SYNC-SOP sanitizer removes before a card is published. */
export const INTERNAL_ONLY_TOP_LEVEL_FIELDS = ["status"] as const;

/**
 * SYNC-SOP sanitization (F02-safe publish): strip every INTERNAL-only field so a card is safe to
 * publish. Today that is exactly the top-level `status` stamp. Returns a NEW object (never mutates the
 * input) plus the list of stripped keys for audit / mechanical proof. The returned card validates
 * under the PUBLIC `AgentSpecSchema`. Pure; safe on any input (non-objects pass through unchanged).
 */
export function sanitizeForPublish(card: unknown): { card: unknown; stripped: string[] } {
  if (typeof card !== "object" || card === null || Array.isArray(card)) {
    return { card, stripped: [] };
  }
  const out: Record<string, unknown> = { ...(card as Record<string, unknown>) };
  const stripped: string[] = [];
  for (const key of INTERNAL_ONLY_TOP_LEVEL_FIELDS) {
    if (key in out) {
      delete out[key];
      stripped.push(key);
    }
  }
  return { card: out, stripped };
}

// ── Validation ──────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

// Compiled checker — compiled once at module load (mirrors handover-contract.ts).
const AgentSpecChecker = TypeCompiler.Compile(AgentSpecSchema);

/**
 * Validate an arbitrary value against the AgentSpec 0.3.0 STRUCTURAL contract.
 *
 * STRUCTURAL floor: the compiled TypeBox checker. Catches missing / wrong-typed / out-of-enum /
 * non-frozen-apiVersion fields AND undeclared extra fields (additionalProperties:false — the
 * typo / smuggled-block case, F02). It does NOT enforce cross-reference / graph / kind-leakage
 * rules — compose it with `semanticValidate` from ../validate/semantic-validator.ts for the full gate.
 *
 * Pure: no I/O, no clock. Never throws — a non-object input yields ok:false.
 */
export function validateAgentSpec(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!AgentSpecChecker.Check(obj)) {
    for (const e of AgentSpecChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Compiled INTERNAL-profile checker — accepts an optional top-level `status`; rejects everything else
// the public checker would (undeclared fields, wrong enums, a 4th status key, a malformed timestamp).
const AgentSpecInternalChecker = TypeCompiler.Compile(AgentSpecInternalSchema);

/**
 * Validate a value against the INTERNAL AgentSpec 0.3.0 STRUCTURAL profile — the public envelope plus
 * an OPTIONAL top-level `status` stamp. Used by dev-internal tooling (check-sync-spec, orchestrator
 * build-index) that reads loop-state; NEVER by the publish path (which uses `validateAgentSpec` and
 * would reject `status`). Pure; never throws.
 */
export function validateAgentSpecInternal(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!AgentSpecInternalChecker.Check(obj)) {
    for (const e of AgentSpecInternalChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
