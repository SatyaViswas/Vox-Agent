# AutoMemory — project-level operator-feedback + system self-learning

> **Mirror (parity).** This is the SHARED AutoMemory standard for the ADL lifecycle
> skills. The diagnostics + evaluator skills carry a BYTE-PARITY copy (a parity test
> asserts they don't drift). The subject is **the TOOL + operator preferences — NOT
> the diagnosed/evaluated agent.** ONE project-level store for the whole lifecycle.

## Location + shape — Claude-Code AutoMemory format (verbatim)

```
.mutagent/memory/                    ← project-level, COMMITTED
  MEMORY.md                          ← index: `- [Title](<slug>.md) — <hook>` one line/entry
  <slug>.md                          ← one FACT per file
```

Each `<slug>.md` entry:

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

- **Every entry DATED** (`metadata.created`). `MEMORY.md` = index only.
- **Dedupe on append** (update the existing entry + refresh its date; never a second file for the same slug).
- **Lifecycle-tagged.** A run READS entries whose `lifecycle ∈ {this-stage, general}`. For the
  evaluator, `this-stage = evaluate` → read `lifecycle ∈ {evaluate, general}`.

## Feedback → type CLASSIFICATION rubric (at append)

Decision order — **first match wins**:

| # | Feedback about… | → type | Signals | Body |
|---|---|---|---|---|
| 1 | external resource | `reference` | URL · dashboard · ticket · dataset path | pointer + what it's for |
| 2 | who the operator is | `user` | "I'm the lead" · standing preference | the trait |
| 3 | how the tool should behave | `feedback` | "stop surfacing X" · "too verbose" · "next time…" | fact + **Why:** + **How to apply:** |
| 4 | ongoing work/goals/constraints | `project` | "migrating to…" · "don't touch Z until…" | fact + **Why:** + **How to apply:** |

**Do NOT save:** already-in-code/config/git · ephemeral-to-one-run · subject findings (those go to the
living-suite / class-memory library, NOT here).

## Why AutoMemory is separate from the other memory subsystems

These do NOT compete — they have different SUBJECTS:

| Subsystem | Subject | Content | Write trigger | Location |
|---|---|---|---|---|
| **Living suite** (eval) | the evaluated subject | accumulated eval criteria | per discover run | `.mutagent/evaluator/living-suite/` |
| **Class-memory library** (diag) | the diagnosed entity | journal + patterns + ledger | operator-APPROVED findings | `.mutagent/diagnostics/library/…` · gitignored |
| **AutoMemory** (this) | the tool + operator | usage-feedback + lessons (dated, classified) | operator feedback | `.mutagent/memory/` · committed |

## Evaluator wiring

- **READ at run START** (`cli/prep.ts` + the run start): load `.mutagent/memory/` filtered by
  `lifecycle ∈ {evaluate, general}` and inject as operator-preference context.
- **APPEND at run END** on operator feedback: classify → dated + lifecycle-tagged entry → dedupe → index line.
- **COMMITTED** — no subject-private data ever lands here.
