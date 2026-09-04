# Operation Inventory — LLM-only / Code-only / Hybrid Classification

> Every evaluator action is classified into exactly one of three types. No overlap.
> This inventory is the **source of truth the script-austerity audit enforces**: a
> script may be Code-only or the deterministic half of a Hybrid — it may NEVER hold
> LLM-reasoning prompt prose or make a pass/fail decision. That reasoning belongs in
> a subagent def (`assets/agents/{evaluator,audit-executor}.md`).
>
> Mirrors the SHAPE of `mutagent-diagnostics` `references/operation-inventory.md`
> (sealed-sibling: shape mirrored, never source-referenced). Diagnostics' Type
> A/B/C map onto this skill's vocabulary as: **Type A = Code-only (script)** ·
> **Type B = LLM-only (subagent)** · **Type C = Hybrid (agent invokes script)**.

## Classification Rules

- **Code-only — Type A — Pure Script**: deterministic logic, structured I/O.
  TypeScript, invoked via `Bash("scripts/cli/run.sh scripts/<name>.ts ...")`. Zero
  LLM calls, no provider SDK on the default path. Unit-testable in isolation with a
  stub. PURE (no clock / random / network in the core).
- **LLM-only — Type B — Agent Operation**: host-runtime reasoning by a dispatched
  `pure_subagent_executor` (`Agent({subagent_type})`), or an `AskUserQuestion` /
  chat-fallback HITL gate. The reasoning RUBRIC lives in the subagent def, never in
  a script. Cannot be unit-tested in isolation.
- **Hybrid — Type C**: the parent session invokes a Code-only script for the
  deterministic shape, dispatches a subagent for the reasoning, and reads the
  structured output back. The agent decides *when/how* to invoke; the script
  decides *nothing* about the verdict.

> **The judging pattern is Hybrid by construction (agent-dispatch DEFAULT):**
> `PREP (Code-only script → task/packet files) → DISPATCH (LLM-only subagent →
> verdict files) → AGGREGATE (Code-only script → labels / scorecard)`. The verdict
> NEVER comes from a script calling a provider; it comes from a host-runtime
> subagent, read back from a verdict FILE (`references/workflows/orchestrator-protocol.md`).

---

## Type A — Code-only (Pure Scripts)

Deterministic. Zero LLM on the default path. A stub `JudgeInvoke` (a file read, or a
fixed JSON string) satisfies the gate.

### v2 eval-development engine

| Op | File | Why Code-only |
|----|------|---------------|
| Eval-matrix × trajectory PREP+AGGREGATE | `scripts/matrix-judge.ts` | Builds the per-trajectory DATA packet (whole matrix + trajectory + transcript) and folds the Judge Agent verdict files into the GATE rollup. **No judge prompt, no LLM** — reasoning is the Judge Agent's (`assets/agents/evaluator.md#mode-judge-trajectory`). |
| Eval-matrix × trajectory data contract | `scripts/contracts/eval-matrix.ts` | TypeBox shapes (MatrixCriterion/Packet/Verdict) + `parseMatrixVerdictFile`/`assertMatrixPacket`. Schema + validation only. |
| Agent-dispatch transport | `scripts/agent-dispatch.ts` | `promptHash` content key · `writeJudgeTask` (PREP) · `createAgentDispatchJudge` (AGGREGATE = **reads a verdict file**, no LLM) · `missingVerdictKeys`. The DEFAULT judge transport. |
| Determiner + judge PREP | `scripts/prep-tasks.ts` | `prepDeterminerTasks` / `prepJudgeTasks` — emit task-spec files (the exact prompt + pinned envelope). Reads stage-A verdicts to build stage-B; never decides. |
| Determiner DATA (EV-042) | `scripts/determine-outcome.ts` | **Slimmed to Type A (austerity):** `extractOutcomeSignals` (signal prep — toolCount is a signal, never a verdict) · `parseCritiqueVerdict` (critique-before-verdict schema gate) · `assembleOutcome` (deterministic verdict + signals → result). NO judge prompt, NO LLM. The success/failure DECISION is `evaluator.md#mode-discover`'s. |
| Judge-spec DATA (EV-043) | `scripts/build-evals.ts` | **Slimmed to Type A (austerity):** `splitTrainEval` (held-out split) · `assertExemplarsFromTrain` (leakage guard) · `buildJudgeSpec` (4-component SPEC DATA, no Likert). NO judge prompt, NO LLM. The judging rubric is `evaluator.md#mode-judge-criterion`'s. |
| Judge-prompt renderer (EV-050 EXCEPTION) | `scripts/judge-prompt-template.ts` | The ONE place a judge prompt is rendered — the operator-named export/in-house **exception** (templating, not skill-triggered judging). Holds `buildOutcomePrompt`/`buildJudgePrompt` + the in-house/export run-wrappers `determineOutcome`/`runJudge`. **The DEFAULT agent-dispatch path NEVER imports it**; the subagent defs are the rubric source-of-truth, this is their provider-call mirror. |
| GATE + variance rollup | `scripts/evaluate.ts` | `evaluateGate` (severity-gated binary) · `evalScoreVariance` · `trajectoryVariance` · `rollupScorecard`. Pure math over verdicts. |
| Emergent-criteria remainder | `scripts/discover-criteria.ts` | `failureRates` · `deriveCriteria` · saturation detection. The clustering itself is the evaluator `#mode-discover`'s job; this is the deterministic aggregate over its labels. |
| Balanced sampling | `scripts/sample-traces.ts` | Random + outlier + failure-driven + uncertainty + stratified ✓/✗ sampling. Deterministic math (re-implements the diagnostics filtering PATTERN; never imports it). |
| Subject auto-gen core | `scripts/profile-subject.ts` | Infer tool inventory + event taxonomy from `observations[].type=="TOOL"` frequency. Pure trace stats. |
| Route-failures handoff | `scripts/route-failures.ts` | `routeFailures` / `validateHandoverBundle` — serialize a diagnostics-handoff bundle. EV-051 judge-only: emits, never fixes. |
| UniTF trace intake | `scripts/read-unitf-traces.ts` + `scripts/unitf-to-evaltrace.ts` | `parseUnitfJsonl` / `readUnitfAsEvalTraces` — read the handed-over UniTF `.jsonl` (`mutagent-cli trace fetch --export` output) → `EvalTrace[]` via `projectUnitfToEvalTrace`. Tolerant parse; malformed/non-UniTF lines skipped+counted. The skill NEVER fetches (`mutagent-cli trace --help`). |
| Profile loader | `scripts/load-profile.ts` | YAML parse + TypeBox validation of `subjects/<name>/*.yaml`. |
| Shared v2 contracts | `scripts/contracts/eval-types.ts` | TraceLabel · Category · CriterionSpec · JudgeVerdict · Scorecard type defs. |
| Byte-identity masking | `scripts/mask.ts` | C-PIN: strips runId / timestamps / abs-paths so reruns are byte-identical. |
| Substrate selection | `scripts/substrate.ts` | `resolveJudgeRuntime` / `judgeForRuntime` — returns the chosen `JudgeInvoke` seam (default = agent-dispatch file read). Selection logic only; holds no prompt. |
| PREP I/O shell | `scripts/cli/prep.ts` | Writes task-spec files over the tested PREP cores. Calls NO LLM / NO provider. |
| Runner | `scripts/cli/run.sh` | bun→pnpm→npm dispatch. |
| Publish guard | `scripts/release/prepublish-guard.mjs` | Leak/version-mismatch pre-publish checks. |

### v2 eval-development engine — W2 (trust + data)

Deterministic shape for the W2 trust+data track. Each holds NO judge prompt and
makes NO pass/fail decision; the LLM/HITL halves are Type B (below).

| Op | File | Why Code-only |
|----|------|---------------|
| `*validate` stats (EV-044) | `scripts/validate-judge.ts` | Confusion matrix → TPR/TNR (not raw accuracy) · split-disjointness + TEST-ONCE guards · Rogan-Gladen θ=(p_obs+TNR−1)/(TPR+TNR−1) w/ clip + invalid-when denom≈0 · DETERMINISTIC seeded-LCG bootstrap CI (no Math.random) · graceful `unvalidated` degradation under MIN_LABELS. Pure math; the verdicts it consumes come from dispatched evaluator (`#mode-judge-criterion`) files. The Code half of the `*validate` Hybrid (mostly CODE). |
| `*review` UI render (EV-045) | `scripts/build-review-ui.ts` | `renderReviewUi` — DETERMINISTIC HTML annotation interface (one trace/screen, native-format render, Pass/Fail/Defer, notes, keyboard, localStorage auto-save, labels export) + `mergeLabels` (round-trip + dedup by traceId). Holds NO judge prompt; the HUMAN decides. The Code half of the `*review` Hybrid (CODE render + HITL label). |
| `*build-dataset` expand (EV-046) | `scripts/build-dataset.ts` | `buildCase` · cartesian dimension×value expand · deterministic token-Jaccard near-dup removal · content-derived id · `mergeCases` MONOTONIC merge. The agent PROPOSES realism; the script ENFORCES non-redundancy. Code half of the 3-way `*build-dataset` Hybrid. |
| `*discover-dataset` distill (EV-047) | `scripts/derive-dataset.ts` | Distill a living regression set from past ✓/✗ — reuses EV-052 `sample-traces.ts` selectors (failure/outlier/uncertainty) + EV-046 monotonic merge; trace→`DatasetCase` whose query IS the real input. Labels already on traces (from `*discover-evals`); makes NO new decision. Type A Code-only. |
| Living-suite writer (EV-053) | `scripts/living-suite.ts` | `appendOnly` + `assertMonotonicGrowth` — generic-over-`T` append-only writer (a living artifact NEVER shrinks) shared by datasets + criteria. Pure-counter provenance (no clock → byte-identity, C-PIN). Pure set algebra w/ fail-loud monotonicity guard. |
| Eval-leg reconcile contract (W2I5 · KP-003) | `scripts/sync-eval-criteria.ts` | The eval leg of `#sync-spec` (def → impl → eval triad). `evalLegForSubjectKind` (agent/skill → eval-suite · code → code-quality) · `flagEvalLegDrift`/`assessEvalLeg` (pure freshness flag) · `reconcileEvalCriteria` (upsert-by-id criteria MAINTENANCE via `assertMonotonicGrowth` — never drops, EV-053). Criteria maintenance, NOT judging (EV-051): scores nothing, decides no pass/fail. The reconcile REASONING is `ai-architect #sync-spec`'s (Model-B); this holds only the deterministic contract. Pure (no clock/random/network, C-PIN). |
| W2 dataset contract | `scripts/contracts/dataset.ts` | TypeBox `Dimension`/`DatasetTuple`/`DatasetCase`/`Dataset` (companion to `schemas/dataset.schema.yaml`) + `tupleKey`. NEW W2-OWN file — does NOT touch shared `contracts/eval-types.ts`. Data contract only. |
| W2 trust contract | `scripts/contracts/validation.ts` | TypeBox `HumanLabel` (produced by `*review`, consumed by `*validate`) + the confusion-matrix / validation-result shapes. NEW W2-OWN file; disjoint from shared types. Data contract only. |

### v2 eval-development engine — W3 (scale + context-flow / UI audit)

The W3 deterministic enablers: `flow-graph.ts` lets the evaluator SEE an agent's
context-flow; `ui-slots.ts` does the HTML-artifact missing-data cross-ref. The
judge interprets severity (Type B context-flow-lens, below).

| Op | File | Why Code-only |
|----|------|---------------|
| Trace→flow-graph (EV-032) | `scripts/flow-graph.ts` | THE FOUNDATION — deterministic adapter: `EvalTrace` (events + TOOL obs + sub-agent dispatches) → subject-agnostic info-flow graph (producer/consumer nodes · data-handoff edges) + `diffExpectedFlow` (which expected threadings are missing). Threading = deterministic verbatim content-overlap signal. Sub-agent vocab SUPPLIED via opts (EV-049/037), never a constant. Pure. |
| HTML missing-data audit (EV-039/040) | `scripts/ui-slots.ts` | Cross-refs a PROFILE-SUPPLIED `expectedUiSlots` (EV-037, NOT v1 hardcoded slot names) against computed values + published HTML → classifies each slot computed-but-not-rendered (039, locus UI cls B) · orphan (039) · faithful. Works on the HTML-only path (v1 OUTSIDER FALLBACK promoted to first-class). Flags verbatim presence/absence only; nuanced faithfulness (040 altered/truncated) left to the judge. Pure. |
| W3 flow contract | `scripts/contracts/flow-graph.ts` | TypeBox info-flow-graph (EV-032) + expected-flow profile (EV-037) shapes + `FlowEdgeKind` (no magic strings). NEW W3-OWN file — deliberately disjoint from shared `eval-types.ts` + v1 `types.ts` so shared types stay frozen. Subject-agnostic; pure. |
| Expected-flow auto-gen (EV-037) | `scripts/profile-subject.ts` (extended) | Adds the `expectedFlow` / `expectedUiSlots` section to the auto-generated subject profile (EV-049, never hand-authored) — the spec `diffExpectedFlow` + `ui-slots.ts` diff against. Pure trace stats. |
| Agent-appropriate variance (EV-054) | `scripts/evaluate.ts` (deepened) | N-rerun harness → `evalScoreVariance` (eval-score flap across N scorecards) · `trajectoryVariance` / `trajectoryShapeVariance` (distinct tool-trajectory + turn/sub-agent-count spread ACROSS reruns) · `trajectoryFlowDivergence` (one observed trajectory vs the subject's **expected information-flow**, EV-037, per expected edge). The "vs expected-flow" comparison is `trajectoryFlowDivergence` — NOT `trajectoryVariance` (which is rerun-to-rerun distinctness). Pure stats over verdicts. |
| Mask-on-handoff (carry) | `scripts/route-failures.ts` (extended) | Wraps the diagnostics-handoff bundle in `mask.ts` (`maskValue`/`maskedCanonicalJson`) — masks `produced_at` + abs artifact `path` before serialize. Dogfoods the data-leak audit on the evaluator's OWN output (restores C-PIN byte-identity; no home-path leak). Type A. |

### v2 eval-development engine — W4 (eval-of-the-eval / self-QA)

The deterministic half of the meta-skill: `self-audit.ts` runs the eval-audit
six-area diagnostic over the evaluator's OWN eval-dev artifacts. It REUSES the
existing outputs (`*validate` `ValidationResult[]` · `*review` `HumanLabel[]` ·
`*discover-evals` `DiscoveredCriterion[]` · living-suite provenance) — it rebuilds
nothing. The nuanced reads + overall verdict are Type B (below).

| Op | File | Why Code-only |
|----|------|---------------|
| Eval-of-the-eval checks (EV-055) | `scripts/self-audit.ts` | The eval-audit six-area diagnostic as PURE threshold checks over the evaluator's own artifacts: `auditErrorAnalysis` (supportCount grounding) · `auditEvaluatorDesign` (code-before-judge) · `auditJudgeValidation` + `auditUncalibratedJudges` (status / TPR≥`TARGET_TPR` / TNR≥`TARGET_TNR`, reused from `validate-judge.ts`) · `auditHumanReview` (decided labels exist) · `auditLabeledData` (≥`MIN_LABELS_PER_CLASS` each) · `auditPipelineHygiene` (monotonic-growth + C-PIN re-validation). Emits impact-ordered FINDING DATA + a deterministic per-finding `status`; holds NO judge prose, makes NO subjective verdict. PURE (no clock/random/network → byte-identical report). |

### v1 4-tab static-auditor (KEEP — EV-001..027)

| Op | File | Why Code-only |
|----|------|---------------|
| Two-track scorecard | `scripts/assemble-scorecard.ts` | GATE + 15-dim TREND rollup, stable ordering. |
| Deterministic rows | `scripts/run-deterministic.ts` | Tab-1 deterministic checks (typebox-schema / gate); judge rows emitted as skip placeholders. |
| Pinned-judge applicator | `scripts/run-judge.ts` (v1) | `applyJudgeVerdicts` — consumes a CALLER-SUPPLIED verdict map keyed by row id. The inner, testable half; the live judge is a workflow-layer seam, never in this script. |
| 15-dim variance | `scripts/variance-compare.ts` | Compares two masked bundles on the fixed determinism scorecard. |
| 4-tab HTML render | `scripts/render-report.ts` | Template + scorecard → HTML (own Mutagent brand asset). |
| Run-bundle loader | `scripts/load-bundle.ts` | Discovers + parses run artifacts into a validated `RunBundle`. |
| v1 shared contracts | `scripts/contracts/types.ts` | Criterion · Scorecard · Severity type defs. |
| Variance coordinator CLI | `scripts/cli/variance-check.ts` | Fully-wired deterministic 2-bundle delta — no judge, no model. |
| Mode A harness CLI | `scripts/cli/audit-run.ts` | Loads profile+bundle, deterministic pass, assemble, render. |

---

## Type B — LLM-only (Agent Operations)

Host-runtime reasoning by a dispatched subagent, or a HITL gate. The rubric lives in
the subagent def, NEVER in a script.

| Op | Agent action | Rubric home |
|----|--------------|-------------|
| **Eval-matrix × trajectory judging (DEFAULT)** | `Agent({subagent_type: 'evaluator', run_in_background: true})` — `#mode-judge-trajectory`: one judge per trajectory scores the WHOLE matrix | `assets/agents/evaluator.md#mode-judge-trajectory` |
| Success/failure determination (EV-042) | `Agent({subagent_type: 'evaluator'})` — `#mode-discover`: deep-read trace → goal-attained pass/fail ("inaction can be success") | `assets/agents/evaluator.md#mode-discover` |
| Emergent-criteria clustering (EV-041) | evaluator `#mode-discover` — first-thing-wrong → emergent BINARY ACTIONABLE categories (never a pre-defined list) | `assets/agents/evaluator.md#mode-discover` |
| Per-criterion judging (ALTERNATE axis) | `Agent({subagent_type: 'evaluator'})` — `#mode-judge-criterion`: one binary+confidence judge per `(criterion × trace-slice)` | `assets/agents/evaluator.md#mode-judge-criterion` |
| v1 behavioral-row judging (`*audit`) | `Agent({subagent_type: 'audit-executor'})` — pinned LLM-judge over behavior-tree rows | `assets/agents/audit-executor.md` + `lenses/*.md` |
| **Dataset generation (EV-046)** | `Agent({subagent_type: 'dataset-builder'})` — generate dimension tuples → NL queries → quality-filter for realism (generate-synthetic-data Steps 1-5). GENERATOR, NOT judge (host leaf). The deterministic expand/dedup is `build-dataset.ts`. | `assets/agents/dataset-builder.md` |
| **Context-flow judging (EV-028/029, `*audit`)** | `audit-executor` reasons over the flow-graph (EV-032) + expected-flow (EV-037): was a tool-result THREADED at step N+k or dropped (028)? does a sub-agent dispatch brief carry the context the child needs vs expected-flow (029)? Emits `LEAK_SCHEMA` leaks (locus C2C, cls B). | `lenses/context-flow-lens.md` |
| **HTML-artifact faithfulness (EV-040, `*audit`)** | judge confirms a value present in BOTH computed + rendered but ALTERED/truncated in the UI (the nuanced case `ui-slots.ts` cannot flag verbatim). | `lenses/context-flow-lens.md` + `data-leak.workflow.js` |
| **Eval-of-the-eval nuance (EV-055, `*self-audit`)** | `Agent({subagent_type: 'audit-executor'})` Mode D — over the `self-audit.ts` finding DATA, the nuanced reads the thresholds can't decide (is a criterion *actionable* vs generic? does a judge prompt target ONE failure mode?) + the overall eval-of-the-eval verdict. Host-runtime, NO provider key / NO Gemini. **On-demand only** (no cron/monitor/auto-fire). | `assets/agents/audit-executor.md` (Mode D) + `references/eval-audit.md` |
| **`*review` human labeling (EV-045)** | HITL gate — a HUMAN labels traces Pass/Fail/Defer in the `build-review-ui.ts` browser interface. The ground-truth `*validate` calibrates against. | `references/build-review-interface.md` |
| **`*build-dataset` seed interview (EV-046)** | `AskUserQuestion` / chat-fallback HITL gate — ~10 seed tuples before the agent expands. | SKILL.md §0.1 + `references/generate-synthetic-data.md` |
| Subject + substrate onboarding | `AskUserQuestion` / chat-fallback HITL gate | SKILL.md §0 |
| NL subject/trace exploration (onboarding) | LLM reasoning to infer the subject profile when no profile exists | `references/error-analysis.md` |

> **Critique-before-verdict + binary-not-Likert + judge-only + C-PIN/temp-0** are
> invariants of every Type-B judging op — declared in each subagent def, enforced at
> AGGREGATE by the deterministic parsers (`parseMatrixVerdictFile` /
> `parseCritiqueVerdict`), which THROW on a bare verdict or out-of-set result.

---

## Type C — Hybrid (agent invokes script)

The parent session invokes a Code-only script for the deterministic shape,
dispatches Type-B subagents for the reasoning, and reads structured output back.

| Op | Pattern |
|----|---------|
| `*evaluate` (DEFAULT, eval-matrix × trajectory) | parent `Bash(matrix-judge PREP)` → dispatch N `evaluator` (`#mode-judge-trajectory`, one per trajectory, mass-parallel) → `Bash(matrix-judge AGGREGATE)` reads verdict files → GATE scorecard |
| `*discover-evals` (EV-041/042/052) | parent `Bash(prep.ts --stage determiner)` → dispatch `evaluator` (`#mode-discover`, mass-parallel) → `Bash(aggregate, discover-criteria.ts)` → emergent criteria |
| `*build-evals` + `*evaluate` (per-criterion ALTERNATE) | parent `Bash(prep.ts --stage judge)` → dispatch `evaluator` (`#mode-judge-criterion`, one per criterion × slice) → `Bash(run-pipeline aggregate)` → scorecard |
| Success/failure determination integration (in-house/alternate) | `judge-prompt-template.ts` `determineOutcome` renders the determiner prompt + calls the injected `JudgeInvoke` seam — used by the OPTIONAL in-house substrate + the alternate per-criterion PREP; the decision is the subagent's. The DEFAULT path uses `determine-outcome.ts` `assembleOutcome` over a verdict file (no prompt). |
| Per-criterion judge integration (in-house/alternate) | `judge-prompt-template.ts` `runJudge` renders the 4-component prompt + calls the seam — never decides; only the in-house/alternate axis uses it. |
| Balanced sampling | parent `Bash(sample-traces.ts)` → reads the ✓/✗ sample plan |
| Subject profiling | parent `Bash(profile-subject.ts)` (or v1 `cli/profile-subject.ts`) → reads the generated profile → routes |
| Route failures to diagnostics | parent `Bash(route-failures.ts)` → reads the handover bundle (masked, mask-on-handoff carry) → hands to `mutagent-diagnostics` |
| `*validate` (EV-044) | parent `Bash(validate-judge.ts)` over `*review` labels + `*evaluate` verdicts → TPR/TNR · Rogan-Gladen · bootstrap CI → stamps validation provenance into the scorecard. Mostly CODE; the OPTIONAL `evaluator` `#mode-discover` disagreement read is the Type B half. |
| `*review` (EV-045) | parent `Bash(build-review-ui.ts)` renders the annotation UI → **HITL**: a human labels in the browser → `mergeLabels` persists → labels feed `*validate`. CODE render + HITL label. |
| `*build-dataset` (EV-046) | HITL seed interview (~10) → dispatch `dataset-builder` (tuples → NL queries → realism filter) → parent `Bash(build-dataset.ts)` cartesian-expand + near-dup drop + monotonic merge → growing dataset. 3-way Hybrid. |
| `*discover-dataset` (EV-047) | parent `Bash(derive-dataset.ts)` distills a living regression set from labeled ✓/✗ traces (reuses `sample-traces.ts` selectors + `build-dataset.ts` merge). Code-only — no dispatch. |
| context-flow audit (EV-028/029, `*audit`) | parent `Bash(flow-graph.ts)` builds the info-flow graph + `diffExpectedFlow` (deterministic) → dispatch `audit-executor` w/ `context-flow-lens.md` to judge threading/handoff leaks → `data-leak.workflow.js` new context-flow DIM emits `LEAK_SCHEMA`. |
| HTML missing-data audit (EV-039/040, `*audit`) | parent `Bash(ui-slots.ts)` cross-refs `expectedUiSlots` vs computed + HTML (deterministic computed-but-not-rendered / orphan) → dispatch `audit-executor` for the nuanced faithfulness (040) → `data-leak.workflow.js` de-hardcoded ui-render + data-correctness dims (subject-agnostic). |
| `*self-audit` (EV-055, eval-of-the-eval) | parent `Bash(self-audit.ts)` over the evaluator's OWN `*validate`/`*review`/`*discover-evals`/living-suite artifacts → deterministic six-area finding DATA → dispatch `audit-executor` (Mode D) for the nuanced reads + overall verdict → impact-ordered report. Reuses `*audit` + `*validate`; rebuilds nothing. **On-demand only** — no cron/monitor/auto-fire (`feedback_self_diagnostics_on_demand_only`); the orchestrator trigger block ships `enabled:false`. |
| **OPTIONAL in-house substrate** | when `substrate: in-house`, `judge-provider.ts` `createInHouseJudge` lazy-imports `@langchain/google-genai` (temp 0, THROW on missing creds). NOT the default; the only path where a script issues a provider call. The prompt it sends is rendered by `judge-prompt-template.ts` (the EV-050 export/in-house exception). |

---

## Austerity note — judge prose lives ONLY in the exception renderer

The judge-prompt prose has been **relocated out of** `determine-outcome.ts` and
`build-evals.ts` — they are now Type A (DATA only: signals · parse · assemble · split ·
leakage-guard · spec). The ONLY script that renders a judge prompt is
`judge-prompt-template.ts`, the operator-named **EV-050 exception** ("export a judge
PROMPT artifact = templating, not skill-triggered judging"). It exists for two
consumers ONLY: the OPTIONAL in-house provider substrate (no subagent → must carry the
prompt) and user-framework export.

The **DEFAULT agent-dispatch path never imports the renderer**: under it the
authoritative rubric is the unified subagent def (`evaluator.md#mode-judge-trajectory` /
`#mode-judge-criterion` / `#mode-discover`), the host runtime reasons from the def + the DATA packet, and the
verdict file is keyed by **task DATA** — the matrix-judge default keys by `trajectoryKey`
(a hash of the trajectory id), NOT a rendered prompt. So the prose genuinely leaves the
default path (no documented residual in the named scripts). The subagent defs are the
authoritative reasoning contract; the renderer's prose is their downstream provider-call
mirror, kept in lockstep.
