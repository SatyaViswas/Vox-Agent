---
name: mutagent-ship
description: |
  The ADL ⑥ SHIP stage: the gated stage that takes a GATE-passed subject from
  evaluated → shipped. Three verbs in order — merge → monitor → watch. For the
  code / pull-request MVP target: MERGE a GitHub PR (with a standardized changelog
  + a ship-manifest), MONITOR CI to green (bounded mechanical refinement), then
  WATCH the newly-deployed agent's traces for regression — recommending an
  evidence-linked rollback, never performing one. Operator-only (INV-SHIP-1): no
  trigger, chain, agent, or script may launch *ship. Apply ≠ deploy (INV-SHIP-2):
  the spine stops at the operator merge gate; nothing here deploys as a side
  effect. THE FULL STAGE (P1–P4): entry gate → ship-manifest → PR → merge gate
  (P1) · the CI-green monitor FSM + bounded mechanical refinement (P2) ·
  post-deploy watch + evidence-linked rollback recommendation + revert-PR path +
  DIAGNOSE handoff + ship-report (P3) · the run-scoped ship-monitor system agent
  (P4). The decision/render cores are pure + tested; live CI polling, the fix
  actor's push, and trace acquisition are the steward/monitor's agent ops.
license: Apache-2.0
compatibility: Designed for Claude Code, Codex, Cursor, OpenCode and similar coding-agent runtimes; works with git, gh CLI, mutagent-cli, and Bun runtimes.
metadata:
  author: mutagent
  version: "0.1.0-alpha.0"
---

# mutagent-ship

The **ADL ⑥ SHIP** stage — the one owner of `*ship`, `*ship-status`, and
`*rollback`. It closes the ADL loop: after ③ EVALUATE returns `GATE = PASS`, SHIP
takes the subject to *shipped* through three verbs — **merge → monitor → watch**.

> **Spec of record:** `mutagent-system/.memory/features/adl-v3/ship-prd.md`
> (all rulings §10, target profiles §11, versioned activation §12, invariants
> INV-SHIP-1/2, diagrams §5). This SKILL.md is the operational contract; the PRD
> is the design authority.

> **This package is the FULL ⑥ SHIP stage (P1–P4).** What ships here as pure,
> deterministic, tested decision/render cores:
> - **P1** — `scripts/ship-manifest.ts` (schema + builder), `scripts/changelog.ts`
>   (six-section renderer + contract gate), `scripts/ship-status.ts` (read model).
> - **P2** — `scripts/refinement.ts` (evidence-based failure classification + the
>   KP-5 mechanical pre-grant / auto-revoke policy + the §4.6 ledger),
>   `scripts/ci-fsm.ts` (the §4 CI-green FSM + crash-recoverable `monitor-state.json`).
> - **P3** — `scripts/watch.ts` (§7 signals + flag rule + §6.4 rollback
>   recommendation), `scripts/rollback.ts` (the revert-PR path — OPENS a revert PR,
>   never merges), `scripts/diagnose-handoff.ts` (the §8 DIAGNOSE HandoverBundle),
>   `scripts/ship-report.ts` (ship-report md/html + 🏁 Final Status).
> - **P4** — `assets/agents/ship-monitor.md` (the run-scoped ship-monitor system
>   agent, ship PRD §6).
>
> The live surfaces — `gh pr checks` polling, the fix actor's mechanical push, and
> `mutagent-cli trace` acquisition — are the steward's / monitor's AGENT ops
> (pattern-inferred, ledgered in the PR); the pure cores above are what the tests
> prove.

## Named invariants (do not violate)

- **INV-SHIP-1 — operator-invoked only.** `*ship` / `*rollback` run ONLY on an
  explicit operator utterance. Enforced at the orchestrator routing/gate layer
  (`invocation: operator-only` → the `invocation-refused` gate blocker). There is
  deliberately no programmatic entry point.
- **INV-SHIP-2 — apply ≠ deploy.** Applying a change (writing code, opening a PR)
  is permitted ship work; deploying (merging to the deploy branch) is a
  separately gated act. The P1 spine ENDS at the operator merge gate — it never
  deploys as a side effect.
- **INV-SHIP-3 — explicit-and-gated.** No stage auto-advances; merge (and, later,
  non-mechanical refinement, activation, rollback) all gate on the operator.
- **INV-SHIP-4 — monitor never applies.** (P2/P3) the ship-monitor observes,
  classifies, and recommends — it never pushes, merges, activates, or rolls back.
- **INV-SHIP-5 — never auto-rollback.** Rollback is always an operator-gated act
  on an evidence-linked recommendation; there is no code path from a regression
  flag to a revert without a human in between.

## §0 — Setup Detection

> **Distribution: helix-bundled ONLY (operator ruling 2026-07-23).** There is NO
> standalone install channel for `mutagent-ship` — unlike evaluator/diagnostics,
> it is never `pnpx`-installed on its own. The ONLY path to the ⑥ SHIP stage is
> having Helix: `pnpx @mutagent/helix init` mounts this skill from the helix
> package (it is listed in helix's bundled `LIFECYCLE_SKILLS` + `files[]`). The
> `@mutagent/ship` workspace package is `private: true` — it exists for code
> separation (the stage owns its own logic, KP-2), not for publishing.

`mutagent-ship` is a sub-orchestration skill in the shape of evaluator/optimize:
the **parent session** (the "ship steward") owns the spine + every gate and
authors artifacts; it dispatches nothing to deploy anything. The skill ships PURE
decision/render models under `scripts/` — no provider key, no network at the
schema/render layer. All I/O (git, `gh`, `mutagent-cli trace`) is the steward's
job, invoked per the workflow below.

Artifacts live under the unified `.mutagent/` root (EV-REQ-058):
`.mutagent/ship/runs/<ship-id>/{ship-manifest.yaml, ship-report.{md,html}, monitor-state.json, watch/*.json}`.

## §1 — Commands

### `*ship <subject>` (operator-only · gated)

Take a GATE-passed subject from evaluated → shipped. All nine steps are
implemented (P1–P4): steps 1–3 + 6 as the P1 spine, steps 4–5 as the P2 CI FSM,
steps 7–9 as the P3 watch + rollback + report.

1. **Entry gate (PARENT).** Resolve the subject from the `*sync` topology; locate
   the latest evaluate verdict; **REFUSE** unless `GATE = PASS` (0 CRIT/HIGH) AND
   the verdict commit == the ship-candidate commit. Staleness is a refusal, not a
   warning. No verdict = no ship; there is no `--force`. Binds the evaluator's
   *current published verdict contract* (a `report`/`verdict` ArtifactRef,
   `0 CRIT/HIGH ⇒ PASS`), never its internals.
2. **Author the ship-manifest (PARENT + `scripts/ship-manifest.ts`).** Compose
   `ship-manifest.yaml` from the HandoverBundle + config + flags via
   `makeShipManifest`; `validateShipManifest` MUST pass (SHAPE + enums + ≤30
   watch cap + `rollback.policy: gated` + the installed-copy ⇒ `installed-confirmed`
   rule). `deploy_semantics` is chosen from the resolved target class
   (`direct-load | installed-copy`). Write under `.mutagent/ship/runs/<ship-id>/`.
3. **Open the PR (PARENT + `gh`).** Branch off the target's default branch; commit
   EXPLICIT paths only; **never `--no-verify`**. Render the standardized changelog
   body via `scripts/changelog.ts` (`resolveChangelogSource` → `renderChangelog`),
   assert `checkChangelogContract` holds (all six sections + Evidence & Provenance
   populated), then `gh pr create`.
4. **ARM the ship-monitor (PARENT → BG, P2/P4).** Spawn `assets/agents/ship-monitor.md`
   with `{ shipId, pr, manifestPath }`. It drives the §4 CI-poll FSM on the `ci`
   event lane (`scripts/ci-fsm.ts`), checkpointing `monitor-state.json` after every
   transition. **Parent stays interactive** for the gates — the operator is free to
   take new work once the monitor is armed (no busy-wait, no CI polling on the parent).
5. **On red CI → bounded mechanical refinement (P2, KP-5).** The monitor classifies
   the red check (`scripts/refinement.ts classifyFailure`) and the parent gates the
   fix (`evaluateRefinement`: mechanical pre-grant covers a mechanical touch; a
   non-mechanical touch AUTO-REVOKES the grant for the run; class `other` / budget
   exhausted → ESCALATE). The fix actor amends mechanically; never `--no-verify`,
   never weaken a test, never touch subject semantics.
6. **Merge gate (human + PARENT).** CI green → `AskUserQuestion` merge gate
   (INV-SHIP-2/3). Merge is the deploy for a direct-load target; the first hop for
   installed-copy.
7. **Deploy-confirm (P3, KP-3).** direct-load: the merge IS the deploy → the watch
   opens. installed-copy: the watch stays CLOSED until an installed-confirmation
   event arrives (an unconfirmed install never opens a watch).
8. **Post-deploy watch (P3).** Acquire the pre-ship baseline + the watch window via
   the 3 legal paths (`mutagent-cli trace`, §6.3), compute the §7 signals per
   interval (`scripts/watch.ts`), compare vs baseline (flag at any interval).
9. **Close (P3).** Clean → `scripts/ship-report.ts` ship-report + 🏁 Final Status,
   status=shipped. Regression → evidence-linked `rollback-recommendation.yaml`
   (`makeRollbackRecommendation`) + `HandoverBundle{adl_stage: diagnose}`
   (`scripts/diagnose-handoff.ts`); status=regression-flagged. **NEVER auto-rollback.**

Flags: `--watch <minutes>` (default 5, hard cap 30) ·
`--changelog-source <evaluate-report|build-report|git-log>` · `--no-watch`.

### `*ship-status [ship-id]` (read)

Read-only state surface (`scripts/ship-status.ts`): render the FSM state · PR ·
deploy-confirm · watch window · (P2/P3) CI timeline + signal deltas for one ship;
with no id, list `.mutagent/ship/runs/*` newest-first. **Artifacts on disk are
the ONLY source** — never re-poll CI or re-fetch traces from a status read.

### `*rollback <ship-id>` (operator-only · gated · P3)

Act on a rollback recommendation (or the operator's own judgment) via a REVERT PR
(`git revert <merge-sha>`) — evidence-linked, operator-approved, never automatic,
never destructive (INV-SHIP-5). `scripts/rollback.ts` decides + renders:
`assertRollbackable` (status ∈ {shipped, regression-flagged}) ·
`resolveRollbackEvidence` (a recommendation's trace refs OR a verbatim operator
reason, else REFUSED — no evidence-free rollback) · `renderRevertChangelog` (the
evidence-linked revert-PR body). Rollback **OPENS** the revert PR through the same
CI FSM and **never merges it** — the operator inspects and merges. The `git revert`
+ `gh pr create` are the steward's agent ops.

## §2 — The standardized PR changelog contract (§3 of the PRD)

Every ship PR body is RENDERED from the manifest + changelog source — never
freehand. Six MANDATORY sections: **Problem · Solution · Changes · Evidence &
Provenance · Verification · Risks & Limitations**. A missing section fails
`checkChangelogContract`. Source precedence (KP-7): **evaluate > build > git-log**.
`## Evidence & Provenance` is the audit spine (evaluate verdict + commit + manifest
path + source declaration) — it is what makes the PR self-auditing. The body is
leak-safe by construction: subject paths + artifact refs only, never raw trace
content or private-org names.

Every ship PR also gets a closing **🏁 Final Status** comment at terminal status
(Decisions + WHYs) — the standing house convention.

## §3 — Scripts (the tested pure surface)

| Path | What |
|---|---|
| `scripts/ship-manifest.ts` | `ShipManifestSchema` (TypeBox, closed, frozen `manifest_version`) + `validateShipManifest` (shape + ≤30 cap + installed-copy cross-field rule) + pure `makeShipManifest` builder (deterministic; deploy.confirm DERIVED from deploy semantics). |
| `scripts/changelog.ts` | `resolveChangelogSource` (KP-7 precedence) + `renderChangelog` (six-section body) + `checkChangelogContract` (the gate). |
| `scripts/ship-status.ts` | `buildShipStatusView` / `listShipRuns` (newest-first) + render helpers — pure read models over injected on-disk manifests. |
| `scripts/refinement.ts` (P2) | `classifyFailure` (log → lint\|typecheck\|build\|test\|other + excerpt) · `evaluateRefinement` (the KP-5 decision: refine\|escalate · within-grant · auto-revoke · bounded budget · pre-existing) · the §4.6 ledger. |
| `scripts/ci-fsm.ts` (P2) | `stepCiFsm` (the §4 FSM reducer; illegal edges refused) + `ShipMonitorState` (TypeBox checkpoint, crash-recoverable) + `applyTransition` (step + append timeline/ledger/history immutably). |
| `scripts/watch.ts` (P3) | `aggregateInterval` + `flagRegression` (§7.2 delta ∨ twice-in-window; §7.3 cold signals-only) + `makeRollbackRecommendation`/validate (§6.4, evidence-linked). |
| `scripts/rollback.ts` (P3) | `assertRollbackable` + `resolveRollbackEvidence` (evidence-linkage invariant) + `renderRevertChangelog` (the revert-PR body). |
| `scripts/diagnose-handoff.ts` (P3) | `makeDiagnoseHandover` — the `HandoverBundle{adl_stage: diagnose}` (§8), mirroring the frozen v0.2.0 contract by convention. |
| `scripts/ship-report.ts` (P3) | `renderShipReportMarkdown` / `renderShipReportHtml` + `renderFinalStatusComment` (§8 + §3, Decisions + WHYs). |
| `assets/agents/ship-monitor.md` (P4) | The run-scoped ship-monitor system agent (ship PRD §6) — minimal frontmatter + one body `yaml` operating block. |

## §4 — Testing honesty

The tests prove the PURE decision/render cores end-to-end: schema validation +
manifest round-trip, the ≤30 watch cap + installed-copy cross-field rule, the
changelog contract, the `*ship-status` read model (P1); the CI FSM topology +
failure classification + KP-5 grant/auto-revoke + budget + crash-recoverable
checkpoint round-trip (P2); the §7 flag rule (delta, twice-in-window, cold mode)
+ the §6.4 evidence-linkage invariant + the revert-PR body contract + the DIAGNOSE
handoff shape + the ship-report/Final-Status rendering (P3).

The LIVE surfaces are agent-orchestrated and pattern-inferred (NOT end-to-end
test-proven), ledgered per-surface in the PR body: the runtime monitor loop —
`gh pr checks` poll cadence, the **event-bus `ci` / `trace-count` lane wiring**
(CONSUMED from `mutagent-orchestrator/scripts/monitor/{event-bus,daemon-control}.ts`,
never reimplemented), and `mutagent-cli trace` acquisition (the 3 legal paths);
the LLM red-check classification floor; the fix actor's mechanical push; the
operator gates (`AskUserQuestion`); and the steward's real `git revert` +
`gh pr create`. The ship-monitor (`assets/agents/ship-monitor.md`) shells out to
the pure cores above and reasons only for red-check classification + honest
evidence phrasing.
