---
name: mutagent-optimize
description: |
  The ADL ⑤ OPTIMIZE stage: the closed, bounded, eval-driven optimize loop
  (Build → Eval → Diagnose → Optimize ↻). ONE command *optimize runs a confirm-once
  → bounded auto-loop → one apply-gate at convergence. A sub-orchestration skill in
  the shape of evaluator/diagnostics: the parent session owns the loop FSM + gates
  and dispatches a BORROWED crew it does not itself execute — ai-engineer (WRITE),
  ai-architect (VERIFY), evaluator (JUDGE, re-eval), diagnostics-analyzer (RCA).
  optimize writes NOTHING itself: the WRITE delegates to ② builder, the JUDGE to
  ③ evaluator, the RCA to ④ diagnostics, and the TRANSPORT to `mutagent-cli apply`
  (a call OUT to the shared service, NOT a subcommand). Absorbs the retired
  diagnostics apply-worker's target mechanics via that shared apply layer.
license: Apache-2.0
compatibility: Designed for Claude Code, Codex, Cursor, OpenCode and similar coding-agent runtimes; works with git, gh CLI, mutagent-cli, and Bun runtimes.
metadata:
  author: mutagent
  version: "0.1.0-alpha.0"
---

# mutagent-optimize

The **ADL ⑤ OPTIMIZE** stage — the one owner of `*optimize`. It conducts the closed
`Build → Eval → Diagnose → Optimize ↻` loop and owns the apply-gate; it **delegates**
the WRITE to ② builder, the JUDGE to ③ evaluator, the RCA to ④ diagnostics, and the
TRANSPORT to the shared `mutagent-cli apply` service. It writes nothing itself.

## §0 — Setup Detection

`mutagent-optimize` ships the loop FSM as a PURE decision model (`scripts/loop-state.ts`)
plus its one-shot CLI (`scripts/loop-state-cli.ts`) — the conducting session calls the CLI
between Task dispatches (§2·5). (`scripts/optimize-loop-run.ts` is NOT the interactive runtime
— it is the unit-test harness + a future headless verification driver; see §2.) The crew is
BORROWED — sealed-sibling via a Helix handover: ai-engineer + ai-architect (from ②), evaluator
(③), diagnostics-analyzer (④). The parent session routes `*optimize`/`*optimize` here through
Helix and READS the HandoverBundle on entry (`bundle.inputs[]` — the trace slice + manifest,
or the approved RemedyPacket — LOCATABLE relative paths), never re-fetching (single-collection-point).

## §0.1 — Star-commands · LEAN · YAGNI

| Command | Kind | Owner | Binds | Purpose |
|---|---|---|---|---|
| `*optimize` | sub-orch loop | own (full) | the §2·5 conduct procedure + `scripts/loop-state-cli.ts` (decisions) + `scripts/loop-state.ts` (FSM) + Task-dispatched crew | THE stage: confirm-once → the session conducts the bounded auto-loop → one apply-gate at convergence. |

```
*optimize <subject> [--goal eval-pass|criterion:<id>|delta:<n>|code-quality|"<free text>"] [--max-iters N] [--budget 30m] [--dry-run] [--html]
```

> **`--goal code-quality`** is the CODE-TARGET goal (Wave-2 W2I1): the loop converges
> ONLY when BOTH the code subject's OWN test suite is green (a hard deterministic gate)
> AND the code-quality evaluator verdict passes. Neither alone converges. It is the
> default goal when the subject is a `code`-kind target (`global.targets[].subject: code`).

> **`--goal "<free text>"`** is a NATURAL-LANGUAGE goal (Wave-2 W2I10). The loop still
> needs an OBSERVABLE, unchanging yardstick, so free text is NOT run as-is — at Entry the
> SESSION INTERPRETS it into a measurable binary criterion, CONFIRMS it once, and FREEZES
> it (→ the frozen criterion becomes the yardstick). An UNFROZEN NL goal is **not
> goal-legal** (`assertGoalLegal` rejects it exactly like an unbounded goal), and a
> HEADLESS run — no human to confirm — REFUSES it (falls back to a structured goal or
> throws). Never runs unbounded. See §2·5 Entry (interpret → confirm → freeze).

### Two axes → goal disambiguation (which goals apply to what)

Two ORTHOGONAL axes describe the subject (S15 / FU-69 §1 — a Mastra agent is BOTH an `agent`
role AND `code` substrate):

- **`kind` (role)** — the AgentSpec 0.3.0 kind axis: `agent · skill · multiAgent · workflow`. WHAT
  the subject IS. It governs NO goal legality.
- **`artifact.format` (substrate)** — `code · markdown · platform-config`. HOW it is realized.
  `code-quality` — the ONLY goal that touches a test suite — applies to `code` substrate and
  NOWHERE else; every other substrate optimizes against EVALS.

| `artifact.format` | What it is | Applicable goals | `code-quality`? | ApplyKind |
|---|---|---|---|---|
| **`code`** | source with its own test suite (Mastra / Agent-SDK / TS / Python) | `code-quality` (the BOTH-gate: tests-green AND the quality verdict) — the default; eval goals also usable | **YES — only here** | `code-pr` |
| **`markdown`** | prompt / `.md`-defined (Claude Code, Codex) | evals only — `eval-pass` · `criterion:<id>` · `delta:<n>` · a frozen NL criterion | **NEVER** (no code to test) | `markdown` |
| **`platform-config`** | a hosted / reconstruct-spec subject | evals only — same set as `markdown` | **NEVER** (no code to test) | `cloud-deploy` |

> The **`code-quality` name is retained deliberately** — accurate precisely because it only ever
> applies to `code` substrate. `assertGoalAllowedForArtifact(goal, artifactFormat)` code-enforces
> this: a `code-quality` goal on a non-code artifact.format throws; all eval-based goals are valid
> for any format; the ROLE never gates it. `ApplyKind` DERIVES from `artifact.format`
> (`deriveApplyKind`: code→code-pr · markdown→markdown · platform-config→cloud-deploy). The session
> runs the gate at Entry via `loop-state-cli assert-goal-legal config.json
> [--subject-kind <agent|skill|multiAgent|workflow>] [--artifact-format <code|markdown|platform-config>]`.

> **Net surface = `*optimize`.** Everything else earns its place or folds:
> - `*apply` / `*rollback` — **FOLDED internal**. The absorbed apply mechanics are a
>   capability the loop calls at its promotion gate via the shared `mutagent-cli apply`
>   service (caller a), NOT user-facing commands. Rollback is the revert branch of the
>   same capability, reachable from a run's apply-audit.
> - `*variant` / `*promote` — **OUT OF SCOPE** (the separate #1085 variant bake-off).
> - `*status` — **OUT OF SCOPE** (loop state lives in `loop-state.json` + Helix `*status`).
>
> Helix's `*optimize` route (`routing.yaml`) re-targets to `mutagent-optimize`; the
> utterances ("apply the fix", "next iteration", "loop back to build", "optimize") all
> map onto the one command.

## §1 — Sub-orchestration dispatch (parent conducts · crew executes)

```
optimize parent  — owns loop FSM + gates + interaction; writes nothing
  → OptimizeHandover
     ai-engineer   #apply / #amend   (WRITE — worktree-scoped)
     ai-architect  PROCEED|STEER|ABORT (VERIFY — read-only)
     evaluator     re-eval swing      (JUDGE — EV-051 judge-only)
     analyzer      RCA on new failures (DIAGNOSE)
```

Boundaries preserved verbatim: ai-engineer never mutates spec on an impl-amend;
ai-architect stays read-only; evaluator stays EV-051 judge-only; the parent never
writes source. Each borrowed cell's home-stage invariants carry into optimize unchanged.

## §2 — The loop FSM (S0→S5 · deterministic · bounded)

`scripts/loop-state.ts` is the pure DECISION model (the FSM: bounded · goal-legal ·
variance-aware). Phases: **S1 Build → S2 Verify → S3 Eval → S4 Gate → [S5 Diagnose ↺]**.

> **Two runtimes — do not conflate.** The INTERACTIVE `*optimize` runtime is conducted by
> YOU, the top-level session (Model B — §2·5 below): only the session can Task-dispatch
> sub-agents, so the session conducts and calls the pure decisions one-shot via
> `scripts/loop-state-cli.ts`. `scripts/optimize-loop-run.ts` is NOT the interactive runtime —
> it is the unit-test harness + a future HEADLESS *verification* driver (Model A / SimuLatte
> `sim-run`). Both drive the same FSM; the interactive one is a session procedure, not a script.

- **Transition gates (which stage moves to which):** S1→S2 always. **S2 verdict:** `PROCEED`→S3,
  `STEER`→S1 (re-build with instructions), `ABORT`→stop (`aborted`). **S4 gate:** `PASS`→check
  goal/terminators (may `converged`), `FAIL`→S5 diagnose→S1.
- **Termination gates (afkloop-legal — the loop refuses to run without them):** an OBSERVABLE
  goal (`eval-pass` · `criterion:<id>` · `delta:<n>` · `code-quality` [code-target BOTH-gate] ·
  a FROZEN natural-language goal [`nl` with `resolved.criterionIds[]` — an AND-set of ≥1 binary
  criteria]) + hard terminators (`max-iters` ·
  wallclock `budget` · `no-improvement` streak) + a scope envelope (worktree-scoped). Terminators:
  `converged` · `no-improvement` · `max-iters` · `budget` · `aborted`. `assertGoalLegal` is
  unchanged for a `code-quality` goal (bounded like the others); it additionally REJECTS an
  UNFROZEN natural-language goal (an un-yardsticked free-text intent) exactly as it rejects an
  unbounded field — so an NL goal only runs once frozen to a measurable criterion.
- **Variance-gate** — an iteration counts as improvement ONLY on a strict, above-noise gain that
  does not regress variance; a sub-noise wobble is a plateau, not a win (decided by the CLI, not you).
- **Two nested gates** — the intra-loop transitions ARE the automatic progress-gate (each
  iteration self-scores; no human); the real-world write on promotion IS the single human
  apply-gate. "Ask once at entry + promote once at exit" — never ask-per-iteration.

## §2·5 — RUNTIME CONDUCT: you (the session) conduct the loop (Model B — interactive)

**YOU are the conductor.** A sub-agent cannot spawn sub-agents, so the loop cannot be a
sub-agent or a TS `while` awaiting dispatches — the TOP-LEVEL SESSION runs it, exactly like
diagnostics runs its `orchestrator-protocol` inline in the parent. You Task-dispatch the crew
and shell `loop-state-cli.ts` for every decision (you never eyeball the variance-gate / terminators).

**Entry (once):**
1. **Parse the goal.** `bun run scripts/loop-state-cli.ts parse-goal "<--goal arg>"` → a `Goal`.
   The four structured shapes (`eval-pass` · `criterion:<id>` · `delta:<n>` · `code-quality`)
   resolve directly. Any FREE-TEXT `--goal` resolves to an UNRESOLVED natural-language goal
   (`{ kind: "nl", text }`) — not yet a runnable yardstick.
2. **Interpret → confirm → freeze (natural-language goals only).** If the goal is `nl`, the
   SESSION must turn the free text into a COMPOSITION of MEASURABLE BINARY criteria / measurable
   metrics BEFORE the loop can run — this is AGENT reasoning at entry, NOT a code loop:
   - **Interpret** — draft one or more binary, observable criteria that together capture the
     intent (a real NL goal usually decomposes into a SET of binary decisions / measurable
     metrics, not a single one; you MAY Task-dispatch the ③ evaluator's criterion-mining to help
     draft them — that is session dispatch, not a code loop). Example: *"a concise, well-sourced
     answer"* → `NL-1: "the output is ≤ 3 sentences"` **AND** `NL-2: "every claim cites a
     source"`.
   - **Confirm** — surface the drafted criteria in the SAME confirm-once Entry ASK (step 3;
     the ONLY per-loop prompt, MODE-2) via `AskUserQuestion`: *"I read your goal “{text}” as
     the binary criteria **{criteria}** (optimize until ALL pass, bounded by {maxIters}
     iters / {budget})? Adjust the criteria, or pick a structured goal instead?"*
   - **Freeze** — on confirm, `bun run scripts/loop-state-cli.ts freeze-goal config.json
     --criterion <id> [--criterion <id> …]` (repeat the flag, or pass a comma list `--criterion
     a,b`) → the goal becomes `{ kind: "nl", text, resolved: { criterionIds } }`, a concrete
     AND-yardstick the loop runs against (met only when ALL listed criteria pass — each an
     objective binary check). The raw text is kept for audit.
   - **HEADLESS / no human** (SimuLatte / CI, no interactive confirm): an NL goal CANNOT be
     safely confirmed → **fall back to a structured goal, or REFUSE** (the goal-legal gate in
     step 4 throws on an unfrozen NL goal). NEVER run an unfrozen NL goal.
3. **Confirm once** with the operator that the loop may run (MODE-2: this is the ONLY per-loop
   prompt until promotion — for an NL goal it is the SAME ASK that confirms the frozen criterion
   in step 2). Establish `runId`; make `.mutagent/optimize/runs/<runId>/`.
4. Write `config.json` = `{ goal, maxIters, budgetMs, noImprovementStreak, noiseFloor }` and
   `bun run scripts/loop-state-cli.ts assert-goal-legal config.json [--subject-kind <k>] [--artifact-format <f>]`
   — if it exits non-zero, the loop is NOT goal-legal (an unbounded field, an UNFROZEN NL goal, or a
   `code-quality` goal on a non-`code` `artifact.format`); surface the named problem and STOP (never
   run an unbounded / un-yardsticked loop). Pass `--artifact-format` to enforce the substrate → goal
   gate; `--subject-kind` (role) is validated but gates nothing.
5. `bun run scripts/loop-state-cli.ts init > loop-state.json` (the cursor).

> **⚠️ FLAGGED-FOR-OPERATOR-SIGN-OFF (Wave-2 W2I1) — the code-subject inferred-goal confirm-ASK.**
> When `*optimize` is invoked on a `code`-kind subject WITHOUT an explicit `--goal`, the goal is
> INFERRED as `code-quality` (the BOTH-gate). Because that is an inference, the session SHOULD confirm
> it at Entry (the ONLY per-loop prompt). The wording below is a **DRAFT** — surfaced here for the
> operator to approve/adjust; it is NOT baked as a final prompt, and code never surfaces it (the
> SESSION raises the ASK via `AskUserQuestion`):
> > *"I'll optimize the code subject **{subject}**. Converged means BOTH: its own test suite is green
> > AND a code-quality evaluator verdict passes (bounded by {maxIters} iters / {budget}). Proceed with
> > this `code-quality` goal, or pick a different goal (eval-pass · criterion · delta)?"*
> Confirm-once at Entry only — never ask per iteration (MODE-2). Adjust before shipping as the default.

**Per round (repeat until a terminator):** track elapsed wall-ms yourself as `budgetMs_spent`.

> **ONE INTAKE SHAPE (Wave-2 W2I2).** `AmendRequest` is the SINGLE amend contract the loop intakes.
> BOTH amend dialects enter S1 through the `accept-amend` accept-gate — the evaluator's
> `EddChangeRequest` (eval→optimize) and the diagnostics `Remedy` / RemedyPacket (diagnose→optimize) — so
> the S1 handover is NEVER a raw dialect and the two shapes cannot drift at the operating level:
> `bun run scripts/loop-state-cli.ts accept-amend <input.json> --dialect <eval|diagnostics> [--subject <s>] [--brief]`
> (a diagnostics remedy needs `--subject`; `--brief` prints the NL S1 build brief; `--dialect amend`
> re-validates an already-unified amend). It is lossless (round-trip-proven) and fail-loud on a
> malformed handover. Contract + adapters: `scripts/contracts/amend-request.ts`.

1. **S1 Build** — NORMALIZE the handover through `accept-amend` FIRST (→ an `AmendRequest`; use
   `--brief` for the NL build brief), THEN Task-dispatch **ai-engineer** (`#apply`, worktree-scoped)
   with that `AmendRequest`. It writes; it never mutates a spec on an impl-amend. (The first round has
   no amend — an empty handover — so this normalization applies from the diagnose-carry round onward.)
2. **S2 Verify** — Task-dispatch **ai-architect** (`#verify-remedy`) → read `PROCEED|STEER|ABORT`.
3. **S3+S4 Eval+Gate** — Task-dispatch **evaluator** (re-eval swing, judge-only) → read the
   `score` + the `GATE` verdict (`PASS|FAIL`) + any passed `criteria`.
4. **Record** — `loop-state-cli record-iteration loop-state.json config.json --verify <v> --gate <g>
   --score <n> --variance-regressed <true|false> --budget-ms <budgetMs_spent>` → **overwrite**
   `loop-state.json` with the printed cursor (it applies the variance-gate + streak for you).
5. **Decide** — `loop-state-cli check-terminators loop-state.json config.json --last-verify <v>
   [--criteria c1,c2]`. **Exit 3 + a reason** (`converged`/`no-improvement`/`max-iters`/`budget`/
   `aborted`) ⇒ STOP the loop → go to Promotion. **Exit 0 + `continue`** ⇒ keep going.
6. **Next phase** (when continuing) — `loop-state-cli next-phase S4-gate --gate <PASS|FAIL>`.
   **A PASS gate returns `terminal`** — the turn ENDS there; go to Promotion. **A PASS NEVER
   re-enters S1 / `accept-amend`**: the accept-gate sits ONLY on the initial handover (step 1) and
   the FAIL→diagnose carry (below). There is no PASS-loop. On `S5-diagnose` (a FAIL gate)
   Task-dispatch **diagnostics-analyzer** (RCA) → NORMALIZE its `Remedy` through the accept-gate
   (`accept-amend --dialect diagnostics --subject <s>` → an `AmendRequest`) BEFORE it becomes the
   next round's S1 handover; NEVER carry the raw diagnose remedy. On `S1-build` (a STEER)
   re-dispatch ai-engineer with the steer instructions.

**Code-target branch (Wave-2 W2I1 — a `code`-kind subject, `--goal code-quality`):** the round
shape is IDENTICAL (same S1→S5, same one opaque dispatch per phase, same PR-ORCH-01 discipline) —
only the crew's work and the recorded signals differ. Deltas, per phase:
1. **S1 Build** — ai-engineer runs its **code-target TDD inner loop** (test-first → lint → typecheck
   → build → **test** on the code subject). This inner loop is ai-engineer's OWN tool-loop — from
   your view it is ONE opaque dispatch (ai-engineer spawns no sub-agents). It returns whether the
   subject's OWN test suite is green (`testsGreen`), the hard deterministic half of the gate.
2. **S2 Verify** — ai-architect `#verify-remedy` (code-subject rubric) confirms the applied change is
   spec-faithful (def→impl cascade held), in-scope, non-destructive, and that the test suite it saw
   is actually green (claimed-green-but-red ⇒ ABORT).
3. **S3+S4 Eval+Gate** — the evaluator runs its **`#mode-judge-code-quality`** verdict (the (b) half
   — a host-runtime, C-PIN, judge-only quality verdict → `PASS|FAIL`). You ALSO carry the
   deterministic `testsGreen` from S1 into the record.
4. **Record** — the SAME `record-iteration` call, additionally passing **`--tests-green <true|false>`**
   (the S1 signal). The oracle stamps it on the cursor; the `code-quality` goal's `goalMet` ANDs it
   with the quality verdict. NEITHER alone converges: a green suite with a FAIL quality verdict, or a
   PASS quality verdict on a red suite, both keep looping (→ continue / no-improvement / max-iters /
   budget as usual). **Do NOT pre-AND them yourself** — pass both signals; the oracle decides.
5. **Decide / Next phase / Diagnose** — unchanged. The oracle stays consult-only; you never gain a
   code path that dispatches agents.

**Promotion (once, on any terminator):**
- Only `converged` (an above-live measured improvement) is eligible to promote; `no-improvement` /
  `budget` / `max-iters` / `aborted` STOP and promote **nothing**.
- Raise the **single human apply-gate** (`AskUserQuestion`). On approval, apply via the shared
  transport per §3 (`mutagent-cli apply --dry-run` → `--commit`). This is the only real-world write.

> **Do NOT** build a TS `CrewBindings` object that `await`s Task dispatches — that is the wrong
> shape (an awaiting script is not the session; a sub-agent can't dispatch). The interactive "crew
> binding" IS this procedure. The TS harness (`optimize-loop-run.ts`) exists only for unit tests +
> future headless verification.

## §3 — Apply is a call OUT to the shared service (DC-1)

optimize does NOT own an apply subcommand. At the promotion gate it collects the human
approval (AskUserQuestion), THEN shells the shared transport:

```
mutagent-cli apply --kind <code-pr|markdown|cloud-deploy|report-only> --target <root> ... --dry-run   # preview
mutagent-cli apply ... --commit                                                                        # write (after the gate)
mutagent-cli apply --rollback <apply-audit.json>                                                        # non-destructive revert
```

The CLI holds NO approval logic — the gate is a skill-layer decision, once, before the
transport (mirrors `mutagent-cli trace`: dumb fetch; the skill decides). Every commit
emits `.mutagent/apply/<id>/apply-audit.json` proving the approved thing is the applied
thing.

## §4 — Artifacts — `.mutagent/optimize/runs/<runId>/`

- `loop-state.json` — the FSM cursor: iteration · phase · per-iteration GATE · convergence
  delta · budget spent (goal-legal).
- `iterations/<n>/` — the handover in, the amend/apply diff, the ai-architect verdict, the
  re-eval scorecard.
- `apply-audit.json` — the absorbed dual-emit audit (stale-hash · transport · from/to ref ·
  revert-token) — the rollback ledger (written by `mutagent-cli apply`).
- `optimize-report.html` — per-iteration score trajectory + termination reason + convergence
  delta (opt-in via `--html`; a living, self-refreshing local report).

## §5 — Ownership doctrine (resolves the split-brain)

⑤ OPTIMIZE = mutagent-optimize: it conducts the loop and owns the gate; it delegates the
WRITE to ② builder, the JUDGE to ③ evaluator, the RCA to ④ diagnostics, and the TRANSPORT
to `mutagent-cli apply`. It writes nothing itself. (Replaces the three prior contradicting
surfaces: the builder `*optimize` route, the diagnostics apply-worker, and the evaluator's
`*optimize` EDD mode — the evaluator's EDD mode becomes optimize's re-eval ENGINE.)
