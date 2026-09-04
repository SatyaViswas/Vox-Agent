/**
 * scripts/config/schema.ts — the evaluator's FIRST config contract (v0.2.0).
 * ---------------------------------------------------------------------------
 * PORTED IN, standalone. The evaluator reads the UNIFIED local
 * `.mutagent/config.yaml` (operator decision 2026-06-29): ONE file drives the
 * orchestrator + every skill. This module TypeBox-types the two blocks the
 * evaluator reads:
 *
 *   global.sources[]   — the SOURCE catalog (where traces live). Bound BY ROLE
 *                        (the evaluator is a source-CONSUMER → it binds
 *                        `global.sources`). A single entry auto-binds; multiple
 *                        ⇒ disambiguation is deferred (Fork A).
 *   global.models      — { default, judge_model }. `judge_model` (renamed from
 *                        `pinned_judge` in v0.2.0) is the C-PIN pinned judge.
 *   lifecycle.evaluator — the evaluator's OWN section: `context[]` (stage-
 *                        specific links) + `judge_runtime` (renamed from
 *                        `substrate` in v0.2.0 — HOW judges run).
 *
 * SEALED-SIBLING (coding-rules): the source/target SHAPE is a PARITY PORT of
 * mutagent-orchestrator's `scripts/config-schema.ts` GlobalSourceSchema /
 * GlobalTargetSchema — NEVER cross-imported (like resolve-credential.ts). A
 * parity test asserts the shapes stay in lockstep.
 *
 * SHAPE vs COMPLETENESS (mirrors the orchestrator): this schema enforces SHAPE
 * only. Sub-fields of `global` are OPTIONAL so a partial, mid-onboarding config
 * still validates structurally. The per-skill `lifecycle.evaluator` section is
 * OPEN (additionalProperties:true) beyond the typed fields — the evaluator owns
 * the rest of its knobs; the orchestrator types only the gate-relevant ones.
 *
 * Determinism: pure schema + a `Value.Check` validator. No clock, no random, no
 * network. The loader (config/load.ts) reads an INJECTED path; the pure core
 * never resolves a path on its own (tests run against committed fixtures).
 *
 * NO raw secrets: a `credential_ref` is an env-var NAME (or `{env,path}`),
 * resolved at use-time via resolve-credential.ts (env → .env → .mutagentrc).
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The FROZEN config-contract version this loader understands. */
export const CONFIG_VERSION = "0.2.0" as const;

/** Legacy version(s) whose configs must NOT be parsed at runtime (hard-cut). */
export const LEGACY_CONFIG_VERSIONS = ["0.1.0"] as const;

// ── Categorical constants (no magic strings — coding-rules) ──────────────────

/**
 * Source platforms a `global.sources[]` entry can pull traces from.
 * CONSUMER: the trace-fetch layer (`mutagent-cli trace fetch`, run by Helix BEFORE
 * dispatch — the evaluator never fetches) selects the adapter by this value.
 * PURPOSE: names WHERE the subject's traces live so they can be normalized to UniTF.
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
 * Normalizer format hint for a source (how to parse the records).
 * CONSUMER: the trace-fetch/normalize layer (`@mutagent/tools` adapters) — picks the
 * parser for a source's records. PURPOSE: disambiguates record shape within a platform.
 *   `unitf` (F1) — the records are ALREADY conformant UniTF jsonl (e.g. emitted by the
 *   code-run capture WRAP, `captureUniTF` in `@mutagent/tools`). The fetch layer then
 *   SKIPS per-platform normalization and reads the jsonl DIRECTLY. Pairs with
 *   `platform: local-jsonl` + `paths:[…]`. PARITY PORT of the orchestrator's SourceFormat.
 */
export const SourceFormat = {
  LangfuseExport: "langfuse-export",
  ClaudeCode: "claude-code",
  Codex: "codex",
  Raw: "raw",
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

/** Target platforms a `global.targets[]` entry can write a fix TO. */
export const TargetPlatform = {
  LocalClaude: "local-claude",
  LocalCodex: "local-codex",
  LocalCursor: "local-cursor",
  LocalOpencode: "local-opencode",
  LocalMastra: "local-mastra",
  LocalCloudAgentSdk: "local-cloud-agent-sdk",
  CloudRest: "cloud-rest",
  ReportOnly: "report-only",
} as const;
export type TargetPlatformValue =
  (typeof TargetPlatform)[keyof typeof TargetPlatform];

/** Whether a target's writes go through local files (worktree) or a remote API. */
export const TargetMode = {
  Local: "local",
  Remote: "remote",
} as const;
export type TargetModeValue = (typeof TargetMode)[keyof typeof TargetMode];

/** HOW a fix is applied to a target (`report-only` ⇒ no target write). */
export const ApplyKind = {
  CodePr: "code-pr",
  Markdown: "markdown",
  CloudDeploy: "cloud-deploy",
  ReportOnly: "report-only",
} as const;
export type ApplyKindValue = (typeof ApplyKind)[keyof typeof ApplyKind];

// ── Shared building-block schemas (PARITY PORT — orchestrator config-schema) ──

/**
 * A credential REFERENCE — an ENV-VAR NAME (string) or `{ env, path? }`. NEVER a
 * raw secret value (mirrors resolve-credential.ts CredentialRef; no cross-import).
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

/**
 * A PROJECT-WIDE (or stage-specific) context link — a pointer to a supplementary
 * doc with WHAT / WHY / WHEN. All four fields REQUIRED (a link with no rationale
 * is noise).
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

/**
 * The default model + the pinned judge model (`judge_model` — was `pinned_judge`).
 * CONSUMER: config/load.ts `resolveJudgeModel` → prep.ts `--model` gap-fill.
 *   default     — the project-wide fallback judge model. PURPOSE: used ONLY when
 *                 `judge_model` is absent (`from: "default"`). ASYMMETRY: diagnostics
 *                 IGNORES `models.default` for its judge (it pins its own) — the field
 *                 is a shared config key that the two skills consume differently.
 *   judge_model — the C-PIN pinned judge (model-intent-sacred; temp pinned 0). PURPOSE:
 *                 the authoritative judge model; wins over `default` (`from: "judge_model"`).
 */
export const ModelsSchema = Type.Object(
  {
    default: Type.Optional(Type.String({ minLength: 1 })),
    judge_model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Models = Static<typeof ModelsSchema>;

/**
 * One SOURCE catalog entry — where traces live. PARITY PORT of the orchestrator's
 * GlobalSourceSchema. `paths` (file sources) is mutually exclusive with `endpoint`
 * (remote); the schema tolerates both — onboarding cares.
 */
export const GlobalSourceSchema = Type.Object(
  {
    // name — the catalog key. CONSUMER: config/load.ts `bindSourceByRole` (matched by
    // `--source <name>`) + prep.ts surface messages. PURPOSE: stable id for selection.
    name: Type.String({ minLength: 1 }),
    // platform — see SourcePlatform. CONSUMER: the fetch/normalize adapter selector.
    platform: Type.Union([
      Type.Literal(SourcePlatform.Langfuse),
      Type.Literal(SourcePlatform.Otel),
      Type.Literal(SourcePlatform.LocalJsonl),
      Type.Literal(SourcePlatform.ClaudeCode),
      Type.Literal(SourcePlatform.Codex),
    ]),
    // project — remote-source project/scope id. CONSUMER: the remote fetch adapter
    // (e.g. Langfuse project). PURPOSE: scopes a pull on a multi-project backend.
    project: Type.Optional(Type.String({ minLength: 1 })),
    // endpoint — remote base URL. CONSUMER: the remote fetch adapter. PURPOSE: where to
    // pull from (mutually exclusive with `paths`; onboarding enforces, schema tolerates).
    endpoint: Type.Optional(Type.String({ minLength: 1 })),
    // credential_ref — env-var NAME / {env,path} (NEVER a secret). CONSUMER: resolve-
    // credential.ts at fetch-time. PURPOSE: names the key for a remote pull.
    credential_ref: Type.Optional(CredentialRefSchema),
    // paths — file-source globs. CONSUMER: the local-jsonl fetch adapter. PURPOSE: the
    // on-disk jsonl location (pairs with `platform: local-jsonl`; see `format: unitf`).
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // format — see SourceFormat. CONSUMER: the normalize step (`unitf` ⇒ skip normalize,
    // read jsonl direct). PURPOSE: record-shape hint within a platform.
    format: Type.Optional(
      Type.Union([
        Type.Literal(SourceFormat.LangfuseExport),
        Type.Literal(SourceFormat.ClaudeCode),
        Type.Literal(SourceFormat.Codex),
        Type.Literal(SourceFormat.Raw),
        Type.Literal(SourceFormat.Unitf),
      ]),
    ),
    // agent_field — record path naming the agent/subject. CONSUMER: the normalizer's
    // subject-grouping. PURPOSE: which field identifies the agent when a trace is multi-agent.
    agent_field: Type.Optional(Type.String({ minLength: 1 })),
    // latency_unit — see LatencyUnit (`auto` = infer). CONSUMER: the normalizer's
    // latency projection. PURPOSE: overrides ambiguous ms-vs-s latency records.
    latency_unit: Type.Optional(
      Type.Union([
        Type.Literal(LatencyUnit.Auto),
        Type.Literal(LatencyUnit.Ms),
        Type.Literal(LatencyUnit.S),
      ]),
    ),
    // default — PARITY (orchestrator SourceSchema): the catalog's DEFAULT pick when >1
    // entry exists. CONSUMER: config/load.ts `bindSourceByRole` — exactly one `default:true`
    // ⇒ `confirm-default` (F2: preselected, operator confirms), not a silent bind. PURPOSE:
    // marks the preferred source among many. Optional: absent ⇒ no default.
    default: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type GlobalSource = Static<typeof GlobalSourceSchema>;

/**
 * A precise link to an Agent / Tooling definition file in a code target.
 * RESERVED — consumed by Build/Optimize (future). The evaluator is JUDGE-ONLY (EV-051)
 * and never writes a target; `targets[].code_refs` is ported for shape parity only and
 * has NO evaluator consumer today. PURPOSE (future): tells BUILD/OPTIMIZE which files
 * realize the agent so a fix lands on the right def.
 */
export const CodeRefSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    why: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CodeRef = Static<typeof CodeRefSchema>;

/**
 * HOW a fix is applied for a target. `kind` gates the report-only branch.
 * CONSUMER: the diagnostics APPLY path (not the evaluator — judge-only). PURPOSE:
 * selects the write mechanism for a fix.
 *   versioning / pr — RESERVED, consumed by Build/Optimize (future). No evaluator
 *                     consumer; ported for parity. PURPOSE (future): toggle spec-bump /
 *                     open-a-PR on apply.
 */
export const ApplySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal(ApplyKind.CodePr),
      Type.Literal(ApplyKind.Markdown),
      Type.Literal(ApplyKind.CloudDeploy),
      Type.Literal(ApplyKind.ReportOnly),
    ]),
    versioning: Type.Optional(Type.Boolean()),
    pr: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type Apply = Static<typeof ApplySchema>;

/**
 * One TARGET catalog entry — where agent defs live + how a fix is applied. PARITY
 * PORT of the orchestrator's GlobalTargetSchema. The evaluator is JUDGE-ONLY
 * (EV-051) so it never WRITES a target; it ports the shape for parity + so the
 * loader can validate a full `global` block without rejecting a present target.
 */
export const GlobalTargetSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    platform: Type.Union([
      Type.Literal(TargetPlatform.LocalClaude),
      Type.Literal(TargetPlatform.LocalCodex),
      Type.Literal(TargetPlatform.LocalCursor),
      Type.Literal(TargetPlatform.LocalOpencode),
      Type.Literal(TargetPlatform.LocalMastra),
      Type.Literal(TargetPlatform.LocalCloudAgentSdk),
      Type.Literal(TargetPlatform.CloudRest),
      Type.Literal(TargetPlatform.ReportOnly),
    ]),
    mode: Type.Union([
      Type.Literal(TargetMode.Local),
      Type.Literal(TargetMode.Remote),
    ]),
    root: Type.Optional(Type.String({ minLength: 1 })),
    rest_base_url: Type.Optional(Type.String({ minLength: 1 })),
    repo_url: Type.Optional(Type.String({ minLength: 1 })),
    code_refs: Type.Optional(Type.Array(CodeRefSchema)),
    credential_ref: Type.Optional(CredentialRefSchema),
    apply: ApplySchema,
    // PARITY (orchestrator TargetSchema): the catalog's DEFAULT pick when >1 entry
    // exists. The evaluator is JUDGE-ONLY (EV-051) and never binds a target, but the
    // shape stays in lockstep with the orchestrator (parity test). Optional.
    default: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type GlobalTarget = Static<typeof GlobalTargetSchema>;

/**
 * The GLOBAL cross-cutting resources the evaluator reads. Sub-fields OPTIONAL (a
 * partial mid-onboarding config still validates). The evaluator only READS
 * `models` + `sources` (+ `targets` for shape parity); the orchestrator owns the
 * rest of `global` (providers/workspace/brand/context) — passed through here as
 * OPEN so a full unified config doesn't fail the evaluator's structural check.
 */
export const GlobalSchema = Type.Object(
  {
    models: Type.Optional(ModelsSchema),
    context: Type.Optional(Type.Array(ContextLinkSchema)),
    sources: Type.Optional(Type.Array(GlobalSourceSchema)),
    targets: Type.Optional(Type.Array(GlobalTargetSchema)),
  },
  // OPEN: the orchestrator-owned global fields (providers/workspace/brand) pass
  // through — the evaluator doesn't type them but must not reject them.
  { additionalProperties: true },
);
export type Global = Static<typeof GlobalSchema>;

// ── `lifecycle.evaluator` — the evaluator's OWN section ───────────────────────

/**
 * `lifecycle.evaluator` — the evaluator's config section. The typed fields:
 *   context[]      — stage-specific supplementary context links (eval rubric).
 *   judge_runtime  — HOW judges run (renamed from `substrate` in v0.2.0):
 *                    agent-dispatch (DEFAULT) | in-house | code-based | user-framework.
 * OPEN (additionalProperties:true): the evaluator owns any further knobs
 * (subject profile path, dataset opts, …) — passthrough, validated elsewhere.
 */
export const LifecycleEvaluatorSchema = Type.Object(
  {
    context: Type.Optional(Type.Array(ContextLinkSchema)),
    judge_runtime: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true },
);
export type LifecycleEvaluator = Static<typeof LifecycleEvaluatorSchema>;

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

/** Validate a value against the evaluator's `global` block. Pure; never throws. */
export function validateGlobal(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!Value.Check(GlobalSchema, obj)) {
    for (const e of Value.Errors(GlobalSchema, obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Validate a value against `lifecycle.evaluator`. Pure; never throws. */
export function validateLifecycleEvaluator(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!Value.Check(LifecycleEvaluatorSchema, obj)) {
    for (const e of Value.Errors(LifecycleEvaluatorSchema, obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
