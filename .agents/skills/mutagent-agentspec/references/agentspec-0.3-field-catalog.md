# AgentSpec 0.3.0 — normative field catalog

> The human-readable normative catalog for the closed 0.3.0 resource envelope. The **machine** form
> is `scripts/contract/agentspec.schema.ts` (structural) + `scripts/validate/semantic-validator.ts`
> (semantic); this file is the field-by-field reference and the record of implementation resolutions.
> 0.3.0 is the **first canonical versioned baseline** (N01/F01) — there is no 0.2 migration or history.

## The envelope

```
apiVersion: agentspec.mutagent.io/v0.3.0   # D12/F01 — frozen compatibility contract; fail loudly on mismatch
kind:       Agent | Skill | MultiAgent | Workflow   # D01/D03 — inferred AFTER intent; strict discriminator
metadata:   { id, name, version, description }      # one coherent card identity (≠ apiVersion, ≠ package release)
spec:       { … }                                    # requirements-first, target-independent
```

### `status` — INTERNAL profile only (dev-internal; stripped on publish)

The **public** card has NO lifecycle bookkeeping. A **dev-internal** superset adds an optional
top-level `status` stamp recording where the subject sits in the ADL loop (operator rulings
2026-07-22 / 2026-07-23; ledger `ORCH-07` / catalog `R7`):

```
status:                                # INTERNAL-only — validateAgentSpecInternal accepts it;
  adl_stage:    evaluate               #   the PUBLIC schema REJECTS it as an unknown field.
  updated_at:   2026-07-23T12:00:00Z   # ISO-8601 UTC instant (pattern-enforced)
  last_verdict: "evaluate:PASS"        # STAGE-QUALIFIED "<stage>:<VERDICT>" (not a bare verdict)
```

- **Controlled extension, not a fork:** `AgentSpecInternalSchema` = the same `agentSpecRootProps` +
  an optional `status`. One contract file; one set of building blocks.
- **Closed three-field object:** `adl_stage ∈ {spec,build,evaluate,diagnose,optimize}` · `updated_at`
  ISO-8601 UTC · `last_verdict` stage-qualified. A **4th key fails**.
- **Stage-qualified `last_verdict`** (over a bare `PASS`) so the orchestrator build-index (loop
  position) and check-sync-spec (freshness) read WHICH stage produced the verdict without a 2nd lookup.
- **Never ships:** `sanitizeForPublish(card)` strips `status` (returns a public-valid card + the
  stripped keys — the SYNC-SOP mechanical proof); public validation rejects a status-bearing card
  (negative fixture `internal-status-on-public.yaml`).

Every object is **closed** (`additionalProperties:false`, F02) — an undeclared field is rejected.

## spec (universal)

| Field | Meaning | Required | Notes |
|---|---|---|---|
| `intent` | Requirements-first intent (see below) | ✅ | Precedes kind/target. |
| `context[]` | Inbound information + its read access (D16) | ✅ (may be empty) | |
| `actions[]` | Outbound side effects (D16) | ✅ (may be empty) | Kept separate from context. |
| `capabilities` | `{ code[], skills[], delegates[] }` | ✅ | Requirements before target selection. |
| `agent`\|`skill`\|`multiAgent`\|`workflow` | Exactly ONE kind-native body, matching `kind` | ✅ (the matching one) | Kind leakage → semantic fail. |
| `targets[]` | Destinations + generated-artifact contract | ✅ (may be empty, F05 draft) | |
| `evaluation` | `{ criteria[], scenarios[], datasets[] }` | ✅ (arrays may be empty, F05) | Universal closure. |
| `decisionsRef` | `./agentspec.decisions.md` — one colocated sidecar | optional | N03; relative sibling only. |

### spec.intent

`problem` (string) · `outcomes[]` · `sop[]` (long-form, **before** jobs) · `jobs[]` · `constraints[]` ·
`nonGoals[]` · `assumptions[]` · `unknowns[]`. All keys required (arrays may be empty). `sop[]` entry =
`{ id, when, description, onFailure? }`; `jobs[]` entry = `{ id, description, expectedOutput }`.
`unknowns[]` forces the Builder to stop-or-ask rather than guess.

### spec.context[] / spec.actions[]

- **context**: `{ id, description, modalities[], source, freshness?, sensitivity?, access }` where
  `access = { kind, ref, allowedOperations[], authRef? }` — read access nested with the information (D16).
- **actions**: `{ id, description, binding{kind,ref,authRef?}, allowedOperations[], approval{policy,when},
  evidence, onFailure }` — every outbound effect is bounded, gated, auditable, and safe on failure (D16).

`kind` on `access`/`binding` is a **CLOSED binding vocabulary** — `cli · saas · mcp · sdk · host-tool`
(operator ruling R3, 2026-07-22); an unlisted kind FAILS validation (fail-loud, F02). Future kinds
arrive via a 0.3.x minor bump.

### spec.targets[] (D08/D14/D15/N04)

`{ id, type: harness|framework|platform|custom, name, artifact{format: markdown|code|platform-config, path},
implementation?{language, toolchain}, capabilityFit, documentation[]{purpose, url} }`.
`artifact.format` **supersedes the prior `medium`** (FU-69). `implementation.*` is **code-only** (N04).

### spec.evaluation (D18/D19)

- `criteria[]` = `{ id, description, type: llm-judge|code-check, goal }` — binary, actionable.
- `scenarios[]` = `{ id, description, expectedBehavior, edgeCase? }`.
- `datasets[]` = `{ id, description, mapsTo{jobs?,scenarios?,criteria?}, categories[], caseDimensions?,
  items[]|itemsRef? }`. Categories are **dataset-local** (D18); `caseDimensions` model independent
  variation axes; `items[]` carry **kind-specific** `input`/`expected` payloads (opaque data).

## Kind bodies

- **agent**: `{ persona{role,description}, systemPrompt (sacred, verbatim), operatingType:
  conversational|automation|orchestrator, triggers[]?, workflow?{inline|ref} }`.
- **skill**: `{ purpose, invocation, instructions, inputs[], outputs[], resources[], hostRequirements[],
  failureBehavior, progressiveDisclosure, subagents[]? }` — host-loadable capability, **not** an Agent.
- **multiAgent**: `{ orchestrator, members[], relations{subagents{}, observes{}}, workflow{inline|ref} }`.
  Members are embedded cards (or `{specRef}`) reusing parent intent/context/actions by reference
  (`intentRef`/`contextRefs`/`actionRefs`); the dispatch graph must be **acyclic** (N02).
- **workflow**: `{ state, entry, nodes[] }` — the canonical graph, one dialect for standalone AND
  embedded use. Node = `{ id, description, executor?{kind, ref}, contextRefs?[], edges?[]{to,
  condition?, loop?{maxIterations?, exitWhen?}}, terminal? }`. The executor is the STRICT typed
  `{kind, ref}` (F03/R4; `kind ∈ {member|agent|skill|action|integration|code}`); required-input
  context reads live in the SEPARATE `contextRefs` node field, not in the executor. Any **returning
  edge** (a DFS back edge) must declare a loop bound — unbounded loops fail (N02).

## Semantic exit checks (`semantic-validator.ts`)

1. **Kind leakage** — exactly the body matching `kind`; no other kind's body.
2. **Workflow graphs** — entry resolves · edge targets resolve · terminal/edge consistency ·
   reachability · **bounded loops** · strict `executor {kind, ref}` resolves (kind `action`→actions,
   `member`→members) · the separate node `contextRefs` resolves to `spec.context` (R4).
3. **Multi-agent** — orchestrator resolves · unique member ids · relations resolve · **acyclic**
   dispatch graph · member `contextRefs`/`actionRefs`/`intentRef` resolve.
4. **Targets** — `implementation.*` only on `code` artifacts (N04).
5. **Decision sidecar** — `decisionsRef` is a colocated relative sibling `./name.md` (N03); the
   FS-aware half (file must exist) runs in `validateSpecFile`.
6. **Evaluation refs** — dataset `mapsTo`/`items` resolve to jobs/scenarios/criteria/categories/dimensions.

Valid fixtures: `assets/examples/{agent,skill,multiagent,workflow}-*/agentspec.yaml`.
Invalid fixtures (one violation each): `assets/fixtures/invalid/*.yaml`.

## Implementation resolutions (examples vs catalog divergences)

The PRD's four commented examples are the **locked architecture** (the concrete artifacts the DoD
requires to validate); the catalog table occasionally used a different label. Where they diverged, the
schema follows the **examples**, without reopening any LOCKED F/N/D ruling. Recorded here for review:

| # | Divergence | Resolution | Why |
|---|---|---|---|
| R1 | catalog `intent.goals[]` vs examples `outcomes[]` | `outcomes[]` | All four examples + the DoD language use `outcomes`; internally consistent. |
| R2 | catalog `members[].inline` wrapper vs examples embedding member cards directly under `members[]` | `members[]` holds an embedded card **or** `{specRef}` (no `inline:` wrapper) | Matches the concrete MultiAgent example. |
| R3 | binding `kind` "cli\|saas\|mcp" (issue prose) vs examples using `sdk`/`host-tool` too | **CLOSED enum `{cli\|saas\|mcp\|sdk\|host-tool}`; unlisted kinds FAIL** | **Operator ruling 2026-07-22** (decision brief w/ previews): fail-loud, consistent with F02's closed core; future kinds via 0.3.x minor bumps. *(Superseded the provisional open-string.)* |
| R4 | executor shape `{kind,ref}` (F03) vs examples `{actionRef}`/`{memberRef}`/`{contextRefs}` | **STRICT `executor: {kind, ref}`; `contextRefs` is a SEPARATE node field; provisional forms REMOVED** | **Operator ruling 2026-07-22**: F03's locked text wins over the PRD's internally-divergent examples; examples/fixtures rewritten; a negative fixture proves the removed forms fail. `executor.kind ∈ {member\|agent\|skill\|action\|integration\|code}`. *(Superseded the provisional all-optional shape.)* |
| R5 | "returning edge" bound (N02) — which edge in a cycle must carry the bound | the **DFS back edge** only, not the forward edges of the cycle | A reachability test wrongly flags forward edges; back-edge detection matches the example's single `loop:` edge. |
| R6 | `capabilities.skills`/`delegates` shown only empty in examples | `skills[]` and `delegates[]` = arrays of string ids | Lean; the only populated case (`delegates`) is member ids. |
| R7 | freshness/loop-state tracking — none in the public 0.2 contract ("the spec IS the subject record") | **INTERNAL-only top-level `status: {adl_stage, updated_at, last_verdict}`** — a controlled extension (`AgentSpecInternalSchema` superset, same file), **closed** (4th key fails), stripped on publish | **Operator rulings 2026-07-22 / 2026-07-23** (freshness HELD through rejected A/B/C designs, then re-scoped to an internal `status:` block + GO). Public schema REJECTS it (negative fixture `internal-status-on-public.yaml`); `sanitizeForPublish` strips it (mechanical proof). `last_verdict` is **stage-qualified** ("evaluate:PASS"). Supersedes 0.2 "no external registry" for internal loop tracking only. See ledger `ORCH-07`. |

Anything the Observer/operator judges wrong here is a fixable implementation detail, not a reopened
design ruling.
