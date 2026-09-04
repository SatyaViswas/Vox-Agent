# The data registry — every entity this skill can produce or consume

> The agent's general knowledge of available entities (the resilience mechanism from
> the data-availability audit §⓪). Purpose: so that when an expected entity is ABSENT,
> the absence is **NAMED in words** — never a silent blank, never a fabricated value.
> A renderer that cannot source a field says so ("not recorded by this run"); a judge
> that cannot gather an emission lists it in its `emissions.missing[]` self-manifest.

## Run artifacts (the `.mutagent/evaluator/runs/<runId>/` dot-root, gitignored)

| entity | produced by | consumed by | absence → |
|---|---|---|---|
| `run-input.full.json` | run PREP (`run-evaluate`) | AGGREGATE, the report renderers | a run cannot aggregate — fail loud |
| `packets/<trajectoryKey>.packet.json` | `prepMatrixPackets` | one dispatched judge each | the readiness gate throws (no silent partial roll-up) |
| `verdicts/<trajectoryKey>.verdict.json` | a dispatched `#mode-judge-trajectory` agent | AGGREGATE | same — every judged trajectory MUST have one |
| `verdicts/*.verify.json` | a dispatched `#mode-verify` reviewer | the T3 independent-verify ledger | self-verify fallback (a NAMED degrade, not a silent downgrade) |
| `near-duplicate-decisions.json` | `aggregateDiscover` | the next run's brief (no re-proposal) | first run — key absent, never an empty claim |
| `.mutagent/evaluator/reports/<runId>/{evaluation,discovery,review}-report.html` | the renderers | the operator | the run wrote no report — fail loud |

## Judge emissions (the verdict-file fields — E-NEW)

| field | shape | honesty rule |
|---|---|---|
| `layerVerdicts[]` | `{layer, verdict, refs?, note?, scenario?, expectedExit?, gapKind?, firstProblemOrigin?, divergence?}` | skipped ≠ undecidable; L0 may be `fired` (a candidate, never a verdict) |
| `verdicts[]` | per-criterion `{critique, result, confidence, refs?, assumptions?, blockedBy?}` | a DECIDED verdict carries ≥1 re-resolvable ref; an `uncertain` carries `blockedBy` (na for grounding) |
| `denseMap` | `{criterionId: pass\|fail\|uncertain\|na}` | EVERY criterion appears; `na` ≠ fail |
| `naRationale` | `{criterionId: why}` | the reason a cell is `na` — the completeness law's third path carries its rationale |
| `emissions` | `{emitted[], missing[{key,reason}]}` | a missing emission WITH a stated reason is a NAMED degrade; a silent drop is a defect (MR-5 catches it) |
| `codeEvalHits[]` | `{pattern, anchor, detail}` | L0 fired patterns — evidence, not a verdict |
| `localize` | `{root, evidence?, criteria?, independentRoots?, conflict?, routing?, …}` | the root-not-symptom; `conflict` is the judge's OT-1 statement — surfaced, never reconciled |

## Subject profile + criteria

| entity | produced by | note |
|---|---|---|
| subject profile | `buildSubjectProfile` | identity · purpose · tools · scope — GIVEN (code access) or reconstructed |
| `criteria[]` (the eval matrix) | the suite / `*discover` | each may carry `layer` (which evidence layer it binds to) — additive, optional, defaults to `"criteria"` |
| living suite + provenance | `growLivingSuite` | append-only, monotonic; near-duplicates MERGE (no data loss) |
| pending near-duplicate decisions | `merge-criteria` | durable, order-independent identity; stays open until a ruling |

**The rule that binds every row of this registry:** an absence is stated, never inferred
into a number. `0` and "not recorded" are different facts, and a report that shows the
first when it means the second is manufacturing evidence.
