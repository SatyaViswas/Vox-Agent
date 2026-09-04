---
name: mutagent-helix
description: |
  Helix — the MutagenT Agentic Development Lifecycle (ADL) conductor. Drives a skill or agent
  through the full lifecycle — spec → build → evaluate → diagnose → optimize — by sequencing a set
  of standalone lifecycle-stage skills and adjudicating the gates between them. Helix is a
  natural-language *command router: it indexes the system, tracks where you are in the loop, hands
  each stage to its owning skill, and keeps every apply (a code change, a platform update)
  approval-gated. First invocation auto-detects setup and guides onboarding; subsequent
  invocations render the ADL dashboard and await a *command (or free text, which routes through the
  intent layer). Ships the lifecycle-stage skills it conducts: mutagent-agentspec (① SPEC — a
  guided interview that emits a portable agentspec.yaml), mutagent-builder (② BUILD — implement the
  validated spec into the target framework/harness), mutagent-evaluator (③ EVALUATE — mine criteria
  from traces, judge, validate the judge, build datasets; judge only, never fixes), and
  mutagent-diagnostics (④ DIAGNOSE — RCA + ranked remedies from real traces). The ⑤ OPTIMIZE stage
  routes to mutagent-optimize (bundled inside the @mutagent/helix package, not a standalone release) — the session-conducted,
  bounded eval-driven optimize loop (Build → Eval → Diagnose → Optimize ↻) whose one apply-gate at
  convergence goes through the shared `mutagent-cli apply`. Helix never executes a stage's inner
  work — it routes. Two invariants hold the loop
  together: judge-never-fix (the evaluator decides; failures route to diagnostics) and
  explicit-and-gated (no stage auto-advances; the operator stays in control).
license: Apache-2.0. See LICENSE for complete terms.
compatibility: Designed for Claude Code, Codex, Cursor, and similar coding-agent runtimes; works with git, gh CLI, jq, curl, and Bun/pnpm/npm runtimes.
metadata:
  author: mutagent
  version: "0.1.0-alpha.0"
---

# Helix — the MutagenT ADL conductor

> **The full agent definition lives in [`orchestrator.md`](./orchestrator.md)** (bundled alongside
> this file). That is the canonical Helix persona + activation-instructions + the complete
> `*command` roster + the dashboard template. Read it first; this SKILL.md is the operator-facing
> contract and setup map.

## §0 · Setup (first invocation)

If you have just installed `@mutagent/helix` and have not yet onboarded:

```bash
pnpx @mutagent/helix init      # installs Helix + the lifecycle skills, links CLAUDE.md / AGENTS.md
```

`init` installs the conductor and the lifecycle-stage skills (agentspec · builder · evaluator ·
diagnostics) into your coding agent's `.claude/` (project-local by default; `--global` for the home dir), and
links `CLAUDE.md` / `AGENTS.md` so the host boots Helix. Then open your coding agent and invoke the
conductor.

## §1 · Triggers

| You type | Helix does |
|---|---|
| `/mutagent-helix` · `*mutagent` · `boot` | Boot the conductor: adopt the Helix persona (per `orchestrator.md`), build the shallow system index, render the ADL dashboard, then HALT awaiting a `*command`. |
| free text (e.g. "diagnose the failures") | Routes through the NL intent layer (`routing.yaml`) to the owning stage's `*command`. |

## §2 · What Helix is

Helix is the **only layer that knows the whole system at once**. It sequences the Agentic
Development Lifecycle as a flexible DAG — you can enter at any stage and Helix routes onward — and
hands each stage to the standalone skill that owns it. It owns sequencing, the system topology
index, cross-stage handoff (a shared contract bundle + file-based handover), and gate adjudication
— **never** the work inside a stage.

```
spec ──▶ build ──▶ evaluate ──▶ diagnose ──▶ optimize ──▶ (loop back to build)
 │         │          │            │            │
agentspec  builder     evaluator    diagnostics  optimize (gated apply) ↻
(① SPEC)   (② BUILD)   (③ EVALUATE) (④ DIAGNOSE) (⑤ OPTIMIZE)
```

## §3 · The `*command` roster

| Command | Stage | Owning skill | What it does |
|---|---|---|---|
| `*sync` · `*status` · `*onboard` · `*help` | conductor | Helix | Index the system · report where you are in the loop · onboard/configure · render the dashboard. |
| `*spec` · `*validate-spec` | ① SPEC | mutagent-agentspec | Guided interview → portable, validated `agentspec.yaml`. |
| `*build` · `*sync-spec` | ② BUILD | mutagent-builder | Implement the validated spec; resync `agentspec.yaml` from implementation drift. |
| `*evaluate` · `*audit` (+ `*discover` · `*validate` · `*review` · `*build-dataset` · `*derive-dataset`) | ③ EVALUATE | mutagent-evaluator | Mine criteria from real traces → judge → validate the judge → datasets. **Judge only — never fixes.** |
| `*diagnose` | ④ DIAGNOSE | mutagent-diagnostics | Root-cause routed failures on real evidence → ranked remedies, handed to the gated ⑤ OPTIMIZE. |
| `*optimize` · `*optimize` | ⑤ OPTIMIZE | mutagent-optimize | The session-conducted, bounded eval-driven optimize loop (Build → Eval → Diagnose → Optimize ↻): confirm once at entry, ONE apply-gate at convergence — the write goes through the shared `mutagent-cli apply`. Utterances: "optimize this agent/skill" · "run the optimize/optimize loop" · "apply the fix/remedy" · "next iteration" · "make it better" · "keep improving". |

The evaluator `*discover/*validate/*review/*build-dataset/*derive-dataset` commands are **forward-intents**.
`*build` is an owned BUILD route to `mutagent-builder`; `*sync-spec` is a SPEC route to
`mutagent-agentspec` (which delegates the code-read to builder's `ai-architect #sync-spec`). Helix
gates/forwards; it does not execute a stage's inner work.

## §4 · The skills Helix conducts (bundled)

| Skill | ADL stage | Invoke directly |
|---|---|---|
| [`mutagent-agentspec`](../mutagent-agentspec/SKILL.md) | ① SPEC | `/mutagent-agentspec` |
| [`mutagent-builder`](../mutagent-builder/SKILL.md) | ② BUILD | `/mutagent-builder` |
| [`mutagent-evaluator`](../mutagent-evaluator/SKILL.md) | ③ EVALUATE | `/mutagent-evaluator` |
| [`mutagent-diagnostics`](../mutagent-diagnostics/SKILL.md) | ④ DIAGNOSE | `/mutagent-diagnostics` |
| [`mutagent-optimize`](../mutagent-optimize/SKILL.md) | ⑤ OPTIMIZE | `/mutagent-optimize` |

`mutagent-optimize` ships **inside** the `@mutagent/helix` package — it is **not** published as a
standalone `@mutagent/optimize` (`private: true`). Helix's `*optimize` route targets it either way.

Each is a **sealed, standalone** skill (it never references a sibling in source) and is also
published independently under its own `@mutagent/*` name. Helix is the only layer that knows about
all of them; it talks to each via its public skill contract, never by reaching into its source.

## §5 · Invariants (do not regress)

- **Judge, never fix.** The evaluator decides pass/fail; failures route to diagnostics, which
  proposes the remedies the gated ⑤ OPTIMIZE stage (mutagent-optimize → the shared `mutagent-cli
  apply`) applies. Decision stays independent of remediation.
- **Explicit and gated.** No stage auto-advances. Every apply (PR · REST · CLI install) requires
  explicit operator approval. Helix never auto-applies a remedy.
- **Routing only.** Helix sequences stages and adjudicates gates; it never performs a stage's inner
  work.
- **Standalone.** The system carries its own context — no external framework coupling.
