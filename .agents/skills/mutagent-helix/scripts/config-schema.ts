import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { parse as parseYaml } from "yaml";

import { AdlStage } from "./handover-contract.ts";
import { resolveConfigPath } from "./resolve-paths.ts";

// ---------------------------------------------------------------------------
// C1-C3 — the MutagentConfig schema for the LOCAL `.mutagent/config.yaml` (v0.2.0).
//
// ONE config file drives the orchestrator + all skills. The v0.2.0 contract has
// THREE top-level blocks (the false `stages` (phase) vs skill (tool) axis is
// collapsed — every skill IS a stage, so the config is keyed by SKILL under a
// single `lifecycle` block):
//
//   global    — framework-wide SHARED resources (helix owns; TYPED): provider
//               credential REFS · repo/workspace · default + judge models ·
//               brand/theme · PROJECT-WIDE context links · the SOURCES catalog
//               (where traces come from) · the TARGETS catalog (where fixes are
//               applied). Sources/targets are bound BY ROLE, not by ref — a
//               source-consumer (evaluate/diagnose) binds `global.sources`, a
//               target-writer (build/diagnose-apply) binds `global.targets`.
//   lifecycle — per-skill behavior, NESTED + keyed by SKILL NAME (agentspec ·
//               builder · evaluator · diagnostics). The orchestrator TYPES only
//               the gate-relevant fields (`spec_dir` / `context` / `apply` /
//               `judge_runtime`); everything else is the skill's OPAQUE knobs
//               (passthrough — each standalone skill validates its OWN section
//               with its OWN schema, NEVER cross-imported).
//   triggers  — the FUTURE monitor, GLOBAL per stage. Ships DISABLED
//               (enabled:false, empty rules). Absorbs the old diagnostics
//               schedule / trigger_rules / heartbeat (now IN the trigger block).
//
// SHAPE vs COMPLETENESS — a deliberate split (unchanged from v0.1.0):
//   - This SCHEMA enforces SHAPE only: closed objects at the levels the
//     orchestrator owns, correct types, the frozen version, valid enum values.
//     A present provider must carry both `name` and `credentials_ref`.
//   - It does NOT enforce onboarding completeness. The sub-fields of `global`
//     are OPTIONAL so a PARTIAL, mid-onboarding config still validates
//     STRUCTURALLY. Whether a config is COMPLETE (has creds, a repo, models, a
//     resolvable source/target for the invoked stage) is the job of
//     scripts/onboarding-check.ts + scripts/gate.ts.
//   - The per-skill `lifecycle.<skill>` sections are OPEN (additionalProperties:
//     true) beyond the typed gate fields — the skill owns the rest.
//   - Consequence (by design): a raw-secret-SHAPED `credentials_ref` still
//     validates structurally — the schema cannot tell a leaked secret from an
//     env-var ref. The no-raw-secret rule is a CONVENTION enforced by docs +
//     review; fixtures use env-var NAMES only.
//
// Design invariants (mirror scripts/handover-contract.ts + scripts/sync-index.ts):
//   - Pure functions + a thin CLI wrapper. No clock, no random, no network.
//   - `loadConfig` reads an INJECTED path — never resolved here. Path resolution
//     (the LOCAL install-dir `.mutagent/`, via resolve-paths.ts) happens only in
//     the thin CLI, never in the pure core, so tests stay deterministic against
//     committed fixtures.
//
// NOTE: the per-stage keys of `triggers` reuse the ROUTING `AdlStage` enum
// exported from handover-contract.ts (same package — allowed). That set
// (build|evaluate|diagnose|optimize|audit) is the routed-ACTION classification;
// it intentionally differs from sync-index.ts's directory-CLASSIFICATION enum.
// Don't conflate.
// ---------------------------------------------------------------------------

/**
 * The FROZEN config-contract version. Bump only via an explicit migration.
 * v0.2.0 → v0.3.0 (#1202 coordinated pass): drop `code` from `TargetSubject` (the deferred
 * FU-69 §1.7 / ORCH-08 cleanup — substrate lives on `artifact.format`). The `triggers` block
 * gains the `ship` key for free (it reuses the routing `AdlStage` enum). No backwards-compat
 * obligation — a v0.2.0 config is now LEGACY (migration-required).
 */
export const CONFIG_VERSION = "0.3.0" as const;

/**
 * The legacy version(s) whose configs must NOT be parsed at runtime — the loader
 * detects them and emits `{ ok:false, legacy:true }` so the caller can route to
 * `migration-required`. Hard-cut: no static migrate script, no old-shape parse.
 */
export const LEGACY_CONFIG_VERSIONS = ["0.1.0", "0.2.0"] as const;

// ── Categorical constants (no magic strings) ────────────────────────────────

/**
 * Source platforms a `global.sources[]` entry can pull traces from. Closed enum →
 * the config audit can detect an undeclared / typo'd platform. Mirrors the
 * source platforms the diagnostics + evaluator skills support.
 */
export const SourcePlatform = {
  Langfuse: "langfuse",
  Otel: "otel",
  LocalJsonl: "local-jsonl",
  ClaudeCode: "claude-code",
  Codex: "codex",
} as const;
export type SourcePlatformValue =
  (typeof SourcePlatform)[keyof typeof SourcePlatform];

/**
 * Normalizer format hint for a source (how to parse the records). Consumed by the
 * source-fetch/normalize path in `@mutagent/tools` (+ the evaluator/diagnostics
 * fetch ports) to pick the per-platform record parser.
 *
 * `unitf` (F1) is the pass-through format: the records are ALREADY conformant
 * UniTF jsonl (emitted by the code-run capture WRAP), so the fetch path SKIPS
 * per-platform normalization and reads the jsonl directly. Pairs with
 * `platform: local-jsonl` + `paths: […]`.
 */
export const SourceFormat = {
  LangfuseExport: "langfuse-export",
  ClaudeCode: "claude-code",
  Codex: "codex",
  Raw: "raw",
  /** Pre-normalized UniTF jsonl — read directly, skip per-platform normalize (F1). */
  Unitf: "unitf",
} as const;
export type SourceFormatValue = (typeof SourceFormat)[keyof typeof SourceFormat];

/** Latency-unit override for a source (`auto` = infer from the record). */
export const LatencyUnit = {
  Auto: "auto",
  Ms: "ms",
  S: "s",
} as const;
export type LatencyUnitValue = (typeof LatencyUnit)[keyof typeof LatencyUnit];

/**
 * Target platforms a `global.targets[]` entry can write a fix TO. Closed enum.
 * Local-agent markdown, local code-construct frameworks, a local SKILL directory,
 * cloud REST, or a report-only sink (no target write).
 */
export const TargetPlatform = {
  LocalClaude: "local-claude",
  LocalCodex: "local-codex",
  LocalCursor: "local-cursor",
  LocalOpencode: "local-opencode",
  LocalMastra: "local-mastra",
  LocalCloudAgentSdk: "local-cloud-agent-sdk",
  // A local SKILL directory (SKILL.md + references + assets). A skill is NOT one
  // .md-per-agent — its target root is the skill DIR; it applies via the SAME
  // markdown worktree-PR path (no build), its skillspec is the .meta/prd.yaml (D2).
  LocalSkill: "local-skill",
  CloudRest: "cloud-rest",
  ReportOnly: "report-only",
} as const;
export type TargetPlatformValue =
  (typeof TargetPlatform)[keyof typeof TargetPlatform];

/**
 * What KIND of subject a target writes to (D2 subject-kind axis). `agent` = a
 * single .md / code-construct agent (the historical default). `skill` = a skill
 * directory whose SSoT is its `.meta/prd.yaml` (the annexed skillspec) — routed
 * to skill-builder's wave, applied via the markdown transport.
 *
 * FU-69 §1.7 / ORCH-08 CLEANUP (DONE in v0.3.0, #1202): `code` was dropped from this union.
 * "This target is code" is now the SUBSTRATE axis `artifact.format: "code"` (below), not a
 * `subject` value — a code target is `subject: agent|skill` × `artifact.format: code`, applied via
 * `apply.kind: code-pr`. Optional on a target entry; absent ⇒ `agent`.
 */
export const TargetSubject = {
  Agent: "agent",
  Skill: "skill",
} as const;
export type TargetSubjectValue =
  (typeof TargetSubject)[keyof typeof TargetSubject];

/**
 * The SUBSTRATE axis (S15 / FU-69 §1.2) — how a target's subject is realized (mirrors AgentSpec
 * `targets[].artifact.format` + optimize `ARTIFACT_FORMATS`): `code` = source with a test suite (the
 * ⑤ OPTIMIZE code-quality BOTH-gate + a `code-pr` apply); `markdown` = prompt/.md (markdown apply);
 * `platform-config` = hosted (cloud-deploy apply). ApplyKind DERIVES from this (FU-69 §1.4).
 *
 * This is the SOLE home of the `code` substrate now that the FU-69 §1.7 / ORCH-08 cleanup dropped
 * `code` from `subject` (v0.3.0, #1202) — a code target is `subject: agent|skill` × `artifact.format:
 * code`. Added ALONGSIDE `subject`; ApplyKind DERIVES from this (FU-69 §1.4).
 */
export const ArtifactFormat = {
  Code: "code",
  Markdown: "markdown",
  PlatformConfig: "platform-config",
} as const;
export type ArtifactFormatValue =
  (typeof ArtifactFormat)[keyof typeof ArtifactFormat];

/** Whether a target's writes go through local files (worktree) or a remote API. */
export const TargetMode = {
  Local: "local",
  Remote: "remote",
} as const;
export type TargetModeValue = (typeof TargetMode)[keyof typeof TargetMode];

/**
 * HOW a fix is applied to a target (`report-only` ⇒ no target write).
 *
 * `apply.kind` BINDS to a `mutagent-cli apply` TARGET ADAPTER (DC-5), not a prose
 * recipe (see `@mutagent/tools` src/apply/binding.ts `adapterIdForKind`):
 *   code-pr      → worktree-PR adapter (git worktree → lint/typecheck → PR)
 *   markdown     → worktree-PR adapter (NO build — .md agent AND skill dir path)
 *   cloud-deploy → REST adapter (non-destructive create-rev + activate) OR vendor-CLI
 *   report-only  → report-only adapter (read + dryRun only; no write)
 * The shared CLI is the transport; the skill layer gates BEFORE it (DC-1). Adding
 * a new ApplyKind here requires a matching adapter branch in binding.ts.
 */
export const ApplyKind = {
  CodePr: "code-pr",
  Markdown: "markdown",
  CloudDeploy: "cloud-deploy",
  ReportOnly: "report-only",
} as const;
export type ApplyKindValue = (typeof ApplyKind)[keyof typeof ApplyKind];

// ── Shared building-block schemas ────────────────────────────────────────────

/**
 * A credential REFERENCE — an ENV-VAR NAME (string) or an object that also pins
 * an explicit file to read first (`{ env, path? }`). NEVER a raw secret value
 * (no-raw-secret contract; enforced by convention + review, not by the schema).
 * Mirrors the `CredentialRef` type in scripts/resolve-credential.ts (same package).
 */
export const CredentialRefSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      // Env-var NAME to read the secret from. Consumer: resolve-credential.ts.
      env: Type.String({ minLength: 1 }),
      // Optional dotenv file to source FIRST before the process env. Consumer:
      // resolve-credential.ts (explicit-file-then-env precedence).
      path: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);
export type CredentialRefValue = Static<typeof CredentialRefSchema>;

/**
 * A PROJECT-WIDE (or stage-specific) context link — a pointer to a supplementary
 * doc with the WHAT / WHY / WHEN so a skill knows what it is, why it matters, and
 * when to consult it. All four fields REQUIRED (a link with no rationale is noise).
 */
export const ContextLinkSchema = Type.Object(
  {
    // Relative path to the supplementary doc. Consumer: the skills (evaluator /
    // diagnostics) load it as stage context; the orchestrator passes it through.
    path: Type.String({ minLength: 1 }),
    // WHAT the doc is (one line). Consumer: the loading skill's context banner.
    what: Type.String({ minLength: 1 }),
    // WHY it matters. Consumer: the loading skill (relevance rationale).
    why: Type.String({ minLength: 1 }),
    // WHEN to consult it. Consumer: the loading skill (load-timing hint).
    when: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ContextLink = Static<typeof ContextLinkSchema>;

// ── `global` — framework-wide shared resources (orchestrator-typed) ───────────

/**
 * A provider credential REFERENCE — `credentials_ref` is an env-var NAME (or a
 * `{env,path}` ref), never a raw secret value. A present provider must carry both.
 */
export const ProviderSchema = Type.Object(
  {
    // Provider id (e.g. `anthropic` / `google`). Consumer: resolve-credential.ts +
    // the in-house judge runtime (evaluator) provider wiring.
    name: Type.String({ minLength: 1 }),
    // Env-var NAME (or {env,path}) for the provider key — NEVER a raw secret.
    // Consumer: onboarding-check.ts (provider floor) + resolve-credential.ts.
    credentials_ref: CredentialRefSchema,
  },
  { additionalProperties: false },
);
export type Provider = Static<typeof ProviderSchema>;

/** Repo + workspace location. Relative `path` only (determinism: never absolute). */
export const WorkspaceSchema = Type.Object(
  {
    // The target repo slug. Consumer: onboarding-check.ts (target-writing floor
    // requires it) + the build/diagnose-apply worktree setup.
    repo: Type.Optional(Type.String({ minLength: 1 })),
    // Relative workspace path (never absolute — determinism). Consumer:
    // resolve-paths.ts (locates the install/init dir).
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Workspace = Static<typeof WorkspaceSchema>;

/**
 * The default model + the pinned judge model. `judge_model` (renamed from
 * `pinned_judge` in v0.2.0) is the C-PIN pinned judge stamped on every scorecard;
 * `agent-dispatch` judge_runtime ⇒ the host runtime's model (no provider key).
 */
export const ModelsSchema = Type.Object(
  {
    // The default execution model + the JUDGE FALLBACK (used when `judge_model` is
    // unset). Consumer: onboarding-check.ts (default-model floor for evaluate/build)
    // + the evaluator run. ASYMMETRY: diagnostics IGNORES `models.default` — it runs
    // host-runtime agent-dispatch, so a default model is not part of its floor.
    default: Type.Optional(Type.String({ minLength: 1 })),
    // The C-PIN pinned judge model stamped on every scorecard (renamed from
    // `pinned_judge` in v0.2.0). Consumer: onboarding-check.ts (judge base floor for
    // evaluate/audit) + the evaluator scorecard stamp.
    judge_model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Models = Static<typeof ModelsSchema>;

/**
 * Dashboard brand / theme styling. REPORT STYLING only — consumed by the styled
 * HTML report renderers (evaluator + diagnostics report tabs) for the adapter-logo
 * look-and-feel. Has NO effect on gating/onboarding (purely cosmetic).
 */
export const BrandSchema = Type.Object(
  {
    // The theme name the report renderers key their palette/logo off. Consumer:
    // the evaluator/diagnostics HTML report renderers (styling only).
    theme: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Brand = Static<typeof BrandSchema>;

/**
 * One SOURCE catalog entry — where traces live. Bound BY ROLE (source-consumers
 * evaluate/diagnose bind `global.sources`); a single entry auto-binds. When
 * MULTIPLE exist, an entry marked `default: true` is auto-selected (the SELECTION
 * contract); with no default, the operator picks at RUN time (needs-selection).
 * `paths` (file sources) is mutually exclusive with `endpoint` (remote); the
 * schema tolerates both, onboarding cares.
 */
export const SourceSchema = Type.Object(
  {
    // The catalog key the operator names the source by. Consumer: onboarding-check.ts
    // (resolveSourceByRole surfaces `entry.name`) + the run-time confirm/pick prompt.
    name: Type.String({ minLength: 1 }),
    // Which platform the traces live on. Consumer: the `@mutagent/tools` fetch path
    // (+ evaluator/diagnostics fetch ports) picks the per-platform reader.
    platform: Type.Union([
      Type.Literal(SourcePlatform.Langfuse),
      Type.Literal(SourcePlatform.Otel),
      Type.Literal(SourcePlatform.LocalJsonl),
      Type.Literal(SourcePlatform.ClaudeCode),
      Type.Literal(SourcePlatform.Codex),
    ]),
    // SELECTION contract — a catalog entry marked `default: true` is auto-selected
    // when multiple sources exist. Exactly one default ⇒ resolved-default; >1 default
    // ⇒ multiple-defaults (config error); 0 defaults ⇒ needs-selection (pick at run).
    // Consumer: onboarding-check.ts resolveByRole; the run-time confirm/pick prompt.
    default: Type.Optional(Type.Boolean()),
    // Remote-platform project/workspace slug (e.g. the Langfuse project). Consumer:
    // the `@mutagent/tools` remote fetch path (scopes the query).
    project: Type.Optional(Type.String({ minLength: 1 })),
    // Remote-platform base URL (OTel/REST). Mutually exclusive with `paths` (file
    // sources). Consumer: the `@mutagent/tools` remote fetch path.
    endpoint: Type.Optional(Type.String({ minLength: 1 })),
    // Env-var NAME (or {env,path}) for the platform read token. Consumer:
    // resolve-credential.ts → the `@mutagent/tools` remote fetch path.
    credential_ref: Type.Optional(CredentialRefSchema),
    // File-source glob(s) (mutually exclusive with `endpoint`). Consumer: the
    // `@mutagent/tools` local-jsonl / unitf reader.
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // How to PARSE the records (see SourceFormat). `unitf` ⇒ read jsonl direct, skip
    // normalize (F1). Consumer: the `@mutagent/tools` normalize path.
    format: Type.Optional(
      Type.Union([
        Type.Literal(SourceFormat.LangfuseExport),
        Type.Literal(SourceFormat.ClaudeCode),
        Type.Literal(SourceFormat.Codex),
        Type.Literal(SourceFormat.Raw),
        Type.Literal(SourceFormat.Unitf),
      ]),
    ),
    // Which record field carries the agent name (for per-agent grouping). Consumer:
    // the evaluator/diagnostics agent-variance grouping.
    agent_field: Type.Optional(Type.String({ minLength: 1 })),
    // Latency-unit override (`auto` = infer per record). Consumer: the
    // `@mutagent/tools` normalize path (latency projection).
    latency_unit: Type.Optional(
      Type.Union([
        Type.Literal(LatencyUnit.Auto),
        Type.Literal(LatencyUnit.Ms),
        Type.Literal(LatencyUnit.S),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type Source = Static<typeof SourceSchema>;

/**
 * A precise link to an Agent / Tooling definition file in a code target.
 * RESERVED — consumed by Build/Optimize (future): the realized-implementation link
 * a *build/*optimize run records so a fix targets the right file. Not read by any
 * current orchestrator floor.
 */
export const CodeRefSchema = Type.Object(
  {
    // RESERVED (Build/Optimize, future) — path to the agent/tooling def file.
    path: Type.String({ minLength: 1 }),
    // RESERVED (Build/Optimize, future) — why this file realizes the spec.
    why: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CodeRef = Static<typeof CodeRefSchema>;

/** HOW a fix is applied for a target. `kind` gates the report-only branch. */
export const ApplySchema = Type.Object(
  {
    // HOW a fix is applied. `report-only` gates OUT the target/apply floor.
    // Consumer: onboarding-check.ts diagnosticsIsReportOnly (compares
    // lifecycle.diagnostics.apply, the string form) + the diagnose-apply worker.
    kind: Type.Union([
      Type.Literal(ApplyKind.CodePr),
      Type.Literal(ApplyKind.Markdown),
      Type.Literal(ApplyKind.CloudDeploy),
      Type.Literal(ApplyKind.ReportOnly),
    ]),
    // RESERVED — consumed by Build/Optimize (future): bump a version stamp on apply.
    versioning: Type.Optional(Type.Boolean()),
    // RESERVED — consumed by Build/Optimize (future): open a PR vs write in place.
    pr: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type Apply = Static<typeof ApplySchema>;

/**
 * One TARGET catalog entry — where agent defs live + how a fix is applied. Bound
 * BY ROLE (target-writers build/diagnose-apply bind `global.targets`); a single
 * entry auto-binds. When MULTIPLE exist, an entry marked `default: true` is
 * auto-selected (the SELECTION contract); with no default, the operator picks at
 * RUN time (needs-selection).
 */
export const TargetSchema = Type.Object(
  {
    // The catalog key the operator names the target by. Consumer: onboarding-check.ts
    // (resolveTargetByRole surfaces `entry.name`) + the run-time confirm/pick prompt.
    name: Type.String({ minLength: 1 }),
    // Which platform a fix is written TO. Consumer: the diagnose-apply worker (+
    // builder) picks the local-markdown / code-construct / cloud-REST writer.
    platform: Type.Union([
      Type.Literal(TargetPlatform.LocalClaude),
      Type.Literal(TargetPlatform.LocalCodex),
      Type.Literal(TargetPlatform.LocalCursor),
      Type.Literal(TargetPlatform.LocalOpencode),
      Type.Literal(TargetPlatform.LocalMastra),
      Type.Literal(TargetPlatform.LocalCloudAgentSdk),
      Type.Literal(TargetPlatform.LocalSkill),
      Type.Literal(TargetPlatform.CloudRest),
      Type.Literal(TargetPlatform.ReportOnly),
    ]),
    // What KIND of subject this target writes to — `agent` (default), `skill`
    // (D2). A `skill` subject's root is the skill DIR; its SSoT is .meta/prd.yaml
    // (the annexed skillspec); it applies via the markdown transport (no build).
    // A code target is `subject: agent|skill` × `artifact_format: code` (the
    // substrate axis below) — a spec-FIRST framework/harness impl (def→impl cascade)
    // applied via `apply.kind: code-pr` (full TDD in the worktree); the ⑤ OPTIMIZE
    // loop's "converged" for it is BOTH test-green AND a code-quality evaluator
    // verdict. Optional — absent ⇒ agent (back-compatible). Consumer: the apply
    // on-ramp (skill amends route to skill-builder's wave; code amends route
    // spec-first through ai-engineer) + onboarding-check.
    subject: Type.Optional(
      Type.Union([
        Type.Literal(TargetSubject.Agent),
        Type.Literal(TargetSubject.Skill),
      ]),
    ),
    // The SUBSTRATE axis (OPTIONAL, ADDITIVE — S15 / FU-69 §1.2). Added ALONGSIDE `subject`: declares
    // how this target's subject is realized so the ⑤ OPTIMIZE code-quality gate + the apply on-ramp
    // route by substrate (`artifact_format === "code"`). This is the SOLE home of the `code` substrate
    // now that the §1.7 / ORCH-08 cleanup dropped `code` from `subject` (v0.3.0, #1202). Absent ⇒
    // markdown/agent default inferred downstream. ApplyKind derives from this (FU-69 §1.4).
    artifact_format: Type.Optional(
      Type.Union([
        Type.Literal(ArtifactFormat.Code),
        Type.Literal(ArtifactFormat.Markdown),
        Type.Literal(ArtifactFormat.PlatformConfig),
      ]),
    ),
    // SELECTION contract — a catalog entry marked `default: true` is auto-selected
    // when multiple targets exist. Exactly one default ⇒ resolved-default; >1 default
    // ⇒ multiple-defaults (config error); 0 defaults ⇒ needs-selection (pick at run).
    // Consumer: onboarding-check.ts resolveByRole; the run-time confirm/pick prompt.
    default: Type.Optional(Type.Boolean()),
    // Whether writes go through local files (worktree) or a remote API. Consumer:
    // the diagnose-apply worker (local-diff vs REST-PUT branch).
    mode: Type.Union([
      Type.Literal(TargetMode.Local),
      Type.Literal(TargetMode.Remote),
    ]),
    // Local-target root dir the fix writes under (e.g. `.claude/agents`). Consumer:
    // the diagnose-apply worker (local mode).
    root: Type.Optional(Type.String({ minLength: 1 })),
    // Remote-target REST base URL. Consumer: the diagnose-apply worker (remote mode).
    rest_base_url: Type.Optional(Type.String({ minLength: 1 })),
    // Remote git repo URL (worktree clone source). Consumer: the diagnose-apply
    // worker (local-git-over-remote branch).
    repo_url: Type.Optional(Type.String({ minLength: 1 })),
    // RESERVED — consumed by Build/Optimize (future): the realized-implementation
    // links a *build/*optimize run records. Not read by any current floor.
    code_refs: Type.Optional(Type.Array(CodeRefSchema)),
    // Env-var NAME (or {env,path}) for the target write token. Consumer:
    // resolve-credential.ts → the diagnose-apply worker (remote mode).
    credential_ref: Type.Optional(CredentialRefSchema),
    // HOW the fix is applied (kind gates report-only). Consumer: onboarding-check.ts
    // + the diagnose-apply worker. See ApplySchema.
    apply: ApplySchema,
  },
  { additionalProperties: false },
);
export type Target = Static<typeof TargetSchema>;

/**
 * The GLOBAL cross-cutting resources. Sub-fields are OPTIONAL on purpose — a
 * partial, mid-onboarding config still validates structurally; completeness is
 * the onboarding check's concern, not the schema's. Renamed from `shared` in v0.2.0.
 */
export const GlobalSchema = Type.Object(
  {
    // Provider credential REFS. Consumer: onboarding-check.ts (provider floor) +
    // resolve-credential.ts.
    providers: Type.Optional(Type.Array(ProviderSchema)),
    // Repo + workspace location. Consumer: onboarding-check.ts (target floor) +
    // resolve-paths.ts.
    workspace: Type.Optional(WorkspaceSchema),
    // Default + pinned-judge models. Consumer: onboarding-check.ts (model floors) +
    // the evaluator run/scorecard.
    models: Type.Optional(ModelsSchema),
    // Report styling (cosmetic). Consumer: the evaluator/diagnostics report renderers.
    brand: Type.Optional(BrandSchema),
    // PROJECT-WIDE context links. Consumer: the skills load them as stage context.
    context: Type.Optional(Type.Array(ContextLinkSchema)),
    // The SOURCES catalog (where traces come from). Consumer: onboarding-check.ts
    // resolveSourceByRole + the evaluator/diagnostics fetch.
    sources: Type.Optional(Type.Array(SourceSchema)),
    // The TARGETS catalog (where fixes are applied). Consumer: onboarding-check.ts
    // resolveTargetByRole + the builder/diagnose-apply worker.
    targets: Type.Optional(Type.Array(TargetSchema)),
  },
  { additionalProperties: false },
);
export type Global = Static<typeof GlobalSchema>;

// ── `lifecycle` — per-skill config, keyed by SKILL NAME ───────────────────────
//
// The orchestrator TYPES only the gate-relevant fields per skill; the REST of
// each section is the skill's OPAQUE knobs. So each `lifecycle.<skill>` section
// is an OPEN object (additionalProperties:true) that pins the few fields the
// orchestrator reads and passes everything else through. Each standalone skill
// reads its OWN section + validates the rest with its OWN schema (never
// cross-imported — standalone + symbiosis invariant).

/** `lifecycle.agentspec` — the orchestrator reads `spec_dir` (where *spec writes). */
export const LifecycleAgentspecSchema = Type.Object(
  {
    // Where *spec writes the agentspec.yaml files. Consumer: the orchestrator +
    // the agentspec skill (spec_dir root).
    spec_dir: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true },
);
export type LifecycleAgentspec = Static<typeof LifecycleAgentspecSchema>;

/** `lifecycle.builder` — config-light (writes to a `global.target` by role). */
export const LifecycleBuilderSchema = Type.Object(
  {},
  { additionalProperties: true },
);
export type LifecycleBuilder = Static<typeof LifecycleBuilderSchema>;

/**
 * `lifecycle.evaluator` — the orchestrator reads `context` (stage-specific links)
 * + `judge_runtime` (renamed from `substrate`: how judges run —
 * agent-dispatch|in-house|code-based|user-framework). The rest (subject, datasets,
 * …) is the evaluator's opaque passthrough.
 */
export const LifecycleEvaluatorSchema = Type.Object(
  {
    // Stage-specific context links for evaluate. Consumer: the evaluator (loaded on
    // an evaluate run); the orchestrator passes them through.
    context: Type.Optional(Type.Array(ContextLinkSchema)),
    // HOW judges run (agent-dispatch|in-house|code-based|user-framework; renamed
    // from `substrate`). Consumer: gate.ts / onboarding-check.ts (in-house ⇒ the
    // provider floor) + the evaluator judge wiring.
    judge_runtime: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true },
);
export type LifecycleEvaluator = Static<typeof LifecycleEvaluatorSchema>;

/**
 * `lifecycle.diagnostics` — the orchestrator reads `apply` (the report-only gate:
 * `report-only` ⇒ produce report, skip the target/apply gate) + `context`. The
 * rest (ask_tool, self_diagnostics, run_tags, feedback_sources, agents,
 * default_audience, …) is the diagnostics skill's opaque passthrough. NOTE:
 * schedule/trigger_rules/heartbeat are NO LONGER here — they moved to top-level
 * `triggers.<stage>` in v0.2.0.
 */
export const LifecycleDiagnosticsSchema = Type.Object(
  {
    // The report-only gate: `report-only` ⇒ produce report, skip the target/apply
    // floor. Consumer: onboarding-check.ts diagnosticsIsReportOnly (compares against
    // ApplyKind.ReportOnly) + gate.ts (via the target floor).
    apply: Type.Optional(Type.String({ minLength: 1 })),
    // Stage-specific context links for diagnose. Consumer: the diagnostics skill;
    // the orchestrator passes them through.
    context: Type.Optional(Type.Array(ContextLinkSchema)),
  },
  { additionalProperties: true },
);
export type LifecycleDiagnostics = Static<typeof LifecycleDiagnosticsSchema>;

/**
 * The `lifecycle` block — one OPTIONAL sub-section per skill, keyed by skill name.
 * Closed at THIS level (only the four known skills), OPEN within each section.
 */
export const LifecycleSchema = Type.Object(
  {
    // *spec section — the orchestrator reads `spec_dir`. Consumer: agentspec skill.
    agentspec: Type.Optional(LifecycleAgentspecSchema),
    // *build section — config-light (writes by role to a global.target). Consumer:
    // builder skill (opaque passthrough).
    builder: Type.Optional(LifecycleBuilderSchema),
    // *evaluate section — orchestrator reads `context` + `judge_runtime`. Consumer:
    // evaluator skill.
    evaluator: Type.Optional(LifecycleEvaluatorSchema),
    // *diagnose section — orchestrator reads `apply` (report-only gate) + `context`.
    // Consumer: diagnostics skill.
    diagnostics: Type.Optional(LifecycleDiagnosticsSchema),
  },
  { additionalProperties: false },
);
export type Lifecycle = Static<typeof LifecycleSchema>;

// ── `triggers` — the future monitor (global, per stage, DISABLED) ─────────────

/**
 * One trigger rule (FUTURE monitor input). Closed → auditable. Minimal by
 * design: the consuming always-on monitor is out-of-scope this iteration, so
 * the shape is intentionally small (an event + an optional stage/command to run).
 */
export const TriggerRuleSchema = Type.Object(
  {
    // The event that fires the rule. Consumer: RESERVED — the FUTURE always-on
    // monitor (out-of-scope this iteration; ships disabled).
    on: Type.String({ minLength: 1 }),
    // The stage/command to run when it fires. Consumer: RESERVED — future monitor.
    run: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type TriggerRule = Static<typeof TriggerRuleSchema>;

/**
 * When the monitor wakes. v0.1 ships `on-demand`. Absorbed from the old
 * diagnostics `schedule` (moved into the trigger block in v0.2.0).
 */
export const TriggerScheduleSchema = Type.Object(
  {
    // When the monitor wakes (v0.1 ships `on-demand`). Consumer: RESERVED — future monitor.
    mode: Type.String({ minLength: 1 }),
    // Optional wake time (cron-ish). Consumer: RESERVED — future monitor.
    at: Type.Optional(Type.String({ minLength: 1 })),
    // Optional timezone for `at`. Consumer: RESERVED — future monitor.
    timezone: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type TriggerSchedule = Static<typeof TriggerScheduleSchema>;

/**
 * Notify + cost cap for the monitor. Absorbed from the old diagnostics
 * `heartbeat` (moved into the trigger block in v0.2.0).
 */
export const TriggerHeartbeatSchema = Type.Object(
  {
    // Notify when a scan matches nothing. Consumer: RESERVED — future monitor.
    notify_on_zero_matches: Type.Optional(Type.Boolean()),
    // Notify when a scan matches. Consumer: RESERVED — future monitor.
    notify_on_matches: Type.Optional(Type.Boolean()),
    // Per-day cost cap on auto-diagnoses. Consumer: RESERVED — future monitor.
    max_diagnostics_per_day: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type TriggerHeartbeat = Static<typeof TriggerHeartbeatSchema>;

/**
 * A per-stage trigger block. Ships DISABLED: `enabled` defaults false, `rules`
 * defaults empty. `schedule` / `heartbeat` are OPTIONAL (moved in from the old
 * diagnostics section). No auto-fire / no cron — the always-on monitor is future
 * + out-of-scope (feedback_self_diagnostics_on_demand_only).
 */
export const TriggerStageBlockSchema = Type.Object(
  {
    // Master on/off for this stage's monitor (ships false). Consumer: RESERVED —
    // future monitor.
    enabled: Type.Boolean({ default: false }),
    // The trigger rules (ships empty). Consumer: RESERVED — future monitor.
    rules: Type.Array(TriggerRuleSchema, { default: [] }),
    // Optional wake schedule (moved in from the old diagnostics section). Consumer:
    // RESERVED — future monitor.
    schedule: Type.Optional(TriggerScheduleSchema),
    // Optional notify + cost cap (moved in from the old diagnostics section).
    // Consumer: RESERVED — future monitor.
    heartbeat: Type.Optional(TriggerHeartbeatSchema),
  },
  { additionalProperties: false },
);
export type TriggerStageBlock = Static<typeof TriggerStageBlockSchema>;

/** Per-stage trigger blocks, keyed by routing AdlStage. Every stage optional. */
export const TriggersSchema = Type.Object(
  {
    // Per-stage trigger blocks (keyed by routing AdlStage). ALL RESERVED — the
    // consuming always-on monitor is future + out-of-scope; every block ships
    // disabled. Consumer: RESERVED — future monitor.
    [AdlStage.Build]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Evaluate]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Diagnose]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Optimize]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Audit]: Type.Optional(TriggerStageBlockSchema),
    // ⑥ SHIP (#1202) — reserved like the rest; ships DISABLED. The always-on
    // `triggers.ship` monitor is a FUTURE runtime (ship PRD KP-6, out of MVP scope);
    // even enabled, INV-SHIP-1 makes the router refuse a non-operator ship dispatch.
    [AdlStage.Ship]: Type.Optional(TriggerStageBlockSchema),
  },
  { additionalProperties: false },
);
export type Triggers = Static<typeof TriggersSchema>;

/**
 * The full `.mutagent/config.yaml` contract (v0.2.0). Closed object — unknown
 * extras (including the DROPPED legacy keys `shared` / `stages` / top-level
 * `diagnostics` / `evaluator`) are rejected at THIS level, so a legacy config
 * fails structural validation too (belt-and-braces with loadConfig's legacy
 * detection).
 */
/**
 * `dogfood` — the hidden `*dogfood` observe surface's source binding.
 *
 * BUILD-PROJECT ≠ DOGFOOD-PROJECT (load-bearing). You DEVELOP Helix in one project
 * (e.g. the mutagent monorepo) but USE it + collect feedback in ANOTHER (e.g. a
 * hackathon / product repo). So `*dogfood` does NOT watch the current working dir's
 * sessions — it watches the DOGFOOD TARGET's Claude-Code session dir, set here.
 *
 *   dogfood:
 *     source_dir: "~/.claude/projects/-Users-you-path-to-DOGFOOD-project"   # NOT the build project
 *     session_glob: "*.jsonl"        # optional (default "*.jsonl")
 *     include_subagents: true        # optional (default true) — also tail dispatched subagent JSONLs
 *
 * `source_dir` is the ABSOLUTE path to the dogfood project's `~/.claude/projects/<enc(path)>/`
 * dir (Claude encodes the project cwd by replacing `/` with `-`). It is an ABSOLUTE
 * path BY DESIGN (a documented exception to the relative-paths rule — it points at a
 * SEPARATE project outside the workspace), so it is a plain String, never forced
 * relative. `*dogfood` with no sessionId picks the latest `*.jsonl` by mtime WITHIN this dir.
 */
/**
 * `dogfood.slack` — the "meta Slack notifications" block (DOG-3). When
 * `enabled`, `*dogfood` opens a LIVE Slack THREAD (root on start + threaded
 * replies on stage-change · agent-dispatch · feedback · progress). Absent /
 * disabled ⇒ NO Slack (HTML report only, never an error).
 *
 * Threading needs the Slack WEB API (`chat.postMessage` + `thread_ts`), so a
 * BOT TOKEN is required — NOT an incoming webhook. `token_ref` is the NAME of the
 * env var that holds the `xoxb-…` token (e.g. `SLACK_BOT_TOKEN`) — NEVER the raw
 * secret (same discipline as `credentials_ref`). `channel` is a Slack channel id.
 */
export const DogfoodSlackSchema = Type.Object(
  {
    enabled: Type.Boolean({ default: false }),
    // A Slack channel id (e.g. "C0123ABC") the bot is a member of.
    channel: Type.String({ minLength: 1 }),
    // The ENV-VAR NAME holding the bot token (xoxb-…) — a reference, never a secret.
    token_ref: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type DogfoodSlack = Static<typeof DogfoodSlackSchema>;

export const DogfoodSchema = Type.Object(
  {
    // The DOGFOOD TARGET project's Claude-Code session dir (NOT the build project's).
    // ABSOLUTE path by design (documented exception — a separate project's dir).
    source_dir: Type.String({ minLength: 1 }),
    session_glob: Type.Optional(Type.String({ minLength: 1 })), // default "*.jsonl"
    include_subagents: Type.Optional(Type.Boolean()), // default true — tail dispatched subagent JSONLs too
    // The forced re-render cadence in seconds (default 180 = 3 min); the watch
    // loop also re-renders on drift. A plain positive integer.
    cadence_seconds: Type.Optional(Type.Integer({ minimum: 1 })), // default 180
    // Optional live-thread Slack sink (DOG-3). Absent ⇒ no Slack.
    slack: Type.Optional(DogfoodSlackSchema),
  },
  { additionalProperties: false },
);
export type Dogfood = Static<typeof DogfoodSchema>;

/**
 * `monitor.slack` — the EXTERNAL Monitor's notification sink (EXT-1). The OUTWARD
 * monitor (`*monitor`) posts a discrete NOTIFICATION each time a `config.triggers`
 * rule fires. Mirrors `dogfood.slack` in shape + discipline but is a SEPARATE
 * block (a separate emitter, a separate voice — ADR-11/ADR-12): the dogfood block
 * drives a live THREAD, this one drives one-shot notifications.
 *
 * Closed object (unknown keys rejected). `token_ref` is the NAME of the env var
 * holding the `xoxb-…` bot token (e.g. `SLACK_BOT_TOKEN`) — NEVER the raw secret.
 * `channel` is a Slack channel id. Absent / disabled ⇒ no Slack (never an error).
 */
export const MonitorSlackSchema = Type.Object(
  {
    enabled: Type.Boolean({ default: false }),
    // A Slack channel id (e.g. "C0123ABC") the bot is a member of.
    channel: Type.String({ minLength: 1 }),
    // The ENV-VAR NAME holding the bot token (xoxb-…) — a reference, never a secret.
    token_ref: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type MonitorSlack = Static<typeof MonitorSlackSchema>;

/**
 * `monitor` — the EXTERNAL Monitor's config (EXT-1). Holds the OPTIONAL Slack
 * notification sink. The CONDITION source stays `triggers` (the dormant per-stage
 * rules) — `monitor` only adds the outward NOTIFICATION sink, keeping the trigger
 * rules and the notification channel cleanly separated. Closed object.
 */
export const MonitorSchema = Type.Object(
  {
    slack: Type.Optional(MonitorSlackSchema),
  },
  { additionalProperties: false },
);
export type Monitor = Static<typeof MonitorSchema>;

export const MutagentConfigSchema = Type.Object(
  {
    // The FROZEN contract version. Consumer: config-schema.ts (validateConfig literal
    // check + detectLegacyConfig).
    config_version: Type.Literal(CONFIG_VERSION),
    // Framework-wide shared resources. Consumer: onboarding-check.ts + gate.ts +
    // resolve-credential.ts + the skills.
    global: Type.Optional(GlobalSchema),
    // Per-skill behavior, keyed by skill name. Consumer: gate.ts / onboarding-check.ts
    // (typed gate fields) + each standalone skill (its own section).
    lifecycle: Type.Optional(LifecycleSchema),
    // The future monitor (per-stage, disabled). Consumer: RESERVED — future monitor.
    triggers: Type.Optional(TriggersSchema),
    // Hidden *dogfood observe surface — watches a SEPARATE dogfood-target project's
    // sessions (v2 surface, preserved). Consumer: scripts/dogfood/* (the *dogfood
    // surface). Note: the old skill-owned passthrough keys (`diagnostics` /
    // `evaluator`) are GONE in v0.2.0 — they moved under `lifecycle` (and now trip
    // legacy detection as top-level keys).
    dogfood: Type.Optional(DogfoodSchema),
    // External Monitor (*monitor / EXT-1) — the OUTWARD notification sink. Its
    // CONDITION source is the `triggers` block above; `monitor` only carries the
    // Slack notification channel. Ships DISABLED (triggers.<stage>.enabled:false).
    monitor: Type.Optional(MonitorSchema),
  },
  { additionalProperties: false },
);
export type MutagentConfig = Static<typeof MutagentConfigSchema>;

/**
 * The canonical DISABLED trigger block — the shipped default. The schema allows
 * `enabled:true` so a future monitor can opt in, but the shipped + onboarding
 * default is OFF with no rules (on-demand-only).
 */
export const DEFAULT_TRIGGER_BLOCK: TriggerStageBlock = {
  enabled: false,
  rules: [],
};

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

// Compiled checker — compiled once at module load.
const MutagentConfigChecker = TypeCompiler.Compile(MutagentConfigSchema);

/**
 * Validate an arbitrary value against the MutagentConfig contract.
 *
 * STRUCTURAL only — the compiled TypeBox checker. Catches missing / wrong-typed
 * / out-of-enum / non-frozen-version fields AND undeclared extra fields at every
 * orchestrator-owned level (additionalProperties:false). It deliberately does
 * NOT judge onboarding COMPLETENESS (that is checkOnboardingComplete's job) — so
 * a partial config and even a raw-secret-shaped credentials_ref pass here. Pure:
 * no I/O, no clock. Never throws — a non-object input yields ok:false.
 */
export function validateConfig(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!MutagentConfigChecker.Check(obj)) {
    for (const e of MutagentConfigChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── Legacy detection ──────────────────────────────────────────────────────────

/** The v0.1.0 top-level keys that must NOT appear in a v0.2.0 config. */
const LEGACY_TOP_LEVEL_KEYS = ["shared", "stages", "diagnostics", "evaluator"] as const;

/**
 * Detect a legacy (pre-v0.2.0) config WITHOUT parsing its old shape. Two signals,
 * either one fires:
 *   1. `config_version` is absent or a known legacy version (not the frozen 0.2.0).
 *   2. A legacy top-level key is present (`shared` / `stages` / a top-level
 *      `diagnostics` / `evaluator` skill section) OR any `*.observability` block
 *      survives (the old per-stage source binding).
 *
 * Returns the list of legacy markers found (empty ⇒ not legacy). Pure; tolerant
 * of a non-object input (returns []). Callers route a non-empty result to
 * `migration-required` (the migration DIRECTIVE, not a static script).
 */
export function detectLegacyConfig(obj: unknown): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const markers: string[] = [];

  const version = o.config_version;
  if (version !== CONFIG_VERSION) {
    if (typeof version === "string" && (LEGACY_CONFIG_VERSIONS as readonly string[]).includes(version)) {
      markers.push(`config_version: "${version}" (legacy — expected "${CONFIG_VERSION}")`);
    } else if (version === undefined) {
      markers.push(`config_version: absent (expected "${CONFIG_VERSION}")`);
    }
    // A NON-legacy, non-current version (e.g. a future "0.3.0") is NOT a legacy
    // marker — structural validation rejects it as a wrong literal instead.
  }

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (key in o) markers.push(`legacy top-level key '${key}'`);
  }

  // Any `*.observability` block anywhere under a stages-like map = legacy source binding.
  const stages = o.stages;
  if (stages !== null && typeof stages === "object") {
    for (const [stage, block] of Object.entries(stages as Record<string, unknown>)) {
      if (block !== null && typeof block === "object" && "observability" in (block as Record<string, unknown>)) {
        markers.push(`legacy '${stage}.observability' (source now binds by role via global.sources)`);
      }
    }
  }

  return markers;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export type LoadConfigResult =
  | { ok: true; config: MutagentConfig }
  | { ok: false; legacy: true; errors: string[] }
  | { ok: false; legacy?: false; errors: string[] };

/**
 * Read + YAML-parse + validate a config file at an INJECTED path. Guarded
 * parsing (mirrors sync-index.ts): a missing file, malformed YAML, a LEGACY
 * config, or a config that fails structural validation returns { ok:false, … } —
 * never throws.
 *
 * LEGACY DETECTION runs BEFORE structural validation: if the parsed object is a
 * legacy (pre-v0.2.0) config — wrong `config_version` OR any legacy key
 * (`shared` / `stages` / top-level `diagnostics`/`evaluator` / `*.observability`)
 * — the loader returns `{ ok:false, legacy:true, errors:[…] }`. Callers route
 * that to `migration-required` (the one-time migration DIRECTIVE). No old-shape
 * parse ever happens at runtime (Fork B: hard-cut).
 *
 * The path is taken VERBATIM: no resolution, no env lookup. Callers that want the
 * LOCAL `.mutagent/config.yaml` resolve it themselves via resolve-paths.ts (the
 * thin CLI does this); the pure core stays deterministic against committed
 * fixtures and never resolves a path on its own.
 */
export function loadConfig(configPath: string): LoadConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    return { ok: false, errors: [`cannot read ${configPath}: ${String(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, errors: [`malformed YAML in ${configPath}: ${String(err)}`] };
  }

  // Legacy detection FIRST — never parse the old shape at runtime.
  const legacyMarkers = detectLegacyConfig(parsed);
  if (legacyMarkers.length > 0) {
    return {
      ok: false,
      legacy: true,
      errors: [
        `legacy config detected in ${configPath} — migration required (see references/config-migration.md): ${legacyMarkers.join("; ")}`,
      ],
    };
  }

  const result = validateConfig(parsed);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, config: parsed as MutagentConfig };
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper. Validates a config file. With no path arg it resolves the
// LOCAL config at the install/init dir (nearest ancestor with `.mutagent/`),
// NEVER `~/.mutagent`:
//   bun run scripts/config-schema.ts [path]   (defaults to <root>/.mutagent/config.yaml)
// Exit 0 = valid; exit 1 = invalid / legacy / unreadable (errors on stdout).
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  const arg = argv.slice(2).find((a) => !a.startsWith("--"));
  const target = arg ?? resolveConfigPath();

  const result = loadConfig(path.resolve(target));
  if (result.ok) {
    console.info(`[config-schema] PASS — valid MutagentConfig v${CONFIG_VERSION} (${target}).`);
    return 0;
  }
  for (const e of result.errors) console.info(e);
  const label = "legacy" in result && result.legacy ? "MIGRATION REQUIRED" : "FAIL";
  process.stderr.write(
    `[config-schema] ${label} — ${result.errors.length} error(s) in ${target}.\n`,
  );
  return 1;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
