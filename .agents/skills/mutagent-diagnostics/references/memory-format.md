# AutoMemory Format — project-level operator-feedback + tool-lessons

> **Standard (mirrored across ADL skills — parity).** The subject of AutoMemory is
> the **TOOL + operator preferences**, NOT the diagnosed agent (that is the
> gitignored class-memory library). ONE project-level store for the whole lifecycle.
> Fixed convention + standardized format; NOT a config field.
>
> Read/write helpers: `scripts/memory/read.ts` + `scripts/memory/append.ts`.

## Location + shape

```
.mutagent/memory/                    ← project-level, COMMITTED
  MEMORY.md                          ← index: `- [Title](<slug>.md) — <hook>` one line/entry
  <slug>.md                          ← one FACT per file
```

Each `<slug>.md` entry — Claude-Code AutoMemory format (verbatim):

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference    # Claude Code's four types
  lifecycle: spec|build|evaluate|diagnose|optimize|general   # ADL extension
  created: YYYY-MM-DD                             # REQUIRED · every memory is DATED (stale-pruning)
---

<the fact. For feedback/project: **Why:** + **How to apply:** lines. Link with [[their-name]].>
```

- **Every entry DATED** (`metadata.created`). The date is an ABSOLUTE `YYYY-MM-DD`
  (injected `now` for determinism in `appendMemory`).
- `MEMORY.md` is an **index only** — one `- [Title](<slug>.md) — <hook>` line per
  entry, sorted by slug. The `<hook>` is the entry's `description`.
- **Dedupe on append**: an existing slug is UPDATED in place and its `created` date
  REFRESHED (never a duplicate file).

## Feedback → type CLASSIFICATION rubric (verbose)

Decision order — **first match wins**:

| # | Feedback about… | → type | Signals | Body |
|---|---|---|---|---|
| 1 | external resource | `reference` | URL · dashboard · ticket · dataset path | pointer + what it's for |
| 2 | who the operator is | `user` | "I'm the lead" · standing preference | the trait |
| 3 | how the tool should behave | `feedback` | "stop surfacing X" · "too verbose" · "next time…" | fact + **Why:** + **How to apply:** |
| 4 | ongoing work/goals/constraints | `project` | "migrating to…" · "don't touch Z until…" | fact + **Why:** + **How to apply:** |

**Do NOT save:**
- Anything already in code / config / git (it is already the source of truth).
- Ephemeral facts relevant to only ONE run.
- Subject FINDINGS about the diagnosed agent (those go to the class-memory library
  `.mutagent/diagnostics/library/`, gated by operator approval — NOT here).

## Lifecycle filter at recall

At run START (parse-brief / Step 3a) the diagnostics run loads memory FILTERED to
`lifecycle ∈ { diagnose, general }` (`readDiagnoseMemory`) — the diagnostics stage's
own lessons plus the always-relevant `general` facts. Entries tagged for other
stages (`spec` / `build` / `evaluate` / `optimize`) are skipped for a diagnose run.

## When to append (write trigger)

At run FINALIZE (finalize-gate / Step 9.9), when the operator gives feedback ABOUT
the tool or a standing preference, classify it with the rubric above and call
`appendMemory({ slug, name, description, type, lifecycle, body, now })`. The default
`lifecycle` for diagnostics-run feedback is `diagnose` (use `general` for a
tool-wide standing preference).

## Memory subsystems (NOT competing — different subjects)

| Subsystem | Subject | Content | Write trigger | Location |
|---|---|---|---|---|
| **Class-memory library** | diagnosed entity | journal + regex patterns + deep-read ledger | operator-APPROVED findings only | `.mutagent/diagnostics/library/…` · gitignored |
| **feedback_sources** | diagnosed entity | external signals → enrich findings | read-only, per-run | opt-in config |
| **AutoMemory** (this doc) | the tool + operator | usage-feedback + lessons (Claude format, dated, classified) | operator feedback | `.mutagent/memory/` · committed |
