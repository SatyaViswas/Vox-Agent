# mutagent-builder — BUILD Protocol

`mutagent-builder` is the authoritative ADL **② BUILD** owner. It implements validated AgentSpec 0.3.0
resource cards; it does not specify new agents and does not judge eval outcomes. BUILD has TWO internal
phases — **PLAN → BUILD** — both owned by the Builder team (N05): the AI engineer expands the existing
`*plan-layout` / `#plan-repo-hierarchy` capability into a complete, doc-grounded translation plan, the
AI architect checks it **read-only** (READY | BLOCKED) **before any target write**, and only then the
same engineer executes the READY plan tests-first. This adds NO new stage, command, schema, or run file
— the plan lives in the PLAN section of the existing build report.

## Inputs

A BUILD run requires:

1. a structurally + semantically valid `agentspec.yaml` (AgentSpec 0.3.0) — run the full validator, not
   a field spot-check;
2. the optional colocated `agentspec.decisions.md` when the card sets `spec.decisionsRef` (the pair is
   one bundle);
3. target root(s);
4. an EXPLICIT target selection — a `spec.targets[].id` (or set) — REQUIRED when the card declares more
   than one target; a single target may default;
5. per selected target: `type` (harness|framework|platform|custom) · `name` · `artifact.format`/`path` ·
   `documentation[]` (crawled FRESH at build time) · optional `implementation.language`/`toolchain`
   (code artifacts only);
6. optional approved remedy or EDD change request.

Run `scripts/cli/run.sh scripts/handoff/validate-build-input.ts --spec <agentspec.yaml> --target <target-root>`
before dispatch when the parent session needs a deterministic input preflight.

## 0.3.0 Build flow (B0–B9)

| # | Phase | What happens |
|---|---|---|
| B0 | **Receive** | approved resource card with one `kind` and one-or-many `targets[]`. |
| B1 | **Select target(s)** | resolve the explicit target id/set; a single target may default. |
| B2 | **Preflight** | call the structural+semantic validator; confirm the kind body, resolved inbound `context[].access`, bounded `actions[]`, `artifact.format`/`path`, code `implementation`, `documentation[]`, capability fit, and the decision bundle. Route by **kind × selected target's type/name/artifact.format** (+ `implementation.language/toolchain` for generated code). |
| B3 | **PLAN** | engineer reads spec + target docs (fresh) + repo, and maps **each build-relevant requirement → target primitive/file/test/evidence**. Writes the frozen PLAN section of the build report (goal-based task grammar below). **No target writes.** |
| B4 | **Plan check** | architect checks the PLAN read-only against spec + docs + repo state: **READY** or **BLOCKED** (reason / operator question). **Still no target writes.** |
| B5 | **Engineer** | execute the READY plan — **tests first**, then implement. The engineer executes the checked plan, not an improvised structure. |
| B6 | **Gates** | lint · typecheck · build · test · coverage (`spec-impl-coverage.ts`) · target smoke. |
| B7 | **Verify** | architect independently re-checks actual output against spec + approved plan + cited docs (fidelity table). |
| B8 | **Disposition** | exactly one verdict: `PROCEED` · `STEER` (bounded amendment, cited) · `ABORT` (escalate, cited). |
| B9 | **Report** | plan-to-actual delta · fidelity/loss · EVALUATE handoff. |

> **Brownfield / drift first.** Before B3, `ai-architect` may run `*sync-spec` when the implementation is
> brownfield or target code is newer than the spec:
> `scripts/cli/run.sh scripts/sync-spec/check-sync-spec.ts --spec <agentspec.yaml?> --target <target-root> [--json]`.
> On `missing-spec`/`needs-sync` it performs read-only analysis and emits a cited sync plan; `ai-engineer`
> applies the spec update under the gate, `*validate-spec` re-gates, and only then BUILD continues.

## Goal-based PLAN contract — what "complete" means

**A file list is not a plan.** Every implementation task in the frozen PLAN needs: a user-observable
**goal**, a bounded **task**, the **exact artifacts** (path/binding), the selected target
**components/primitives with rationale + doc source**, dependencies, and one or more **checks with
expected results**. A task cannot be READY when success depends only on "looks correct" or on an uncited
framework assumption. Behavioral checks that belong to EVALUATE are marked as such (not run at BUILD).

The architect **refuses READY** when a task lacks a verifiable outcome, an exact artifact, a justified
component choice, or a check/expected-result. A BLOCKED plan states the missing evidence or the operator
question. No separate plan parser, schema, or command is introduced — this is the PLAN section of
`assets/templates/build-report.md.tpl`, frozen before writes and checked read-only.

## Multi-target + custom-target resolver

Resolve **each selected target independently**. Load its `documentation[]` by purpose and extract, into
an in-memory checklist: file shape, conventions, available context/action bindings, commands,
registration/deployment, and verification. A **custom** target is a normal target with path + doc
references — its conventions come from its linked authoritative docs, NOT a schema extension (F02). A
missing capability fit, path, artifact format, dead/contradictory guidance, or unsupported action
boundary **blocks only that target** and is reported as a gap — it does not fail the others.

## Per-kind implementation paths (trace intent → target → tests → evidence)

- **Agent** — persona/prompt fidelity, triggers, context/action bindings, skills/delegation, canonical
  Workflow use, observability, tests. Map every intent SOP + derived job to Agent design → target output
  → tests → evidence (SOP/jobs are shared intent, not Agent-only fields). Proof: the same intent builds
  into at least a **markdown harness** target AND a **code-framework** target without changing normative intent.
- **Skill** — build a real skill package/instruction surface from Skill intent (do NOT route through the
  unreleased Skill Builder). Trace purpose · activation/when-to-use · inputs/outputs · instruction
  workflow · references · scripts/assets · host tools · failure behavior · verification. Proof: fresh
  Claude and Codex installs discover and execute the built Skill as specified.
- **MultiAgent** — build the envelope, each embedded full member spec, the root orchestrator, and the
  declared dispatch/watch wiring WITHOUT flattening members into labels. Trace member identity/version,
  optional member intent ref, skills/subagents/observes resolution, composition order, deployment shape,
  whole-system verification. Proof: dangling members are rejected; dispatch and observation stay distinct.
- **Workflow** — build/emit the target's native graph from the shared state/nodes/edges vocabulary. Trace
  entry + terminal nodes, edge targets/conditions, state contract, reachability, and **explicit
  bounded-loop evidence**. Proof: a returning edge passes ONLY with an enforceable `exitWhen`/`maxIterations`;
  unbounded loops, missing edge targets, and unreported target limitations FAIL.

## Coverage + fidelity gates

Keep `@implements` module/test coverage for code tools where applicable (`spec-impl-coverage.ts`). Add
profile-aware checks for all implementation-bearing requirements, context/action operation boundaries,
retained LLM-facing descriptions, and explicit **unsupported/weakened dispositions**. New conformance
fixtures live under the builder scripts tree.

## Architect checkpoints — PLAN check + VERIFY (read-only boundary)

The architect stays **read-only** (source writes forbidden; only verdict artifacts allowed). Before BUILD
it checks the engineer's PLAN against spec + target docs + repo state (READY | BLOCKED). After BUILD it
independently checks actual output against spec + approved plan + cited docs, producing a
field/requirement **fidelity table**, verifying operator-approved exceptions, **rejecting unreported
loss**, and reporting every plan-to-actual deviation with an evidence-linked `PROCEED`/`STEER`/`ABORT`.

## Build report

Use `assets/templates/build-report.md.tpl`. The **PLAN** section is completed and architect-checked
READY **before** any target write; the **BUILD RESULT** section records actual evidence and deviations
after execution. Include: spec identity/version + `metadata.id`; selected target id/type/name +
artifact.format/path (+ code implementation details); pinned docs crawled; goal-based PLAN task table +
READY/BLOCKED; files written; TDD commands + results; `spec-impl-coverage` table; the fidelity/loss
table (silence about loss is a failure); verifier verdict; EVALUATE handoff paths.

## Handoff to EVALUATE

The handoff bundle contains `agentspec.yaml` (+ `agentspec.decisions.md` when referenced), the build
report, the implementation root, the trace/output sink location, and any `ChangeRequestResponse` when
BUILD was triggered by EDD. When code changed ahead of truth, the report also carries reverse-sync status
and the pending operator decision (Wave-3 lifecycle sync).
