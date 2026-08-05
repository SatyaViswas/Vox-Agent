/**
 * scripts/config/schema.ts
 * TypeBox schema for the `lifecycle.diagnostics:` section of the unified
 * `.mutagent/config.yaml` (v0.2.0) + the PORTED `global.sources[]` / `global.targets[]`
 * catalog entries the diagnostics skill binds BY ROLE.
 *
 * v0.2.0 config-shape break (plan PHASE 1 · Fork B hard-cut):
 *   - `source` / `target` are NO LONGER in this section — the diagnostics skill
 *     binds a `global.sources[]` (by the source-consumer role) + a `global.targets[]`
 *     (by the target-writer role). `GlobalSourceSchema` / `GlobalTargetSchema` below
 *     are BYTE-PARITY ports of the orchestrator's `SourceSchema` / `TargetSchema`
 *     (mutagent-orchestrator/scripts/config-schema.ts) — never cross-imported
 *     (standalone + symbiosis invariant; parity is asserted by config.parity.test.ts).
 *   - `schedule` / `trigger_rules` / `heartbeat` moved OUT to the top-level
 *     `triggers.<stage>` block (orchestrator-owned) — removed here.
 *   - `credential_ref` is WIDENED to `string | { env, path? }` (mirrors
 *     resolve-credential.ts `CredentialRef`).
 *
 * credential_ref values resolve via resolve-credential.ts (env → .env → .mutagentrc);
 * raw secrets never live here.
 * Type A — Pure Script (deterministic schema definition)
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

// ── Credential ref (widened v0.2.0) ──────────────────────────────────────────

/**
 * A credential REFERENCE — an ENV-VAR NAME (string) or an object that also pins an
 * explicit file to read first (`{ env, path? }`). NEVER a raw secret value.
 * PARITY: mirrors resolve-credential.ts `CredentialRef` AND the orchestrator's
 * `CredentialRefSchema` (mutagent-orchestrator/scripts/config-schema.ts). Ported,
 * not imported (standalone invariant).
 */
export const CredentialRefSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      env: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);
export type CredentialRefValue = Static<typeof CredentialRefSchema>;

// ── Source platform ──────────────────────────────────────────────────────────

export const SourcePlatformSchema = Type.Union([
  Type.Literal("langfuse"),
  Type.Literal("otel"),
  Type.Literal("local-jsonl"),
  Type.Literal("claude-code"),
  Type.Literal("codex"),
]);

/**
 * PRD-SO-03: Enum-constrained format values (Q9 — yes, enum-constrain).
 * Used by source.format to hint the normalizer which shape to expect.
 *
 * CONSUMER: scripts/normalize/*.ts (per-platform normalizer dispatch) — the format
 * picks the record-shape parser. PURPOSE: tell the intake which on-disk shape the
 * `paths[]` files carry so the right parser runs (or, for `unitf`, is SKIPPED).
 *
 * F1 (plan FEATURE 1 · Fork A) — `"unitf"`: the file is ALREADY conformant UniTF
 * JSONL (emitted by the eval-run `captureUniTF` wrap for bare code agents). The
 * read side SKIPS per-platform normalization and reads the JSONL directly — no
 * shape translation. Typically paired with `platform: local-jsonl` + `paths:[…]`.
 * PARITY: byte-identical to the orchestrator's `SourceFormat` enum (parity.test.ts
 * asserts the literal set; the `"unitf"` add lands in both ports at once).
 */
export const SourceFormatSchema = Type.Union([
  Type.Literal("langfuse-export"),
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("raw"),
  Type.Literal("unitf"),
]);

/**
 * PARITY-PORT of the orchestrator's `SourceSchema` (mutagent-orchestrator/
 * scripts/config-schema.ts). One `global.sources[]` catalog entry — where traces
 * live. Bound BY ROLE (source-consumers evaluate/diagnose bind `global.sources`);
 * a single entry auto-binds, multiple ⇒ disambiguation deferred (NOT a hard fail).
 *
 * v0.2.0: `name` is the catalog id (referenced by role) — NEW vs the old inline
 * `source`. `credential_ref` is the widened `CredentialRefSchema`. Field set +
 * enum values + optionality are byte-identical to the orchestrator's (config.parity.test.ts).
 * Closed object (`additionalProperties:false`) — mirrors the orchestrator.
 *
 * SELECTION (parity with orchestrator + evaluator): `default?: boolean` disambiguates
 * a multi-entry catalog WITHOUT an interactive prompt — exactly one `default: true`
 * auto-binds; >1 default is a config error (`multiple-defaults`); 0 default with >1
 * entry defers to a run-start ASK (`needs-selection`). See `selectByRole` in load.ts.
 */
export const GlobalSourceSchema = Type.Object(
  {
    /** CONSUMER: load.ts `selectByRole` (role binding) + Step 1.5 ASK. PURPOSE: the
     * catalog id an operator picks/`--source`-names + the label shown in the run-start
     * ASK. Required — the join key for the whole selection contract. */
    name: Type.String({ minLength: 1 }),
    /** CONSUMER: scripts/normalize/* + the Helix pre-stage `mutagent-cli trace fetch`.
     * PURPOSE: which trace back-end this source reads from (closed enum) — selects the
     * fetch adapter + normalizer. Required. */
    platform: SourcePlatformSchema,
    /** CONSUMER: `mutagent-cli trace fetch` (Langfuse/OTel project scoping). PURPOSE:
     * the platform-side project/workspace id that narrows the trace query. */
    project: Type.Optional(Type.String({ minLength: 1 })),
    /** CONSUMER: `mutagent-cli trace fetch` (self-hosted back-ends). PURPOSE: override
     * the platform's default API host (e.g. a self-hosted Langfuse/OTel collector). */
    endpoint: Type.Optional(Type.String({ minLength: 1 })),
    /** CONSUMER: resolve-credential.ts (env → .env → .mutagentrc). PURPOSE: the ENV-VAR
     * NAME (or `{env,path}`) for the platform's read auth — NEVER a raw secret. */
    credential_ref: Type.Optional(CredentialRefSchema),
    /** CONSUMER: the read side for `platform: local-jsonl` (+ `format:"unitf"`).
     * PURPOSE: glob(s) of on-disk JSONL trace files to read directly (no API fetch). */
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** CONSUMER: scripts/normalize/* dispatch. PURPOSE: on-disk record shape hint —
     * picks the parser, or `"unitf"` ⇒ skip normalize (F1). See SourceFormatSchema. */
    format: Type.Optional(SourceFormatSchema),
    /** CONSUMER: normalize/trace.ts (agent-id extraction). PURPOSE: override the JSON
     * field the normalizer reads the agent identifier from when it is non-standard. */
    agent_field: Type.Optional(Type.String({ minLength: 1 })),
    /** CONSUMER: normalize/trace.ts (latency canonicalization). PURPOSE: how to read raw
     * duration values — `auto` infers, `ms`/`s` force the unit. */
    latency_unit: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("ms"), Type.Literal("s")]),
    ),
    /** CONSUMER: load.ts `selectByRole` (F2). PURPOSE: preselect THIS entry when >1
     * source exists — Step 1.5 then CONFIRMs it (`resolved-default`) rather than asking
     * which. Exactly one `default:true` allowed; >1 is a config error. */
    default: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type GlobalSource = Static<typeof GlobalSourceSchema>;

// ── Target platform ──────────────────────────────────────────────────────────

export const TargetPlatformSchema = Type.Union([
  Type.Literal("local-claude"),
  Type.Literal("local-codex"),
  Type.Literal("local-cursor"),
  Type.Literal("local-opencode"),
  Type.Literal("local-mastra"),
  Type.Literal("local-cloud-agent-sdk"),
  Type.Literal("cloud-rest"),
  /**
   * PRD-SO-04: report-only target — produce the HTML report but skip the apply gate
   * (Step 11 AskUserQuestion is hard-skipped; runMeta.applySkipped is populated).
   * Use for read-only environments, audits, or when you want a report without committing
   * to any agent-definition changes.
   */
  Type.Literal("report-only"),
]);

export const TargetModeSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("remote"),
]);

/**
 * HOW a fix is applied for a target. `kind` gates the report-only branch.
 * PARITY-PORT of the orchestrator's `ApplyKind` enum + `ApplySchema`.
 */
export const ApplyKindSchema = Type.Union([
  Type.Literal("code-pr"),
  Type.Literal("markdown"),
  Type.Literal("cloud-deploy"),
  Type.Literal("report-only"),
]);

export const ApplySchema = Type.Object(
  {
    /** CONSUMER: orchestrator apply gate + DiagnosticsConfig.apply (report-only branch).
     * PURPOSE: HOW a fix lands for this target — `report-only` hard-skips the apply gate;
     * the others route to the matching apply worker. Required. */
    kind: ApplyKindSchema,
    /** RESERVED — consumed by Build/Optimize (future). PURPOSE: whether the apply worker
     * stamps a version bump on the changed target. Not read by diagnostics today. */
    versioning: Type.Optional(Type.Boolean()),
    /** RESERVED — consumed by Build/Optimize (future). PURPOSE: whether the apply worker
     * opens a PR (vs a direct write) for the fix. Not read by diagnostics today. */
    pr: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type Apply = Static<typeof ApplySchema>;

/** A precise link to an Agent / Tooling definition file in a code target. */
export const CodeRefSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    why: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CodeRef = Static<typeof CodeRefSchema>;

/**
 * PARITY-PORT of the orchestrator's `TargetSchema` (mutagent-orchestrator/
 * scripts/config-schema.ts). One `global.targets[]` catalog entry — where agent
 * defs live + how a fix is applied. Bound BY ROLE (target-writers build/
 * diagnose-apply bind `global.targets`); a single entry auto-binds, multiple ⇒
 * disambiguation deferred.
 *
 * v0.2.0: `name` catalog id, `apply` block (required), `repo_url` + `code_refs`
 * are NEW vs the old inline `target`. Field set + enum values + optionality are
 * byte-identical to the orchestrator's (config.parity.test.ts). Closed object.
 *
 * SELECTION (parity with orchestrator + evaluator): `default?: boolean` disambiguates
 * a multi-entry catalog WITHOUT an interactive prompt — same precedence as the source
 * (exactly-one-default ⇒ bound; >1 ⇒ `multiple-defaults`; 0 ⇒ `needs-selection`).
 */
export const GlobalTargetSchema = Type.Object(
  {
    /** CONSUMER: load.ts `selectByRole` (role binding) + Step 1.5 ASK. PURPOSE: the
     * catalog id an operator picks/`--target`-names + the label shown in the ASK.
     * Required — the selection-contract join key. */
    name: Type.String({ minLength: 1 }),
    /** CONSUMER: the diagnostics apply worker (dispatch by platform). PURPOSE: WHERE the
     * fix is written (local coding-agent md · code construct · cloud REST · report-only
     * sink). Closed enum. Required. */
    platform: TargetPlatformSchema,
    /** CONSUMER: apply worker (local vs remote path). PURPOSE: `local` writes files in a
     * worktree; `remote` does a REST read-before-write PUT. Required. */
    mode: TargetModeSchema,
    /** CONSUMER: local-mode apply worker. PURPOSE: filesystem root the fix writes under
     * (e.g. `.claude/agents/`). Required-when `mode: local`. */
    root: Type.Optional(Type.String({ minLength: 1 })),
    /** CONSUMER: remote-mode apply worker. PURPOSE: base URL for the cloud REST apply
     * endpoint. Required-when `mode: remote`. */
    rest_base_url: Type.Optional(Type.String({ minLength: 1 })),
    /** CONSUMER: the apply worker's PR opener (local code targets). PURPOSE: the git
     * remote the fix PR is opened against. */
    repo_url: Type.Optional(Type.String({ minLength: 1 })),
    /** RESERVED — consumed by Build/Optimize (future). PURPOSE: precise links to the
     * Agent/Tooling definition files a fix should amend. Not read by diagnostics today
     * (F4 `.mutagent/index.md` will source realized impl paths from here). */
    code_refs: Type.Optional(Type.Array(CodeRefSchema)),
    /** CONSUMER: resolve-credential.ts (remote targets). PURPOSE: ENV-VAR NAME (or
     * `{env,path}`) for the target's write auth — NEVER a raw secret. */
    credential_ref: Type.Optional(CredentialRefSchema),
    /** CONSUMER: orchestrator apply gate. PURPOSE: HOW the fix lands (see ApplySchema);
     * `kind: report-only` skips the gate. Required. */
    apply: ApplySchema,
    /** CONSUMER: load.ts `selectByRole` (F2). PURPOSE: preselect THIS entry when >1
     * target exists — Step 1.5 CONFIRMs it (`resolved-default`) rather than asking which.
     * Exactly one `default:true` allowed; >1 is a config error. */
    default: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type GlobalTarget = Static<typeof GlobalTargetSchema>;

// ── Context links (PHASE 4) ──────────────────────────────────────────────────

/**
 * PARITY-PORT of the orchestrator's `ContextLinkSchema`. A supplementary context
 * link with WHAT / WHY / WHEN — all four fields REQUIRED (a link with no rationale
 * is noise). Loaded at run start: `global.context[]` (every run) +
 * `lifecycle.diagnostics.context[]` (diagnose runs) — see scripts/context/load-context.ts.
 */
export const ContextLinkSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    what: Type.String({ minLength: 1 }),
    why: Type.String({ minLength: 1 }),
    when: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ContextLink = Static<typeof ContextLinkSchema>;

// ── ASK tool ────────────────────────────────────────────────────────────────

export const AskRuntimeSchema = Type.Union([
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("cursor"),
  Type.Literal("opencode"),
  Type.Literal("generic"),
]);

export const AskToolConfigSchema = Type.Object({
  /** Detected coding-agent runtime (auto-detected by cli/init.ts) */
  runtime: AskRuntimeSchema,
  /** Platform-specific tool name (AskUserQuestion on Claude Code) */
  native_tool: Type.Optional(Type.String({ default: "AskUserQuestion" })),
  /** Fallback when native tool unavailable */
  fallback: Type.Optional(
    Type.Literal("chat-multi-choice", { default: "chat-multi-choice" })
  ),
});

// ── Trace filter ─────────────────────────────────────────────────────────────
//
// NOTE (v0.2.0): `schedule` / `trigger_rules` / `heartbeat` are REMOVED from the
// diagnostics section — the (future) monitor now lives under the top-level
// `triggers.<stage>` block (orchestrator-owned; see mutagent-orchestrator/
// scripts/config-schema.ts `TriggerStageBlockSchema`). `TraceFilterSchema` STAYS:
// it types trace-scoping filters consumed at run time (I-013 skill_agent_scope,
// referenced by normalize/trace.ts), independent of the removed trigger machinery.

export const TraceFilterSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
  start_time: Type.Optional(Type.String()),
  end_time: Type.Optional(Type.String()),
  has_error: Type.Optional(Type.Boolean()),
  has_feedback: Type.Optional(Type.Boolean()),
  score_below: Type.Optional(Type.Number()),
  latency_p99_ms_above: Type.Optional(Type.Number()),
  by_skill: Type.Optional(Type.String()),
  by_route: Type.Optional(Type.String()),
  by_tag: Type.Optional(Type.Array(Type.String())),
  /**
   * I-013: Restrict diagnostic analysis to traces from these agent IDs.
   * Empty array or absent = no filter (all agents included).
   * Typical use: set to the skill's own agent IDs for self-diagnostics scoping.
   * snake_case to match existing TraceFilterSchema field convention (agent_id, by_skill, by_tag).
   */
  skill_agent_scope: Type.Optional(Type.Array(Type.String())),
});

// ── Self-diagnostics [INTERNAL] ──────────────────────────────────────────────

export const SelfDiagnosticsCadenceSchema = Type.Union([
  Type.Literal("per-session"),
  Type.Literal("daily"),
  Type.Literal("manual"),
]);

export const SelfDiagnosticsConfigSchema = Type.Object({
  /**
   * OFF by default for end users.
   * ON for skill maintainers + dogfood mode.
   * [INTERNAL] — when enabled, feeds own session transcript through RCA pipeline (PR-022)
   */
  enabled: Type.Optional(Type.Boolean({ default: false })),
  /** How often to self-diagnose */
  cadence: Type.Optional(SelfDiagnosticsCadenceSchema),
  /** Auto-detect host coding agent for transcript path */
  source: Type.Optional(Type.String({ default: "host-coding-agent" })),
  /** Branch name for self-remedy PRs (template: use {date} placeholder) */
  remedy_branch: Type.Optional(
    Type.String({ default: "mutagent/self-diagnostics/{date}" })
  ),
  /** [INTERNAL] prefix added to all self-remedy PR titles */
  marker: Type.Optional(Type.String({ default: "[INTERNAL]" })),
});

// ── Feedback sources (Phase-2 self-diag opt-in) ─────────────────────────────

/**
 * PRD-SO-02 + Phase-2 self-diag: opt-in config for auto-collecting feedback sources.
 * When enabled, the skill collects operator feedback from configured sources (chat
 * transcripts, Langfuse trace scores, external platform) and surfaces it in findings
 * as feedbackSources[] blocks (D5).
 *
 * Opt-in via config.feedback_sources.enabled: true (Q11 — opt-in, not always-on).
 * Each sub-source has its own enabled flag for granular control.
 */
export const FeedbackSourcesConfigSchema = Type.Object({
  /**
   * Master switch. OFF by default. When true, the skill collects feedback from all
   * enabled sub-sources and injects FeedbackSource[] into each finding before render.
   */
  enabled: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Chat source: search recent Claude Code / coding-agent session transcripts
   * (~/.claude/projects/<encoded>/*.jsonl) for operator messages mentioning the entity.
   */
  chat: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      /**
       * How many most-recent session files to scan. Default 10. Higher values cost
       * more I/O but catch older feedback.
       */
      max_sessions: Type.Optional(Type.Number({ default: 10 })),
    })
  ),
  /**
   * Langfuse trace-score source: fetch trace scores with comments matching the entity.
   * Only active when source.platform = "langfuse".
   */
  trace_score: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      /**
       * Minimum score value to include (inclusive). Absent = include all scores.
       * Use to filter out non-feedback scores (e.g., numeric quality scores without comments).
       */
      min_score: Type.Optional(Type.Number()),
    })
  ),
  /**
   * External feedback platform source: REST endpoint returning FeedbackSource[].
   * Optional — only active when endpoint is set.
   */
  external: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      /** REST endpoint URL returning FeedbackSource[] JSON for the entity. */
      endpoint: Type.Optional(Type.String()),
      /** Env-var NAME for the external platform's auth, resolved via env → .env → .mutagentrc (never store value here). */
      credential_ref: Type.Optional(Type.String()),
    })
  ),
});

export type FeedbackSourcesConfig = Static<typeof FeedbackSourcesConfigSchema>;

// ── Run metadata (v0.3 run-tagging) ─────────────────────────────────────────

export const RunMetaSchema = Type.Object({
  runId: Type.String(),
  /** Tags applied to this specific run (from config.run_tags + any --tag CLI args) */
  tags: Type.Array(Type.String()),
  startedAt: Type.String(),
  endedAt: Type.Optional(Type.String()),
  /** Platform that provided traces for this run */
  source: Type.Optional(Type.String()),
  /** Target platform for this run's remedies */
  target: Type.Optional(Type.String()),
  /** Number of traces analyzed in this run */
  traceCount: Type.Optional(Type.Number()),
  /**
   * Wave-6 D2: the VERBATIM operator invocation brief that initiated this run.
   * Persisted even when parsing succeeds (re-parse later + library authenticity).
   * Optional (backward-compat — absent on runs not started via the slash command).
   */
  operatorInvocation: Type.Optional(Type.String()),
  /**
   * V3-2: the EFFECTIVE awareness deep-read sample size this run used (the number
   * of traces the awareness layer deep-read). Persisted so a LATER `--run-id`
   * cascade can scale its first-pass seed with THIS run's depth
   * (first-pass N = min(originalSampleN, AWARENESS_SAMPLE_DEFAULT); see
   * awareness/llm-sample.ts:recoverOriginalSampleN + cascadeFirstPassSize).
   * Optional (backward-compat — absent on legacy runs; recovery falls back to
   * AWARENESS_SAMPLE_DEFAULT when unset, never to the legacy discovery size).
   */
  awarenessSampleSize: Type.Optional(Type.Number()),
});

export type RunMeta = Static<typeof RunMetaSchema>;

// ── Default audience (W13-D operator directive) ──────────────────────────────

/**
 * W13-D: the audience a render pass uses when NO explicit `--audience` flag is
 * given. Two values:
 *   "client"   — the client-stripped report (internal nodes NODE-STRIPPED).
 *   "internal" — the full report (Methodology + Trajectory + internal banners).
 *
 * Operator directive: a published / client install should produce the
 * client-stripped report BY DEFAULT; internal is opt-in. So `init` writes
 * `default_audience: client` and the schema default is also "client".
 *
 * This NEVER overrides the PR-022 self-diag invariant: an `isMetaReport`
 * (self-diagnosis) render is ALWAYS internal regardless of this field — the
 * renderer hard-refuses `audience:client` on a meta report.
 */
export const DefaultAudienceSchema = Type.Union(
  [Type.Literal("client"), Type.Literal("internal")],
  { default: "client" }
);

export type DefaultAudience = Static<typeof DefaultAudienceSchema>;

/**
 * W13-D: the schema-level default audience. Single source of truth for "what does
 * a fresh install render as when nobody says otherwise" → "client" (operator
 * directive). `init` writes this value; the resolver below falls back to it.
 */
export const DEFAULT_AUDIENCE: DefaultAudience = "client";

/**
 * W13-D: deterministically resolve the effective render audience.
 *
 * Precedence (highest first):
 *   1. explicit `--audience` flag (operator override at render time)
 *   2. config.default_audience  (the fresh-init default — "client")
 *   3. DEFAULT_AUDIENCE         (schema fallback — "client")
 *
 * PR-022 INVARIANT (non-negotiable): a self-diagnosis render (isMetaReport)
 * is ALWAYS "internal" — it overrides every other input. Self-diag is never
 * client. This mirrors the renderer's hard-refuse so the orchestrator never
 * even builds an `--audience client` invocation for a meta report.
 *
 * Pure + deterministic — no clock, no I/O. The orchestrator calls this to decide
 * the `--audience` value it threads into the Step-9 render command.
 *
 * @param opts.explicitFlag       the operator's `--audience` value, if any.
 * @param opts.configDefault      config.default_audience, if present.
 * @param opts.isMetaReport       true for a self-diagnosis render (PR-022).
 */
export function resolveEffectiveAudience(opts: {
  explicitFlag?: DefaultAudience;
  configDefault?: DefaultAudience;
  isMetaReport?: boolean;
}): DefaultAudience {
  // PR-022: self-diag is ALWAYS internal — overrides flag + config.
  if (opts.isMetaReport) return "internal";
  if (opts.explicitFlag === "client" || opts.explicitFlag === "internal") {
    return opts.explicitFlag;
  }
  if (opts.configDefault === "client" || opts.configDefault === "internal") {
    return opts.configDefault;
  }
  return DEFAULT_AUDIENCE;
}

// ── Root config ──────────────────────────────────────────────────────────────

// ── Agent identity map (W11-07) ─────────────────────────────────────────────

/**
 * W11-07: Per-platform observability identity for a named agent.
 * Each entry tells the skill HOW to find this agent's traces on each supported
 * observability platform (Langfuse trace.name / tags, OTel service.name / attrs).
 *
 * This is the CROSS-PLATFORM JOIN KEY: one code-level agent may appear as
 * different identifiers in different tracing back-ends.
 *
 * Example config.yaml entry:
 *   agents:
 *     - name: search-agent
 *       langfuse:
 *         traceName: "search-agent-v2"
 *         tags: ["production", "search"]
 *         agentIdField: "metadata.agent_id"
 *       otel:
 *         serviceName: "search-svc"
 *         resourceAttrs: { "deployment.env": "prod" }
 */
export const AgentPlatformLangfuseSchema = Type.Object({
  /** Langfuse trace.name value for this agent. */
  traceName: Type.Optional(Type.String()),
  /** Langfuse tags that identify this agent's traces. */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Override the JSON field used to extract agentId from raw Langfuse records. */
  agentIdField: Type.Optional(Type.String()),
});

export const AgentPlatformOtelSchema = Type.Object({
  /** OpenTelemetry service.name resource attribute value. */
  serviceName: Type.Optional(Type.String()),
  /** Additional OTEL resource attributes that narrow the agent identity. */
  resourceAttrs: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const AgentIdentitySchema = Type.Object({
  /** Canonical code-level agent name (matches the entity you pass to parse-brief). */
  name: Type.String(),
  /** Langfuse-specific identity pointers for this agent. */
  langfuse: Type.Optional(AgentPlatformLangfuseSchema),
  /** OTel-specific identity pointers for this agent. */
  otel: Type.Optional(AgentPlatformOtelSchema),
});

export type AgentIdentity = Static<typeof AgentIdentitySchema>;

// ─────────────────────────────────────────────────────────────────────────────

export const DiagnosticsConfigSchema = Type.Object({
  /**
   * v0.2.0: `source` / `target` are GONE — the diagnostics skill binds a
   * `global.sources[]` (source-consumer role) + a `global.targets[]`
   * (target-writer role) resolved in load.ts. `schedule` / `trigger_rules` /
   * `heartbeat` moved to the top-level `triggers.<stage>` block.
   *
   * PHASE 4 — stage-specific context links (triage runbook), loaded at run start
   * alongside `global.context[]`. Orchestrator-typed (parity with the
   * orchestrator's `LifecycleDiagnosticsSchema.context`).
   */
  context: Type.Optional(Type.Array(ContextLinkSchema)),
  /**
   * PHASE 1 — the report-only gate the orchestrator reads: `report-only` ⇒ produce
   * the report, skip the target/apply gate (no target needed). Free `string` at the
   * skill level to mirror the orchestrator's permissive `apply` field; the apply
   * kinds themselves are enum-checked at the target (`ApplySchema.kind`).
   */
  apply: Type.Optional(Type.String({ minLength: 1 })),
  ask_tool: AskToolConfigSchema,
  self_diagnostics: Type.Optional(SelfDiagnosticsConfigSchema),
  /**
   * v0.3 run-tagging: default tags applied to EVERY diagnostic run.
   * Useful for filtering in diagnostics-history by feature, milestone, or environment.
   * Examples: ["production", "search-agent"] or ["self-diagnostics", "internal"]
   */
  run_tags: Type.Optional(Type.Array(Type.String())),
  /**
   * PRD-SO-02 + Phase-2 self-diag: opt-in feedback source collection.
   * When enabled, findings are enriched with feedbackSources[] from chat, trace
   * scores, and/or external platforms before render (D5).
   * Defaults to disabled. Opt-in explicitly per Q11.
   */
  feedback_sources: Type.Optional(FeedbackSourcesConfigSchema),
  /**
   * W11-07: Optional agent identity map — cross-platform join keys so the skill
   * can resolve a code-level agent name to its observability identifiers on
   * Langfuse (trace.name / tags / agentIdField) and OTel (service.name / attrs).
   *
   * ADDITIVE + OPTIONAL: absent in existing configs (backward-compatible).
   * Populate when your agent appears under different names across platforms.
   * The identity for the diagnosed agent (from parse-brief.entity) is looked up
   * here and injected into EntityContext.identity at Step 3.7.
   *
   * Example:
   *   agents:
   *     - name: search-agent
   *       langfuse: { traceName: "search-v2", tags: ["prod"] }
   *       otel: { serviceName: "search-svc" }
   */
  agents: Type.Optional(Type.Array(AgentIdentitySchema)),
  /**
   * W13-D (operator directive): the audience used for the rendered report when no
   * explicit `--audience` flag is passed to the renderer.
   *
   * ADDITIVE + OPTIONAL (backward-compatible — absent in pre-W13-D configs).
   * Schema default is "client": a fresh `init` writes `default_audience: client`
   * so a published/client install produces the client-stripped report by default;
   * internal is opt-in. The orchestrator threads this value as
   * `--audience <config.default_audience>` at the Step-9 render invocation when the
   * operator gave no explicit flag.
   *
   * Effective-default precedence at render time:
   *   explicit `--audience` flag  >  config.default_audience  >  renderer fallback ("internal").
   * The renderer's own argv default stays "internal" (safe when neither config nor
   * flag is present); the config default makes a fresh init effectively "client".
   *
   * NEVER overrides PR-022: an `isMetaReport` (self-diag) render is ALWAYS internal.
   */
  default_audience: Type.Optional(DefaultAudienceSchema),
});

export type DiagnosticsConfig = Static<typeof DiagnosticsConfigSchema>;
export type TraceFilter = Static<typeof TraceFilterSchema>;
