# `.mutagent/config.yaml` — Field Board (v0.2.0)

> The durable field map for the MutagentConfig contract. Every field · its block ·
> type · the consumer file(s) that READ it · its purpose · when it is required.
> Source of truth: `scripts/config-schema.ts` (the doc-comments there mirror this
> board). No field should read as "dead" — each row names a real consumer.
>
> **Consumer legend.** `onboarding-check.ts` / `gate.ts` / `resolve-credential.ts` /
> `resolve-paths.ts` / `dispatch.ts` live in this package (`mutagent-orchestrator`).
> `@mutagent/tools` is the shared trace layer (fetch + normalize). The SKILLS
> (evaluator / diagnostics / agentspec / builder) each read their own
> `lifecycle.<skill>` section + the shared `global` catalogs. RESERVED = shape is
> frozen but no current code path reads it (future Build/Optimize or the future
> monitor).

## Top level

| Field | Block | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|---|
| `config_version` | (root) | `"0.2.0"` literal | `config-schema.ts` (`validateConfig`, `detectLegacyConfig`) | The FROZEN contract version; wrong/absent ⇒ legacy or reject | ALWAYS |
| `global` | (root) | object | `onboarding-check.ts`, `gate.ts`, `resolve-credential.ts`, skills | Framework-wide shared resources | Optional (partial config validates) |
| `lifecycle` | (root) | object | `gate.ts`, `onboarding-check.ts`, each skill | Per-skill behavior, keyed by skill name | Optional |
| `triggers` | (root) | object | RESERVED — future monitor | The future always-on monitor (disabled) | Optional (ships disabled) |
| `dogfood` | (root) | object | `scripts/dogfood/*` (the `*dogfood` surface) | Watches a SEPARATE dogfood-target project's sessions | Optional |

## `global` — framework-wide shared resources

| Field | Block | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|---|
| `providers[]` | `global` | `Provider[]` | `onboarding-check.ts` (provider floor), `resolve-credential.ts` | Provider credential REFS | evaluate + `judge_runtime: in-house` |
| `providers[].name` | `global.providers` | string | `resolve-credential.ts`, in-house judge wiring | Provider id (`anthropic`/`google`) | when a provider entry exists |
| `providers[].credentials_ref` | `global.providers` | `string \| {env,path}` | `onboarding-check.ts`, `resolve-credential.ts` | Env-var NAME (never a raw secret) | when a provider entry exists |
| `workspace.repo` | `global.workspace` | string | `onboarding-check.ts` (target floor), build/apply worktree | The target repo slug | target-writing stage (build/optimize/diagnose-apply) |
| `workspace.path` | `global.workspace` | string (relative) | `resolve-paths.ts` | Locates the install/init dir | optional |
| `models.default` | `global.models` | string | `onboarding-check.ts` (default-model floor), evaluator run | Default execution model + JUDGE FALLBACK. **ASYMMETRY: diagnostics IGNORES it** (host-runtime agent-dispatch) | evaluate or a target-writing stage |
| `models.judge_model` | `global.models` | string | `onboarding-check.ts` (judge floor), evaluator scorecard stamp | C-PIN pinned judge (renamed from `pinned_judge`) | evaluate / audit (judging stages) |
| `brand.theme` | `global.brand` | string | evaluator/diagnostics HTML report renderers | REPORT STYLING only (cosmetic; no gating effect) | optional |
| `context[]` | `global` | `ContextLink[]` | the skills (loaded as stage context) | PROJECT-WIDE context links | optional |
| `context[].path/what/why/when` | `global.context` | string ×4 | loading skill's context banner | The doc + its WHAT/WHY/WHEN rationale | all four required per link |
| `sources[]` | `global` | `Source[]` | `onboarding-check.ts` (`resolveSourceByRole`), `@mutagent/tools` fetch | The SOURCES catalog (where traces come from) | diagnose (always) / evaluate (discover) |
| `targets[]` | `global` | `Target[]` | `onboarding-check.ts` (`resolveTargetByRole`), builder/diagnose-apply | The TARGETS catalog (where fixes go) | build / optimize(apply) / diagnose(apply, non-report-only) |

### `global.sources[]` — one catalog entry

| Field | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|
| `name` | string | `onboarding-check.ts`, run-time confirm/pick prompt | Catalog key | ALWAYS (per entry) |
| `platform` | enum `langfuse\|otel\|local-jsonl\|claude-code\|codex` | `@mutagent/tools` fetch (+ eval/diag ports) | Picks the per-platform reader | ALWAYS (per entry) |
| `default` | boolean | `onboarding-check.ts` `resolveByRole`, run-time prompt | SELECTION selector: one default among many ⇒ `resolved-default` | optional (only meaningful with multiple entries) |
| `project` | string | `@mutagent/tools` remote fetch | Remote project/workspace slug | remote platforms |
| `endpoint` | string | `@mutagent/tools` remote fetch | Remote base URL (mut. exclusive with `paths`) | remote (otel/rest) |
| `credential_ref` | `string \| {env,path}` | `resolve-credential.ts` → `@mutagent/tools` | Read token env-var NAME | remote platforms |
| `paths` | string[] | `@mutagent/tools` local-jsonl / unitf reader | File-source glob(s) (mut. exclusive with `endpoint`) | file sources |
| `format` | enum `langfuse-export\|claude-code\|codex\|raw\|unitf` | `@mutagent/tools` normalize path | How to parse records. **`unitf` (F1) ⇒ read jsonl direct, skip normalize** | optional (inferred otherwise) |
| `agent_field` | string | eval/diag agent-variance grouping | Which record field carries the agent name | optional |
| `latency_unit` | enum `auto\|ms\|s` | `@mutagent/tools` normalize (latency projection) | Latency-unit override (`auto` = infer) | optional |

### `global.targets[]` — one catalog entry

| Field | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|
| `name` | string | `onboarding-check.ts`, run-time confirm/pick prompt | Catalog key | ALWAYS (per entry) |
| `platform` | enum (local-claude/codex/cursor/opencode/mastra/cloud-agent-sdk, **local-skill**, cloud-rest, report-only) | `mutagent-cli apply` adapter (+ builder) | Picks the fix writer / adapter | ALWAYS (per entry) |
| `subject` | enum `agent\|skill` | apply on-ramp (skill amends → skill-builder wave), `onboarding-check.ts` | D2 subject-kind: `skill` root = skill DIR, SSoT = `.meta/prd.yaml` (annexed skillspec), markdown transport | optional (absent ⇒ `agent`) |
| `default` | boolean | `onboarding-check.ts` `resolveByRole`, run-time prompt | SELECTION selector: one default among many ⇒ `resolved-default` | optional (only with multiple entries) |
| `mode` | enum `local\|remote` | diagnose-apply worker | Local-diff vs REST-PUT branch | ALWAYS (per entry) |
| `root` | string | diagnose-apply worker (local mode) | Local root dir the fix writes under | local mode |
| `rest_base_url` | string | diagnose-apply worker (remote mode) | Remote REST base URL | remote/cloud-rest |
| `repo_url` | string | diagnose-apply worker (local-git-over-remote) | Remote git repo clone source | git-over-remote |
| `code_refs[]` | `CodeRef[]` | **RESERVED — Build/Optimize (future)** | Realized-implementation links a `*build`/`*optimize` run records | never (reserved) |
| `code_refs[].path/why` | string ×2 | **RESERVED — Build/Optimize (future)** | The impl file + why it realizes the spec | never (reserved) |
| `credential_ref` | `string \| {env,path}` | `resolve-credential.ts` → diagnose-apply | Target write token env-var NAME | remote mode |
| `apply` | `Apply` | `onboarding-check.ts`, diagnose-apply worker | HOW a fix is applied | ALWAYS (per entry) |
| `apply.kind` | enum `code-pr\|markdown\|cloud-deploy\|report-only` | `onboarding-check.ts` (`report-only` gates OUT the target floor), diagnose-apply | Apply strategy | ALWAYS (within `apply`) |
| `apply.versioning` | boolean | **RESERVED — Build/Optimize (future)** | Bump a version stamp on apply | never (reserved) |
| `apply.pr` | boolean | **RESERVED — Build/Optimize (future)** | Open a PR vs write in place | never (reserved) |

## `lifecycle.<skill>` — per-skill sections (open objects; only typed fields shown)

| Field | Block | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|---|
| `agentspec.spec_dir` | `lifecycle.agentspec` | string | orchestrator + agentspec skill | Where `*spec` writes agentspec.yaml | optional |
| `builder.*` | `lifecycle.builder` | open | builder skill (passthrough) | Config-light (writes by role to a target) | optional |
| `evaluator.context[]` | `lifecycle.evaluator` | `ContextLink[]` | evaluator skill | Stage-specific context for evaluate | optional |
| `evaluator.judge_runtime` | `lifecycle.evaluator` | string | `gate.ts`/`onboarding-check.ts` (provider floor), evaluator judge wiring | HOW judges run (renamed from `substrate`); `in-house` ⇒ provider floor | optional |
| `evaluator.*` (other) | `lifecycle.evaluator` | open | evaluator skill (passthrough) | subject/datasets/etc. — the skill's opaque knobs | optional |
| `diagnostics.apply` | `lifecycle.diagnostics` | string | `onboarding-check.ts` (`diagnosticsIsReportOnly`), `gate.ts` | Report-only gate: `report-only` ⇒ skip the target floor | optional |
| `diagnostics.context[]` | `lifecycle.diagnostics` | `ContextLink[]` | diagnostics skill | Stage-specific context for diagnose | optional |
| `diagnostics.*` (other) | `lifecycle.diagnostics` | open | diagnostics skill (passthrough) | ask_tool/run_tags/audience/etc. — opaque knobs | optional |

## `triggers.<stage>` — the future monitor (ALL RESERVED, ship disabled)

| Field | Block | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|---|
| `<stage>.enabled` | `triggers.<stage>` | boolean (default false) | RESERVED — future monitor | Master on/off per stage | never (ships false) |
| `<stage>.rules[]` | `triggers.<stage>` | `TriggerRule[]` (default []) | RESERVED — future monitor | The trigger rules | never (ships empty) |
| `<stage>.rules[].on` | `triggers.<stage>.rules` | string | RESERVED — future monitor | The event that fires the rule | never |
| `<stage>.rules[].run` | `triggers.<stage>.rules` | string | RESERVED — future monitor | Stage/command to run on fire | never |
| `<stage>.schedule.mode/at/timezone` | `triggers.<stage>.schedule` | string ×3 | RESERVED — future monitor | When the monitor wakes | never |
| `<stage>.heartbeat.notify_on_zero_matches` | `triggers.<stage>.heartbeat` | boolean | RESERVED — future monitor | Notify on empty scan | never |
| `<stage>.heartbeat.notify_on_matches` | `triggers.<stage>.heartbeat` | boolean | RESERVED — future monitor | Notify on match | never |
| `<stage>.heartbeat.max_diagnostics_per_day` | `triggers.<stage>.heartbeat` | integer ≥0 | RESERVED — future monitor | Per-day cost cap | never |

Stages keyed by the routing `AdlStage` enum: `build \| evaluate \| diagnose \| optimize \| audit`.

## `dogfood` — the hidden `*dogfood` observe surface

| Field | Block | Type | Consumer | Purpose | Required-when |
|---|---|---|---|---|---|
| `source_dir` | `dogfood` | string (ABSOLUTE by design) | `scripts/dogfood/*` | The DOGFOOD-target project's Claude-Code session dir (NOT the build project) | when `dogfood` block present |
| `session_glob` | `dogfood` | string | `scripts/dogfood/*` | Session glob (default `*.jsonl`) | optional |
| `include_subagents` | `dogfood` | boolean | `scripts/dogfood/*` | Also tail dispatched subagent JSONLs (default true) | optional |

---

## SELECTION contract — role binding (source + target)

Binding is BY ROLE (no `source_ref`/`target_ref`) over the `global.sources[]` /
`global.targets[]` catalog, under the `default` flag:

| Catalog shape | `resolveByRole` status | Bindable? | Run-time behavior |
|---|---|---|---|
| 0 entries | `none` | no | floor UNMET (`source/target-required`) |
| 1 entry | `resolved-single` | yes | auto-bind, NO prompt |
| many, exactly one `default: true` | `resolved-default` | yes | bind the default; run-time CONFIRMS (preselected, overridable) |
| many, no default | `needs-selection` | yes | operator PICKS at run time |
| many, >1 `default: true` | `multiple-defaults` | no | CONFIG ERROR (`source/target-config-error`) |

`resolved-single` and `resolved-default` (F2) are DISTINCT statuses but BOTH satisfy
the onboarding floor — the split only drives the run-time prompt (confirm vs
silent), never the gate. The confirm/pick prompts are a run-time skill concern, not
a `gate.ts` blocker.
