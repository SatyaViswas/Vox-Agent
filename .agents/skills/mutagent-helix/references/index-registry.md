# `.mutagent/index.md` — the ADL spec ↔ implementation registry

> Convention doc for the orchestrator-owned registry writer (`scripts/index/{build-index,render-index}.ts`).
> This is the ONLY place the update-point convention is documented (F4, PLAN §"FEATURE 4").

## What it is

`.mutagent/index.md` is a **single markdown file that IS the record** — no sidecar JSON. It links
each registered AgentSpec to everything that realizes it, versioned + dated, so the spec ↔
implementation relationship stays traceable across the whole ADL loop.

The markdown IS the machine surface: section headers + markdown links are what downstream reads.
There is no parallel structured file to drift against.

## HIGH-LEVEL ONLY (anti-drift — LOAD-BEARING)

The index carries **identity + stage/verdict + version/date + LINKS ONLY**:

- spec identity (`spec_id`, display name) + `spec_version`
- ADL `loop_state.stage` + `last_verdict`
- the build target (`target_framework` · `runtime`)
- markdown LINKS to: agent code · tooling/integrations · harness/framework code · context/product docs
- an injected `updated <YYYY-MM-DD>` stamp

It **NEVER** carries eval criteria, scenarios, dataset detail, or any other volatile field. That
lives in the evaluator's living-suite; duplicating it here is a drift + maintenance burden. **The
index only links; it never restates.** The renderer is guarded by a test that asserts no
`criteria` / `scenario` / `dataset` tokens ever appear.

## Data sources

| Field(s) | Source | Notes |
|---|---|---|
| `spec_id` · `spec_version` · `stage` · `last_verdict` | each `agentspec.yaml` under `.mutagent/specs/*` (`meta` + `meta.loop_state`) | `last_verdict` absent ⇒ rendered as `—` |
| display name | `definition.identity.name` (falls back to the spec_id) | |
| build target · runtime | `build.{target_framework, runtime}` | absent build block ⇒ Build bullet omitted |
| implementation / code links | config `global.targets[].code_refs[]` (`{path, why}`) | flattened across targets, deduped + sorted by path |
| context / product docs | config `global.context[]` (`{path, what, why, when}`) | sorted by path |
| `updated <date>` | **INJECTED clock** (`nowIso.slice(0,10)`), NOT the spec's `updated_at` | see Determinism |

**Why config-sourced impl links (not per-spec):** per agentspec PR-013 the spec is
implementation-agnostic and never enumerates its own impls (backwards-only linking). So the config's
`global.targets[].code_refs` are the impl-link source of truth. They are shared across the install and
attached to each spec entry — exactly right for the dominant one-agent-per-install case; a multi-agent
install shows them as shared implementation/context, which is the correct high-level view (per-spec
target binding is a run-time role-binding concern, out of scope for the static index).

**Link resolution:** the index lives at `<root>/.mutagent/index.md`.
- Spec links are `.mutagent/`-relative: `specs/<id>/agentspec.yaml` (no prefix).
- Code + context paths are project-root-relative (config determinism rule), so they are hopped out of
  `.mutagent/` with a `../` prefix: `src/foo.ts` → `[src/foo.ts](../src/foo.ts)`.

## Determinism (mirrors the diagnostics `store.ts` `regenerateIndex` pattern)

`regenerateIndex(root, nowIso, io?)` regenerates the WHOLE file from on-disk state each call
(append-then-regenerate — never hand-patched line edits):

- entries sorted by `spec_id`; code + context links sorted (and deduped) by path
- the ONLY non-determinism — the `updated` date — is **injected** by the caller (`nowIso`), so tests
  are byte-stable and a re-run with the same clock produces byte-identical output
- pure `buildIndexModel` (data → model, no I/O / no clock) + pure `renderIndex` (model → markdown)
- the fs is an **injected `IndexIo` seam** (live binding = `node:fs`; tests inject an in-memory fake)
- **fail-soft per entry:** a spec whose YAML fails to parse drops its own row rather than crashing the
  whole regen

## Owner + update points (orchestrator-owned — Fork C)

The **orchestrator** owns `.mutagent/index.md` because it is the only layer that sees every ADL stage.
It regenerates the file at each stage **finalize** — the per-stage skills emit the fields they own
(into their `agentspec.yaml` / config), and the orchestrator re-runs `regenerateIndex` to re-link:

| ADL stage | Finalize trigger | What the regen picks up |
|---|---|---|
| SPEC | `*spec` register | new `spec_id` · `spec_version` · `stage: spec` |
| BUILD | `*build` finalize | `build.{target_framework, runtime}` · realized `code_refs` |
| EVALUATE | `*evaluate` run-end | `loop_state.last_verdict` |
| DIAGNOSE | `*diagnose` finalize | (findings link — future; still high-level, link only) |
| OPTIMIZE | `*optimize` finalize | re-linked impl paths after the fix |

Because the writer is a full regenerate (not an incremental patch), each finalize simply calls
`regenerateIndex` — the file always reflects the current on-disk truth. The orchestrator wires this
step into `orchestrator.md` / the orchestrator-protocol (owned by the orchestrator lane — NOT edited
from here).

## CLI

```bash
# Regenerate the index for the resolved (or supplied) `.mutagent/` install root.
bun run scripts/index/build-index.ts [root] [--now <ISO8601>]
```

`--now` pins the clock (deterministic scripting / reproducing a stamp); default is the wall clock.
