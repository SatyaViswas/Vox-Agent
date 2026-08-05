# Config Migration — v0.1.0 → v0.2.0 (Diagnostics)

> **Skill-local mirror** of the framework migration directive (canonical copy:
> `mutagent-orchestrator/references/config-migration.md`). Load this when
> `scripts/config/load.ts` returns `migrationRequired: true` (a legacy shape was
> detected) or when `scripts/setup/detect.ts` reports `migrationRequired`.

## Why a migration is needed

The unified `.mutagent/config.yaml` changed shape in **v0.2.0**. The old per-skill
`diagnostics:` section named its own `source` / `target` / `schedule` /
`trigger_rules` / `heartbeat`. In v0.2.0 those move to shared, framework-owned
places so the whole ADL lifecycle shares one catalog. **Fork B — HARD-CUT:** the
loader NEVER parses the old shape at runtime. It detects a legacy config and emits
`migration-required`; you rewrite the config in place (this directive), then re-run.

There is **no static migration script** — this is a directive an agent applies
under the `*onboard` gate.

## Legacy detection (what trips `migration-required`)

Any ONE of these fires (see `detectLegacyShape` in `scripts/config/load.ts`):

- `config_version` is absent or not the frozen `"0.2.0"`.
- A legacy top-level key is present: `shared` · `stages` · a top-level
  `diagnostics` · a top-level `evaluator`.

## The rewrite (apply in place)

| # | v0.1.0 (old) | v0.2.0 (new) |
|---|---|---|
| 1 | `shared:` | **`global:`** (rename) |
| 2 | `diagnostics.source: { platform, endpoint, credential_ref, paths, format, agent_field, latency_unit }` | **`global.sources: [ { name, platform, project?, endpoint?, credential_ref?, paths?, format?, agent_field?, latency_unit? } ]`** — give it a `name`; bound BY ROLE (source-consumer), no `source_ref`. |
| 3 | `diagnostics.target: { platform, mode, root, rest_base_url, credential_ref }` | **`global.targets: [ { name, platform, mode, root?, rest_base_url?, repo_url?, code_refs?, credential_ref?, apply: { kind } } ]`** — give it a `name` + an `apply.kind`; bound BY ROLE (target-writer). A `platform: report-only` target becomes `apply.kind: report-only` (or set `lifecycle.diagnostics.apply: report-only` and omit the target). |
| 4 | top-level `diagnostics:` section | **`lifecycle.diagnostics:`** (nest under `lifecycle`) |
| 5 | `diagnostics.schedule` · `diagnostics.trigger_rules` · `diagnostics.heartbeat` | **`triggers.diagnose: { enabled, rules, schedule?, heartbeat? }`** (top-level `triggers`, ships disabled) |
| 6 | `credential_ref: SOME_ENV` | unchanged, but WIDENED — may now be `credential_ref: { env: SOME_ENV, path: ../secrets/.env }` |
| 7 | any `*.observability` block | **REMOVED** — source binds by role via `global.sources` |
| 8 | `config_version: "0.1.0"` (or absent) | **`config_version: "0.2.0"`** (frozen literal) |

Fields the diagnostics section KEEPS (now under `lifecycle.diagnostics`):
`apply` (new — the report-only gate), `context[]` (new — stage context links),
`ask_tool`, `default_audience`, `run_tags`, `self_diagnostics`, `feedback_sources`,
`agents[]`.

## Before → after (minimal example)

**Before (v0.1.0):**
```yaml
config_version: "0.1.0"
shared:
  models: { default: sonnet, pinned_judge: sonnet }
diagnostics:
  source: { platform: langfuse, credential_ref: LANGFUSE_SECRET_KEY }
  target: { platform: report-only, mode: local }
  ask_tool: { runtime: claude-code }
  schedule: { mode: on-demand }
  heartbeat: { max_diagnostics_per_day: 3 }
```

**After (v0.2.0):**
```yaml
config_version: "0.2.0"
global:
  models: { default: sonnet, judge_model: sonnet }   # pinned_judge → judge_model
  sources:
    - name: primary
      platform: langfuse
      credential_ref: LANGFUSE_SECRET_KEY
lifecycle:
  diagnostics:
    apply: report-only            # was target.platform=report-only
    ask_tool: { runtime: claude-code }
triggers:
  diagnose:
    enabled: false
    rules: []
    schedule: { mode: on-demand }
    heartbeat: { max_diagnostics_per_day: 3 }
```

After rewriting, re-run `scripts/setup/detect.ts <project-root>` — it should now
report `state: complete` (or a normal `partial` for genuinely-missing fields, NOT
`migrationRequired`).
