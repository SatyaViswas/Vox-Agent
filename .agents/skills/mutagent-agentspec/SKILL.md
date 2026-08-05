---
name: mutagent-agentspec
description: |
  The ADL ① SPEC stage: a guided requirements interview that captures WHAT an AI agent IS and emits
  a portable, validated agentspec.yaml. The spec is the Definition (the interface — persona, the
  actual system prompt, jobs-to-be-done, context sources, tools across four buckets, agent type,
  inbound activation triggers, decision modeling, standard operating procedures, and binary
  eval criteria). BUILD is owned by mutagent-builder, which consumes the validated spec and implements
  it into a target framework or harness. First invocation: auto-detects install. Then *spec runs a parent-session
  interview (AskUserQuestion on Claude Code, chat multi-choice fallback elsewhere) → emits + validates
  agentspec.yaml; *validate-spec is the TypeBox round-trip schema gate. The target may be a framework
  (mastra / deepagents / pydantic-ai / langgraph) OR a harness (harness:claude-code / harness:codex).
  After *spec or *validate-spec succeeds, Helix suggests *build; *build is owned by mutagent-builder.
license: Apache-2.0. LICENSE + NOTICE have complete terms.
compatibility: Designed for Claude Code, Codex, Cursor, OpenCode and similar coding-agent runtimes; works with git, gh CLI, and Bun/pnpm/npm runtimes.
metadata:
  author: mutagent
  version: "0.1.0-alpha.3"
# allowed-tools: OMITTED — agent uses all native tools per host runtime.
---

# mutagent-agentspec

The **ADL ① SPEC** stage. Invoke this skill to specify a new agent — run a guided interview that
captures *what the agent IS* and emit a portable, validated `agentspec.yaml`. The spec is the
**Definition** (the interface); `mutagent-builder` later implements it into a target via `*build`.

## §0 — Setup Detection (ALWAYS runs first)

> **The parent session IS the domain orchestrator.** Run the interview yourself — do **NOT** dispatch
> a coordinator sub-agent. AskUserQuestion (and therefore the interview) cannot run inside a
> sub-agent (PR-006). BUILD sub-agents are owned by `mutagent-builder`; `*spec` dispatches none.

**Lean install:** `pnpx @mutagent/agentspec init` installs the SPEC skill. There is no onboarding config
to fill in this wave — `*spec` reads from the operator interactively, so "setup complete" simply means
the skill tree is installed.

```typescript
// PSEUDOCODE — actual execution is agent-native
const setup = await Bash("bash scripts/cli/run.sh scripts/setup/detect.ts");
if (!setup.complete) {
  // skill tree incomplete → reinstall: pnpx @mutagent/agentspec init
} else {
  // → load references/workflows/orchestrator-protocol.md and follow inline.
  //   The parent session runs the *spec interview. DO NOT dispatch a coordinator.
}
```

## §0.1 — Star-commands

These are THIS skill's `*command` semantic map. Resolution is governed by the verbatim contract at
the bottom of this section.

| Command | Kind | Owner | Binds | Purpose |
|---|---|---|---|---|
| `*spec` | hybrid | own (full) | `references/workflows/orchestrator-protocol.md` | Guided parent-session interview → emits + validates `agentspec.yaml` (the Definition + Build + Appendix). |
| `*validate-spec` | script | own | `scripts/validate/validate-spec.ts` | TypeBox round-trip schema gate over a spec file (`agentspec.mutagent.io/v0.3.0`). |
| `*sync-spec` | agent-chain | own entry · delegates read → `ai-architect #sync-spec` | `references/workflows/orchestrator-protocol.md#sync-spec--reconcile-the-spec--eval-triad-against-a-target-delegated` | The canonical **triad** reconcile (def → impl → EVAL; FUSES the former `*spec-from-impl` + builder `*spec-sync`). Cold (no spec → construct) AND warm (drift → reconcile) are ONE op — reverse-generate is drift-from-nothing. Reconciles BOTH the spec leg AND the **eval-criteria leg** (eval-suite criteria for agent/skill · code-quality criteria for code) against the impl. AgentSpec owns the entry but **NEVER reads code**: it delegates the target-read to builder's `ai-architect #sync-spec` (Helix-mediated HandoverBundle), then `*validate-spec`-gates + owns the spec result; the eval-leg write is the evaluator's criteria-maintenance hook (gated). |
| `*eval` | agent-chain | route → evaluator (OUTLINED) | `references/workflows/orchestrator-protocol.md#eval` | Hand the built agent + its `evals.success_criteria` to an evaluator for eval-driven development (phased). |

After `*spec` or `*validate-spec` succeeds, Helix suggests `*build`; `*build` is owned by `mutagent-builder` and consumes the validated `agentspec.yaml`.

> **SPEC↔BUILD boundary (written once).** AgentSpec owns the spec ARTIFACT + its 3 commands (`*spec` ·
> `*validate-spec` · `*sync-spec`). Builder owns the impl + the two agents (`ai-engineer` · `ai-architect`).
> `ai-architect` is the SINGLE implementation-reader (`#verify` from `*build` + `#sync-spec` from `*sync-spec`).
> Reverse-generate = drift-from-nothing = one `*sync-spec`. `*validate-spec` is never architectural review.

### Star-command resolution contract (verbatim)

When you encounter a `*<name>` token:
1. **RESERVED** — `*` marks a command. NOT prose, NOT a file path, NOT an external shortcut. Never improvise.
2. **RESOLVE** — look up `<name>` in the table above. Not found ⇒ ERROR + ask the operator. NEVER guess.
3. **BINDING** — read `Kind` + `Binds`:
   - `script` ⇒ CALL the bound script via `scripts/cli/run.sh`. Do NOT re-implement it in prose.
   - `agent-chain` ⇒ load + run the bound workflow steps in order.
   - `hybrid` ⇒ call script(s) for deterministic parts, reason for the rest.
4. **PRE-GATE** — load any pre-gate references the bound workflow declares.
5. **EXECUTE** — run the steps IN ORDER. Invent nothing.
6. `Purpose` explains WHY (not executed). Steps MAY reference other `*commands` (composition).

## §1 — Triggers

This skill activates on any of:
- `mutagent-agentspec` · `/mutagent-agentspec`
- `*spec` · `spec` · `specify the agent` · `plan a new agent` · `define an agent` · `new agent spec`
- `*sync-spec` · `sync the spec` · `spec sync` · `reconcile spec with code` · `code drifted from spec` · `spec from impl` · `reverse-generate a spec` · `adopt an existing agent` · `spec an existing implementation` · `no agentspec exists`
- `pnpx @mutagent/agentspec init`

## §2 — Quick start

```bash
# 1. install (project-local by default; --global for the home dir)
pnpx @mutagent/agentspec init

# 2. inside your coding agent
/mutagent-agentspec        # load the skill
*spec                      # run the guided interview → agentspec.yaml
*validate-spec ./agentspec.yaml   # schema-gate it (round-trip)
```

Start from the worked example: `assets/templates/agentspec.yaml.tpl` (a complete, validated
synthetic spec exercising every field).

## §3 — Architecture

```mermaid
flowchart LR
  spec["*spec — guided interview (parent session)"] --> emit["emit agentspec.yaml"]
  emit --> validate["*validate-spec — TypeBox gate"]
  validate -->|PASS| build["*build → mutagent-builder"]
  build --> eval["*eval → evaluator"]
  validate -.->|FAIL| spec
```

- **`*spec`** is full + parent-session-driven (the interview). **`*validate-spec`** is the schema gate.
- **`*sync-spec`** reconciles the def → impl → EVAL triad against a target (cold construct OR warm drift — ONE op): the spec leg AND the eval-criteria leg (eval-suite for agent/skill · code-quality for code) both stay in lockstep with the impl. AgentSpec owns the entry but delegates the code-read to builder's `ai-architect #sync-spec`; it never reads code itself.
- **`*build`** is owned by `mutagent-builder`; agentspec only suggests the next stage after a valid spec.
- **`*eval`** is routed to EVALUATE after BUILD returns a handoff bundle.

## §4 — Bill of materials

| Surface | Path |
|---|---|
| The `agentspec.mutagent.io/v0.3.0` schema (TypeBox) | `scripts/contract/agentspec.schema.ts` |
| The schema gate | `scripts/validate/validate-spec.ts` |
| The `*spec` output-dir resolver (`lifecycle.agentspec.spec_dir`; default `.mutagent/specs`) | `scripts/config/resolve-spec-dir.ts` |
| The interview FSM (+ build/eval outlines) | `references/workflows/orchestrator-protocol.md` |
| Operative principles (PR-NNN) | `references/principles.md` |
| Requirements hub (REQ-NNN) | `references/requirements.yaml` |
| Pinned framework docs | `references/frameworks/doc-pins.md` |
| Worked example spec | `assets/templates/agentspec.yaml.tpl` |
| CLI (install / probe / runner) | `scripts/cli/{init,doctor,run.sh}` · `scripts/setup/detect.ts` |

## §5 — Standalone discipline

Every artifact under `.claude/skills/mutagent-agentspec/` is a sealed SPEC unit. The `*build` handoff
to `mutagent-builder` and the `*eval` handoff to EVALUATE are composition boundaries mentioned at the
doc/protocol level only, never code imports. `*spec` itself dispatches no sub-agents.
