# Config migration directive — `.mutagent/config.yaml` v0.1.0 → v0.2.0

> **This is a DIRECTIVE, not a script.** There is no static migrate tool (Fork B:
> hard-cut). When the orchestrator detects a legacy config it emits
> `migration-required`; a coding agent (or the operator, under the `*onboard`
> gate) then rewrites the file IN PLACE by following the steps below. The loader
> NEVER parses the old shape at runtime.

## When this fires

`loadConfig` returns `{ ok: false, legacy: true }` — and `gateExecution` emits the
`migration-required` blocker — when the parsed config carries ANY legacy marker:

- `config_version` is absent or `"0.1.0"` (anything other than the frozen `"0.2.0"`), OR
- a legacy top-level key is present: `shared`, `stages`, a top-level `diagnostics`
  section, or a top-level `evaluator` section, OR
- any `stages.<stage>.observability` block survives.

## The v0.2.0 shape (target)

Three top-level blocks: **`global`** (shared resources + the sources/targets
catalogs) · **`lifecycle`** (per-skill, keyed by skill name) · **`triggers`**
(future monitor, per stage, disabled). The old `stages` map is GONE — every skill
IS a stage, so the config is keyed by skill, and "where traces come from" / "where
fixes go" live in a global catalog bound BY ROLE (no `source_ref` / `target_ref`).

## The transform (apply all, in order)

1. **`shared` → `global`.** Rename the top-level `shared:` block to `global:`.
   Every field under it keeps its meaning.

2. **`models.pinned_judge` → `models.judge_model`.** Rename the key under
   `global.models`. Semantics unchanged — it is the C-PIN pinned judge model
   (`agent-dispatch` judge runtime ⇒ the host model, no provider key).

3. **Hoist the observability source → `global.sources[]`.** For each
   `stages.<stage>.observability` you had (typically evaluate + diagnose, usually
   the SAME source named in multiple places), create ONE entry under
   `global.sources[]`:
   ```yaml
   global:
     sources:
       - name: primary-langfuse           # a catalog id you choose
         platform: langfuse               # was observability.platform
         project: mutagent-evals          # was observability.project (optional)
         # endpoint / credential_ref / paths / format / agent_field / latency_unit
         # as applicable — endpoint_ref (env-var) becomes credential_ref
   ```
   De-duplicate: if evaluate + diagnose named the same source, emit it ONCE. A
   source-consuming stage binds it BY ROLE under the SELECTION contract: one
   entry ⇒ auto-bind; MANY entries ⇒ mark exactly ONE with `default: true` to
   auto-select it (`resolved`), or leave all un-marked to pick at run time
   (`needs-selection`). Setting `default: true` on MORE THAN ONE entry is a
   config error (`multiple-defaults`) — the orchestrator surfaces it as a distinct
   `source-config-error` blocker.

   ```yaml
   global:
     sources:
       - name: prod-langfuse            # auto-selected when multiple exist
         platform: langfuse
         default: true                  # SELECTION selector (optional, boolean)
       - name: local-jsonl-dump
         platform: local-jsonl
         paths: [traces/*.jsonl]
   ```

4. **Hoist the apply target → `global.targets[]`.** If the legacy config expressed
   a fix target (a `diagnostics.target` / a `report-only` marker), create ONE
   entry under `global.targets[]`:
   ```yaml
   global:
     targets:
       - name: local-agents
         platform: local-claude           # local-claude|…|cloud-rest|report-only
         mode: local                       # local | remote
         root: .claude/agents              # local targets
         # rest_base_url / repo_url / code_refs / credential_ref as applicable
         apply:
           kind: code-pr                   # code-pr|markdown|cloud-deploy|report-only
   ```
   A `report-only` legacy target becomes `lifecycle.diagnostics.apply: report-only`
   (see step 6) — a report-only run needs NO target at all. As with sources, a
   MULTI-target catalog uses the SELECTION contract: mark exactly one entry
   `default: true` to auto-select it, or leave all un-marked to pick at run time.
   More than one `default: true` is a config error (`target-config-error`).

5. **Drop `stages` entirely.** After steps 3-4, delete the whole `stages:` map. Its
   only real content was `observability` (now a global source) — the rest was a
   false phase/skill axis that v0.2.0 collapses.

6. **Move skill sections under `lifecycle.<skill>`.** A top-level `diagnostics:` /
   `evaluator:` section moves under `lifecycle:`, keyed by skill name:
   ```yaml
   lifecycle:
     agentspec:  { spec_dir: .mutagent/specs }     # optional
     builder:    {}                                # config-light
     evaluator:  { judge_runtime: agent-dispatch, context: [...] }
     diagnostics:{ apply: report-only, context: [...] }
   ```
   The orchestrator TYPES only the gate-relevant fields per skill
   (`spec_dir` / `context` / `apply` / `judge_runtime`); every other knob is the
   skill's own opaque passthrough — leave it as-is under its skill section.

7. **`substrate` → `judge_runtime`.** Under the evaluator section, rename
   `substrate` to `judge_runtime`. Enum VALUES are unchanged
   (`agent-dispatch` | `in-house` | `code-based` | `user-framework`).

8. **Move `diagnostics.{schedule, trigger_rules, heartbeat}` → `triggers.<stage>`.**
   These three no longer live under the diagnostics skill section. Fold them into
   the top-level `triggers` block, keyed per stage:
   ```yaml
   triggers:
     diagnose:
       enabled: false          # ships DISABLED (on-demand only)
       rules: []               # was diagnostics.trigger_rules
       schedule:  { mode: on-demand, at: ..., timezone: ... }   # was diagnostics.schedule
       heartbeat: { notify_on_zero_matches: ..., max_diagnostics_per_day: ... }  # was diagnostics.heartbeat
   ```

9. **Widen credential refs.** Any `credentials_ref` / `credential_ref` /
   `endpoint_ref` that named a bare env var stays a string; where you need to pin
   an explicit file, use the widened `{ env: NAME, path: FILE }` object form. Refs
   are ALWAYS env-var NAMES — never a raw secret value.

10. **Bump the version.** Set `config_version: "0.2.0"`.

## After migrating

Re-run the orchestrator's onboarding check / `*onboard` gate. `loadConfig` now
returns `{ ok: true, config }`; the `migration-required` blocker clears and the
scoped source/target/provider floors take over.
