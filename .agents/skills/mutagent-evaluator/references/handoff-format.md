# The handoff format — what a copied plan must contain

> **A SPECIFICATION, not a module.** Each report renderer emits its own handoff markdown
> its own way. There is deliberately **no shared builder** and no import between the three
> shipped renderers: a runtime dependency between independently-published surfaces buys
> nothing here, and each report's sections are genuinely different. What a receiver needs
> to rely on is the **shape**, and shape is a property of the format. One conformance test
> (`tests/handoff-format.test.ts`) checks every renderer's output against this file.

## Why this exists

The receiver of a handoff is usually **a coding agent that never opens the HTML report**,
or a person reading a pasted issue. Anything the plan assumes but does not state is a leak:
the receiver goes looking for it, guesses, or silently skips it. So a handoff must stand
alone.

The second requirement is that it be **section-aware**. The operator acts from a specific
section of a specific report — a failing criterion, a cross-layer conflict, a proposed
criterion, a disputed verdict — and often types or dictates a note there. What gets copied
must reflect *where they were and what they said*, because the receiver and the definition
of "done" are different in each case.

## The block spine

Every handoff is built from the same ordered spine. Not every report owes every block —
the per-kind table below is authoritative — but any block that appears MUST appear in this
order, so a receiver can scan them positionally.

| # | Block | Answers |
|---|---|---|
| 1 | **Title** | what this is, which subject, which run |
| 2 | **Context you need** | what was examined and where the evidence lives — stated, not implied |
| 3 | **Operator note** | what the operator typed or dictated in that section, verbatim |
| 4 | **The items** | what was observed, each with its evidence |
| 5 | **Acceptance** | what "done" means, concretely enough to self-check |
| 6 | **How to verify** | the exact way to prove it |
| 7 | **What NOT to do** | the cheap wrong fixes, named |

## What each report kind owes

The receiver differs per kind, and so does the meaning of "done". A block marked — is
**deliberately** absent, not an omission.

| Block | Evaluation | Discovery | Review |
|---|---|---|---|
| Title | REQUIRED | REQUIRED | REQUIRED |
| Context you need | REQUIRED — subject + the trace package path | REQUIRED — the corpus + what was mined | — |
| Operator note | when present | when present | when present |
| The items | REQUIRED — failing criteria + evidence | REQUIRED — proposed criteria + grounding | REQUIRED — the rulings |
| Acceptance | REQUIRED | REQUIRED | REQUIRED |
| How to verify | REQUIRED | REQUIRED | — |
| What NOT to do | REQUIRED | — | — |
| **Receiver** | diagnostics / a coding agent | whoever maintains the suite | the calibration loop |

**Why Evaluation carries the strictest set.** It is the only kind whose receiver is asked to
*change code*. The others hand a decision to a human who already has the context.

**Why "What NOT to do" is required on Evaluation specifically.** The cheapest way to make a
failing evaluation pass is to weaken the criterion. That must be named as forbidden in the
handoff itself, because the receiver may never see anything else we wrote. It also carries
the instruction not to let the judgment replace reading the sessions — the judgment says
*where to look*, not *what happened*.

## Section awareness

A report has **one copy action per section**, not one per report. The emitted markdown
identifies its section in the title and scopes items 2–7 to that section:

| Report · section | Receiver | Acceptance means |
|---|---|---|
| Evaluation · a failing criterion | diagnostics / coding agent | the criterion passes on those sessions, re-judged pinned |
| Evaluation · a cross-layer conflict | operator calibration | the conflict is RULED on — it is not a defect to fix |
| Discovery · a proposed criterion | the suite | accepted or rejected, and recorded |
| Review · a disputed verdict | the calibration loop | the ruling is recorded |

A section with nothing in it emits **nothing** — never an empty skeleton. An empty
"## What failed" reads as "we checked and found nothing", which is a different claim from
"this section was not applicable".

## Rules that apply to every handoff

1. **NAME an absence.** If the trace package is not attached, say so — do not omit the
   block and let the receiver assume there was nothing to attach.
2. **Never truncate evidence into ambiguity.** A quoted string may be capped, but the cap
   must be visible.
3. **No internal-only content in an external render.** The audience rules
   (`scripts/audience.ts`) apply to the handoff exactly as they do to the page.
4. **The markdown is the contract, not the HTML.** If a fact matters, it is in the
   markdown, whether or not it is also on the page.
