# The evidence layers (L0–L4) — how the layered judge reads a trajectory

> The know-how reference for the layered walk. Load when you need to reason about
> **what a layer can and cannot decide**, why the judge descends, and what the
> stopping rules permit. The judge emits one `LayerVerdict` per engaged layer; this
> file is the map between a layer id and its meaning. Live consumers: the judge's
> `layerVerdicts`, the aggregate's `foldLayerVerdicts` / `detectLayerConflicts`, and
> the report's layer matrix.

## The ladder

The judge walks **cheapest-first, descending only when evidence requires**. Each layer
answers a narrower question than the one above; a layer's verdict is *evidence*, never
the run verdict on its own (the GATE is driven by criteria severity — D2).

| layer | name | question it can settle | what it CANNOT decide (the fence) |
|---|---|---|---|
| **L0** | code checks | did a deterministic pattern fire? (fault passthrough · error output · malformed structure · unguarded send · out-of-order gate) | a fired pattern is a **candidate**, not a verdict — "code-detectable ≠ incorrect". Emits `codeEvalHits`, verdict `fired` — never pass/fail. |
| **L1** | outcome | did the agent's terminal action belong to the scenario's expected exit set? (scenario → `expectedExit[]`) | anything about the *path*: a correct outcome can hide an unguarded send, a skipped review, an ignored flag. |
| **L2** | trajectory | is every **mandatory step** present *somewhere* in the session? (a required guard, approval, consent check) | whether a *tool's* output was trustworthy — that is L3. **A path that merely DIFFERS from the expected one is not a finding** — see "many paths" below. |
| **L3** | tool outputs | were the tool outputs structurally valid + complete, and — when one failed — was the failure **recovered from**? (per-observation) | **external-data correctness is UNVERIFIABLE** — a well-formed output can be factually wrong. An *irrecoverable* failure makes everything downstream suspect; a *recovered* one is normal operation. |
| **L4** | context | was required context retrieved AND present in history at the moment of the decision? (chronology-sorted) | distinguish **`gapKind: retrieval`** (never fetched) from **`attention`** (present, ignored) — the fixes differ. A context gap is **presumed fatal** — see below. |

## What a failure at each layer MEANS (the layers are not peers)

The ladder above says what each layer can *settle*. This section says how much a failure
there actually costs — and the layers are deliberately asymmetric.

### L4 · a context failure is presumed fatal
**You cannot succeed with bad context or data.** If the agent did not have the information
it needed at the moment it decided, it could not have *decided* correctly — at best it
guessed right. So a context gap is presumed fatal, and a passing outcome on top of it is
an **unexplained success**, reported as such, never as confirmation.

### L3 · a tool failure costs nothing if it was RECOVERED
This is the largest source of false findings if you get it wrong. A failing tool call is
not itself a defect — what matters is what happened next:

| shape | verdict | why |
|---|---|---|
| failed → retried → **succeeded** | **not a finding** | ordinary resilience. A file read that fails once and works on retry is the system working. |
| failed → retried → **never answered**, workflow unfinished | **irrecoverable — a real failure** | e.g. a 500 that never resolves; the agent can no longer complete its workflow. |
| failed → **never retried**, agent proceeds as if it had the data | **the worst case** | the agent is now inventing. This is the existing `fault-passthrough` code check. |

The discriminator is mechanical and needs no judge: *was it retried · did a retry succeed ·
did the workflow reach its intended end*. `runCodeEvalLibrary` computes it (`CE-P6`).

### L2 · many paths reach the same goal
An agent can follow **different trajectories to reach the same outcome**. A path that
diverges from the one we expected is therefore **not evidence of anything** — only a
*missing mandatory step* is. Judge presence-of-required-steps, never
sequence-equality-with-an-expected-script.

### L1 · a correct outcome clears nothing above it
The cheapest signal and the weakest evidence on its own. Necessary, nowhere near
sufficient.

### L0 · facts, not opinions
A fired pattern is a true statement about the trace and a *candidate* for a defect. It is
never a verdict (`verdict: fired`, never pass/fail).

## Precedence — which layer to believe when they disagree

> **The most upstream failing layer explains the run, and no downstream pass can clear an
> upstream failure.** Context ▸ tools ▸ trajectory ▸ outcome.

One carve-out, and it is the only place judgement is genuinely required: **an L3 failure
that was recovered from is not a failure at all** and never enters the ordering. That is
what the recoverable/irrecoverable split buys — it removes the dominant source of noise
*before* precedence is ever applied.

**Precedence EXPLAINS; criteria DECIDE.** This ordering picks which layer tells the run's
real story. It never moves a gate — the GATE is driven by criteria severity (D2), and
`foldLayerVerdicts` / `detectLayerConflicts` never feed it. There is a test asserting
exactly that (`layered-fold.test.ts` — "precedence NEVER moves the gate"). Mixing the two
would be the auto-resolution OT-1 forbids, arriving through the back door.

## Criteria are the super-layer

Criteria do not live *in* one layer — they are the **super-layer** and may bind evidence
from any phase (e.g. a reply-grounding criterion reads L3 tool outputs AND L1 the reply).
Two hard rules:

- **a criterion may NEVER go unverdicted because the agent did the right thing** — `na`
  (not-applicable) is a real accounting path with a rationale, never a silent skip
  (`assertNoUnverdictedCriterion` THROWS on a missing cell).
- **`na` is not `uncertain`.** `na` = the criterion's scoping predicate is positively
  falsified for this trajectory (never fail). `uncertain` = the inputs could not decide
  (a CRIT/HIGH uncertain rolls the run INCOMPLETE-wards, never green).

## The stopping rules (when the walk may exit early)

- If **L1 passes AND every criterion is answerable** from evidence gathered so far → the
  walk may set `earlyExit: 'L1'` and mark L2–L4 `skipped`. `skipped ≠ undecidable`.
- If **any** criterion is unanswerable, OR L1 fails / is undecidable → **descend.** A
  walk must not stop while a criterion is unanswerable (that is how a false-green forms).
- `layersEngaged` records how deep the walk actually went (the economy stat — MR-3).

## Conflict discipline (OT-1)

When layers disagree — e.g. **L1 pass but L2 fail** (the outcome was right, the path
unguarded) — the judge emits **both** verdicts honestly with a note and **never
reconciles them itself**. The aggregate (`detectLayerConflicts`) surfaces the conflict
to a human calibration queue; the GATE never reads it (it is driven by criteria
severity). The judge's own statement of the tension lives in `localize.conflict`; the
aggregate's cross-check is the layer notes. Both render; neither is auto-resolved.
