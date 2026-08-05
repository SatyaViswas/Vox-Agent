# mutagent-agentspec — Orchestrator Protocol

> The runtime FSM for `mutagent-agentspec`. The **parent session IS the domain orchestrator** — it
> runs the `*spec` interview itself and does **NOT** dispatch a coordinator sub-agent (PR-006). On
> Claude Code the interview uses **AskUserQuestion**; elsewhere it uses a chat-based multi-choice
> fallback. `*build` is owned by `mutagent-builder`; `*eval` is a routed handoff to EVALUATE.

---

## Star-command resolution contract (verbatim)

When you encounter a `*<name>` token:
1. **RESERVED** — `*` marks a command. NOT prose, NOT a file path, NOT an external shortcut.
   `*command` = THIS skill's semantic map (internal). Never improvise.
2. **RESOLVE** — look up `<name>` in the `commands:` block in `SKILL.md §0.1`. Not found ⇒ ERROR +
   ask the operator. NEVER guess.
3. **BINDING** — read `kind:` + `binds:`:
   - `kind: script` ⇒ `binds:` a relative script path ⇒ CALL the script via `scripts/cli/run.sh`.
     Do NOT re-implement it in prose.
   - `kind: agent-chain` ⇒ `binds:` a workflow file#section ⇒ load + run the steps in order.
   - `kind: hybrid` ⇒ `binds:` both ⇒ call script(s) for deterministic parts, reason for the rest.
4. **PRE-GATE** — load any `pre_gate.loads:`.
5. **EXECUTE** — run the steps IN ORDER. Invent nothing.
6. `purpose:` / `impact:` explain WHY (not executed). Steps MAY reference other `*commands`.

---

## `*spec` — the guided interview FSM (parent session, full)

**Goal:** walk the operator through the AgentSpec 0.3.0 resource card **intent-first**, emit the
`agentspec.yaml` (+ optional colocated `agentspec.decisions.md`), and gate it with `*validate-spec`.
The interview is parent-only (AskUserQuestion cannot run inside a sub-agent, PR-006). Every fork is an
AskUserQuestion (Claude Code) or a chat multi-choice (elsewhere) — never a bare inline prose ask, and
never a cold enum without a recommendation. Capture VERBOSE descriptions on every entry (PR-015) — the
description is the primary field the implementing LLM reads.

The FSM walks the card **requirements-first**; state accumulates into the in-progress card; the
operator may revise an earlier answer at any point (the card is the working record).

> **INTENT-FIRST ordering (0.3.0 — reverses the old framework-before-tooling order).** The 0.2
> interview asked `kind` first and the target EARLY. 0.3.0 does the opposite: gather the **whole
> problem space** — problem, outcomes, long-form SOP (before derived jobs), constraints, non-goals,
> assumptions, unknowns, inbound context, outbound actions, and capability requirements — **before**
> inferring `kind`, and choose target(s) **LAST**, after the design and evaluation contract are
> complete. *A user cannot responsibly choose a kind before requirements exist, and a target must
> satisfy the final design — not prematurely constrain it.* The live order is therefore
> **I0 → I1 → I2 → I3 → I4 → I4b(capability inventory) → I5(kind) → I6(design) → I7(eval close) →
> I8(target) → I9(emit)**.
>
> **Capability inventory precedes kind (I4b before I5) — Wave-2A exit check.** The base capability
> REQUIREMENTS (code · loadable skills · **delegates**) are inventoried at **I4b, BEFORE** the kind is
> proposed, so kind is inferred FROM a complete capability picture. Capturing delegates *after* kind
> would risk circular confirmation (a `MultiAgent` guess justifying the very delegates that should
> have informed it). Kind-DRIVEN *refinement* of capabilities still happens at I6 — but the inventory
> that feeds the kind inference is fixed first.

### Phases I0–I9 (the intent-first flow)

| # | Phase | Captures | Schema target |
|---|---|---|---|
| I0 | **Frame problem** | domain · affected people/systems · pain · desired change · **invite source materials** — remind the operator they can point at folders/files/links (policy docs · agent-scope/role docs · existing SOPs/runbooks · a prior agent definition or prompt) to ground the interview, so they can hand over documents instead of talking everything out (see *Grounding the interview in existing materials*) | (feeds `spec.intent`) |
| I1 | **Complete intent** | `problem`; `outcomes[]`; long-form `sop[]` (id·when·description·onFailure?) **before** `jobs[]` (id·description·expectedOutput); `constraints[]`; `nonGoals[]`; `assumptions[]`; `unknowns[]` | `spec.intent` |
| I2 | **Inbound context** | per item: id · verbose description · `modalities[]` (documents/databases/email/events/human input…) · source · freshness? · sensitivity? · `access{kind,ref,allowedOperations[],authRef?}` — `kind` is the CLOSED enum `{cli\|saas\|mcp\|sdk\|host-tool}` (R3); propose the target-favored binding, never cold-ask, and never accept an unlisted kind | `spec.context[]` |
| I3 | **Outbound actions** | per effect: id · description · `binding{kind,ref,authRef?}` (same CLOSED `kind` enum, R3) · `allowedOperations[]` · `approval{policy,when}` · `evidence` · `onFailure`. Explicit **none** = `actions: []`. | `spec.actions[]` |
| I4 | **Seed evaluation** | choose **criteria-first OR dataset-first** (enforce neither, D19); draft binary-actionable `criteria[]` and/or broad `scenarios[]`; sketch dataset intent + mappings | `spec.evaluation` (draft) |
| **I4b** | **Capability inventory** *(BEFORE kind — Wave-2A exit check)* | inventory the base capability REQUIREMENTS the problem needs — local `code[]`, loadable `skills[]`, and **`delegates[]`** — as requirements, independent of any kind. This complete picture FEEDS the kind inference; never defer the delegates question past kind. | `spec.capabilities` (base) |
| I5 | **Propose kind** | INFER `Agent`\|`Skill`\|`MultiAgent`\|`Workflow` from the COMPLETE intent + the I4b capability inventory; PROPOSE with the WHY; operator confirms/corrects (see Infer→Propose→Confirm). **Never** choose kind before the I4b inventory exists. | `kind` |
| I6 | **Derive design** | the ONE kind-native body (below) + kind-driven *refinement* of capabilities (graph · triggers · host needs · expected outputs; add any capability the confirmed kind newly requires) | `spec.<kind body>`, `spec.capabilities` (refined) |
| I7 | **Close evaluation** | confirm `criteria[]` · `scenarios[]` (mapped to jobs) · `datasets[]` — each dataset owns its **local** `categories[]` + `caseDimensions` and uses the kind's `input`/`expected` **item** contract (D18); every item maps to one scenario | `spec.evaluation` (final) |
| I8 | **Select target(s)** | compare capability + evaluation fit; confirm **one or many** `targets[]`: `type`(harness\|framework\|platform\|custom) · name · `artifact{format,path}` · `documentation[]` · `capabilityFit`; add `implementation{language,toolchain}` **only** for `format: code`. Record capability gaps explicitly. | `spec.targets[]` |
| I9 | **Recap + emit** | plain-language card recap (final values · consequential inferences · operator overrides · unresolved unknowns · decisions · intentionally-empty fields); on approval, emit + optional decisions sidecar + `*validate-spec` + suggest `*build` | EMIT + GATE |

> **Four-kind interview fixtures.** The intent-first ordering is proven per kind by the transcript
> fixtures at `assets/fixtures/interview/{agent,skill,multiagent,workflow}-interview.md` — each shows
> intent preserved, unknowns exposed, integration (closed-enum binding) asked, and kind/target chosen
> only AFTER the I4b capability inventory. (A finished example *card* cannot show capture order; these do.)

### I0 opening — the process-overview preamble (before any question)

**Set expectations before asking anything.** The very first thing the interview does — before a
single question — is give the operator a short, plain-language overview of what's about to happen, so
they know the shape of the conversation instead of being met cold with a barrage of questions.
Deliver it once, at the top of I0, in plain words (no schema vocabulary), covering four things: **what
this does · the journey in plain words · what you get at the end · materials welcome any time.**

> "Here's how this'll work. I'm going to interview you to build a spec for your agent — think of it as
> a shared understanding we write down and you sign off on. We'll go a step at a time, roughly in this
> order: **understand the problem** you're solving → **who it affects** → **how the work should
> happen** → **what the agent is allowed to touch and do** → **how we'll know it's working** → and
> last, **where it runs**. I'll ask in plain language and handle the technical mapping myself — it's a
> conversation, not a form, and you can revise an earlier answer at any time. At the end you get a
> reviewed `agentspec.yaml` to approve."

Then — still at I0, and second — open the door to existing materials: the operator can hand over
documents instead of talking everything out. The overview comes **first** (what to expect); the
materials invitation comes **second** (what you can bring). The invitation itself and the read-don't-
guess discipline are defined in the next section — reference it, don't restate it here.

### Grounding the interview in existing materials (I0 invitation · recurring reminder)

**Docs-over-dialogue.** The operator should never have to talk out what a document they already have
states. The FSM INVITES source materials at the top and keeps the door open — the interview reads
them as context, it does not demand everything be described from scratch.

**I0 — open with the invitation (plain language, once):**

> "Before we talk it all out — if you already have material that describes this agent's job, point me
> at it. Folders, files, or links: policy documents, agent-scope or role documents, existing
> SOPs/runbooks, a prior agent definition or prompt. I'll read them and use them as interview context,
> so you can hand me documents instead of describing everything from scratch."

**Recurring reminder — one line, not spam.** At each move between major phases (e.g. I1→I2, I3→I4,
I4b→I5, I6→I7, I7→I8) drop AT MOST one plain line — *"(You can hand me more material any time — a doc
beats re-typing it.)"* — never more than a single line, never on every question.

**When materials ARE provided — read, don't guess (mirror the `*sync-spec` reading discipline):**

| Step | Rule |
|---|---|
| **Read IN FULL** | Read every provided file/folder/link **completely** before deriving anything — evidence-first, **no filename guessing** (the same read-in-full discipline `ai-architect #sync-spec` uses, PR-025). A folder ⇒ enumerate then read its files; a link ⇒ fetch + read. |
| **Derive, don't adopt** | Project the read content onto the current phase's card fields as **INFERRED** values only — the document is evidence, never the design authority (same stance as reverse-sync: material informs, the operator still owns *why*). |
| **Infer → Propose → Confirm** | Run the existing loop OVER the extracted content: PROPOSE each document-derived field as the pre-selected default **with its source cited as the WHY**; the operator CONFIRMS or CORRECTS. A document-derived fact is **never** silently accepted as truth — it is confirmed exactly like an inferred `kind`. |
| **Cite the source** | Note the source document per derived item in the **existing** provenance language: surface it as an **inferred value (source: `<doc>`)** at propose-time and in the I9 recap's "consequential inferences" list; where the choice is consequential, the `agentspec.decisions.md` sidecar (N03) records the source as its rationale. **No new schema fields** — provenance rides the existing inferred-vs-confirmed + recap + decisions machinery. |

Unknowns stay unknowns: a gap the documents do not answer lands in `intent.unknowns[]` — never invented
from a document's silence — exactly as on the talk-it-out path.

### The kind-native design body (I6) — no anatomy leaks across kinds

| kind | Body (`spec.<kind>`) captures |
|---|---|
| **Agent** | `persona{role,description}` · the ACTUAL `systemPrompt` (full sacred text, not a summary, PR-014) · `operatingType` (conversational\|automation\|orchestrator — INFER+PROPOSE) · `triggers[]?` · optional `workflow{inline\|ref}` (the ONE canonical graph contract — never a bespoke per-Agent decision graph) |
| **Skill** | `purpose` · `invocation` (host-aware activation, not inbound triggers) · `instructions` · `inputs[]` · `outputs[]` · `resources[]` · `hostRequirements[]` · `failureBehavior` · `progressiveDisclosure` · `subagents[]?` |
| **MultiAgent** | `orchestrator` (the one root member id) · `members[]` (embedded complete Agent/Skill cards, or `{specRef}` — each keeps its own intent by ref/inline; the member graph must be **acyclic**, N02) · `relations{subagents{}, observes{}}` (dispatch vs watch, kept distinct) · `workflow{inline\|ref}` |
| **Workflow** | the canonical graph directly: `state` · `entry` · `nodes[]` (id · verbose description · `executor?` {actionRef\|memberRef\|contextRefs\|kind+ref} · `edges[]`{to,condition?,loop?{maxIterations,exitWhen}} · terminal?). Any **returning edge must be bounded** (N02). |

#### INFER → PROPOSE → CONFIRM — `kind` (I5) + Agent `operatingType` (I6)

> **Don't cold-ask the obvious.** By I5 the operator has described the whole problem, context, actions,
> and capability needs; `kind` is usually DERIVABLE. The interview **INFERS** it, **PROPOSES** it as the
> pre-selected default with the WHY as its rationale, and lets the operator **CONFIRM or CORRECT** —
> never a bare enum. On low confidence, still propose the best guess but flag it as a guess.

**`kind` inference map** (propose the matching value, gloss shown as rationale):

| The complete intent sounds like… | PROPOSE `kind` | Gloss (the WHY) |
|---|---|---|
| one autonomous subject with a persona + operative prompt that decides and acts | `Agent` | a single autonomous subject |
| a reusable capability a host runtime loads/invokes (no standalone activation) | `Skill` | a loadable host capability, not an agent |
| several members with separated duties + a routing/observation boundary | `MultiAgent` | members + coordination + governance |
| a reusable control-flow graph with no persona/system prompt | `Workflow` | the canonical graph resource |

**`operatingType`** (Agent only, I6): conversational (back-and-forth) · automation (one-shot
end-to-end) · orchestrator (a2a-router that delegates) — INFER from intent + jobs, PROPOSE, confirm.

### Evaluation authoring (I4 + I7) — dual entry, one close gate (D18/D19)

- **Two valid entry paths (enforce NEITHER):** criteria-first (author binary rubric, then examples)
  OR dataset-first (domain examples precede the rubric). Both must CONVERGE before emission.
- **Close gate:** confirmed `criteria[]`, `scenarios[]` (each mapped to jobs), and `datasets[]` exist.
  Each dataset maps directly to jobs/scenarios/criteria, owns its **local** `categories[]` (with
  `generationGuidance`) and `caseDimensions` (independent variation axes), and its `items[]` use the
  selected kind's `input`/`expected` contract (Agent: response/actionCalls · Skill: outputs/hostActions
  · MultiAgent: member/node outputs + actionCalls · Workflow: path/nodeOutputs). Items may be inline or
  an `itemsRef` manifest. Evaluation may remain **draft** through the interview (F05) — the approved card
  still shows missing links honestly.

### Human-facing interview rules

**Always explain:** what the question affects · why a default is proposed · what changes downstream if
the answer changes · which values are inferred vs confirmed (a document-derived value is
**inferred-with-source**, and still needs confirmation).
**Never:** cold-ask an enum without a recommendation · turn unanswered questions into invented
requirements · adopt a provided document's claim as confirmed truth without operator sign-off · dump
the whole schema as a questionnaire · hide uncertainty in free-form notes.
**Before emission:** show current truth in plain language · list decisions + rejected alternatives ·
list unknowns and whether they block Build · ask for ONE explicit approve/revise response.

**Natural conversation (binding).** This is a natural-language interview — the operator is being
*talked to like a person*, not walked through a schema. Ask for as many details as possible. Encode:
- **Talk, don't itemize.** Every question reads as something you'd say to a person, never a field-list
  to fill in. **One topic at a time**, then follow up — follow-ups dig for maximal detail (keep
  pulling — *"what else?"*, *"walk me through a time it went wrong"* — until the topic is richly
  captured before moving on).
- **Schema vocabulary stays behind the curtain.** The card's field and bucket names (`name`,
  `description`, `version`, `problem`, `outcomes`, `jobs`, `systemPrompt`, `context`, `actions`, …)
  **NEVER** appear in question text. The operator answers in their own words; the interviewer maps
  those answers onto the card's fields **silently**. (Proposing a closed-enum binding still happens
  per the phases above — but phrased as a plain-language choice with a recommendation, never by
  parading the raw enum.)
- **Contrast:**
  - ✗ "Provide: Name · Description · Version."
  - ✓ "Tell me about the problem you're trying to solve — what keeps going wrong, and for whom?"

### Phase E — EMIT + GATE

1. **Resolve the output directory** (do NOT hard-code a path). Call the output-dir resolver:
   `scripts/cli/run.sh scripts/config/resolve-spec-dir.ts` — it reads `lifecycle.agentspec.spec_dir`
   from `<root>/.mutagent/config.yaml` and prints the resolved absolute `dir` + the winning `source`
   (`flag`|`config`|`default`). **Precedence: flag > config > default.** With ZERO config it returns
   the DEFAULT `.mutagent/specs` — so `*spec` always runs. Assemble the accumulated state into a single
   `agentspec.yaml` at `<resolved-dir>/<metadata.id>/agentspec.yaml`.
2. **Optional decision sidecar (N03).** If the interview recorded consequential decisions/alternatives,
   write `agentspec.decisions.md` **beside** the `agentspec.yaml` and set `spec.decisionsRef:
   ./agentspec.decisions.md`. The YAML stays current truth; the Markdown holds rationale/supersession.
   The pair is one portable bundle — never emit/copy only one half.
3. Run `*validate-spec <path>` (`scripts/validate/validate-spec.ts`) — the STRUCTURAL + SEMANTIC gate.
   On FAIL, surface the field-pathed errors, return to the offending phase, fix, re-emit, re-gate. On
   PASS, the card is the validated Definition + a trackable subject (a planned, not-yet-built subject is
   first-class from spec-time).
4. SUGGEST the next stage (`*build`) — but NEVER auto-advance. The transition needs explicit operator
   intent (PR-009).

> **Metadata + loop position (0.3.0).** The card's identity is `metadata{id,name,version,description}`
> (subject `version` is distinct from `apiVersion` and any package release). The 0.2 `meta.loop_state`
> field is retired with the 0.2 baseline (N01); ADL loop position for a 0.3.0 subject is tracked by the
> orchestrator index OUTSIDE the card — a coordinated-update dependency (the `build-index` narrowing to
> the 0.3.0 shape rides the same FU-69 coordinated pass as the evaluator eval-contract).

> **Output-dir note.** WHERE `*spec` writes is resolved by `scripts/config/resolve-spec-dir.ts` —
> precedence **flag > config > default**. The config field is `lifecycle.agentspec.spec_dir` in
> `<root>/.mutagent/config.yaml` (the LOCAL install root, found by walking up to the nearest
> `.mutagent/`). The block is OPTIONAL: with no config the resolver returns the default
> `.mutagent/specs`, so `*spec` runs with zero config. A relative `spec_dir` is anchored at the config
> root; an absolute one is honored as-is. The resolver reads ONLY `spec_dir` and never cross-imports the
> orchestrator's config schema (standalone invariant).


---

## `*sync-spec` — reconcile the spec + eval triad against a target (delegated)

> **The canonical spec-reconcile (dogfood F10).** `*sync-spec` FUSES the former `*spec-from-impl`
> (brownfield reverse-generate) and the former builder-owned `*spec-sync` (drift resync) into ONE
> operation — because reverse-generate is just *drift from nothing* (empty spec vs code). Cold (no
> `agentspec.yaml` yet → CONSTRUCT one) and warm (a spec exists but code drifted → RECONCILE the delta)
> are the SAME op with different starting points.
>
> **A THREE-leg triad (def → impl → EVAL), W2I5 · KP-003.** The reconcile keeps the spec leg AND the
> **eval-criteria leg** in lockstep with the impl (PR-011): when the impl amends, the eval criteria that
> ground the subject's evaluation can go stale exactly as the spec can. The eval leg's shape follows the
> subject kind — **eval-suite criteria** for an agent/skill subject, **code-quality criteria** for a code
> subject. `ai-architect #sync-spec` reconciles both legs; the eval-leg maintenance is the evaluator's:
> `sync-eval-criteria.ts` `reconcileEvalCriteria` COMPUTES the grown criteria set, and the evaluator session
> then PERSISTS it with `persist-eval-criteria.ts` `persistEvalCriteria` (the write that bumps the artifact's
> freshness → returns the eval leg to `in-sync`) — criteria maintenance, NOT judging; the evaluator stays
> judge-only, EV-051.
>
> **AgentSpec owns the entry but NEVER reads code.** It DELEGATES the target-read to builder's
> `ai-architect #sync-spec` (the single implementation-reader), Helix-mediated via a HandoverBundle
> (kind:agent — the same mechanism as the discovery agent). `ai-architect` returns a constructed /
> reconciled draft (spec leg + eval leg); AgentSpec `*validate-spec`-gates the spec and OWNS the result.
> Generic + subject-agnostic — no connector- or app-specific logic.

**Inputs:** a TARGET ref — a path/repo to the existing implementation (or a cloud agent definition),
optionally its env/config surface (`.env(.example)`, framework config, manifest/package files, MCP/tool
registrations), the existing `agentspec.yaml` if one exists (warm reconcile), and the existing
eval-criteria artifact if one exists (the eval leg — auto-located under `.mutagent/evaluator/living-suite/`
when not passed).

**Flow (parent-session, same interview discipline as `*spec`):**

1. **Emit the delegation bundle (with the template-slot checklist).** AgentSpec builds a
   `HandoverBundle{ adl_stage: build, subject:{kind:agent, name:"ai-architect"},
   intent:{command:"*sync-spec"}, inputs:[ target-ref, existing agentspec.yaml? ] }` and hands it to
   Helix, which DISPATCHES builder's `ai-architect #sync-spec`. AgentSpec first derives the canonical
   **template-slot checklist** deterministically — `scripts/cli/run.sh scripts/template/slot-checklist.ts
   --json` (the slot skeleton of the ONE worked template, `assets/templates/agentspec.yaml.tpl`) — and
   includes it in the bundle so `ai-architect` drives extraction off it: every slot deliberately FILLED
   or marked N/A (the enumerate-first scaffold, PR-025). AgentSpec itself reads NO implementation source.
2. **ai-architect ENUMERATES the surface, drafts, then CROSS-VERIFIES** (builder-side, `#sync-spec` mode).
   It runs the three sub-steps of the enumerate-first + cross-verify discipline (PR-025):
   (a) **ENUMERATE-FIRST** — before reading the impl's own prose, LIST the real surface (every CLI
   command / entrypoint / handler · hooks · files · tool/MCP/integration registrations · context sources ·
   sub-agents · inbound triggers · env/config), then resolve EVERY template slot from the checklist —
   filled or N/A, never silently;
   (b) **reverse-map + draft** — PROJECT the enumerated surface onto the 0.3.0 `spec` blocks: the intent
   (`intent.problem/outcomes/sop/jobs/…`), `context[]` (+ `access`), `actions[]`, `capabilities`
   (code/skills/delegates), and the ONE kind-native body — for an Agent: `agent.persona` +
   `agent.systemPrompt` (impl's operative text VERBATIM, PR-014), `agent.operatingType` (INFER + PROPOSE
   per F2), `agent.triggers`, and an optional canonical `agent.workflow` — seeding `evaluation` from jobs
   + observed behavior; INFER the observed `spec.targets[]` (type/name/`artifact.format`) from the impl
   (the one case where the target is observed, not chosen). Read files in full — do not guess from
   filenames. Cold → construct from scratch; warm → emit the reconcile DELTA against the existing spec;
   (c) **CROSS-VERIFY** — an LLM pass comparing the drafted spec back against the enumerated surface (the
   **impl→spec** direction, which `spec-impl-coverage.ts` — spec→impl only — has no home for), reporting
   every surface item present but MISSING/partial in the draft. Returns a `HandoverBundle` carrying the
   draft/reconciled `agentspec.yaml` + the enumerated-surface checklist (each slot's disposition) + the
   cross-verify report.
3. **CONFIRM the draft — including the omissions — with the operator.** AgentSpec surfaces every INFERRED
   field as a proposal (AskUserQuestion / chat fallback) AND surfaces the cross-verify report UP FRONT —
   the surface items present but missing/partial in the draft, and each slot marked N/A — so the operator
   sees what was included AND excluded, and decides, rather than discovering an omission after the fact. A
   reverse-generated draft is a proposal, never a silent fact; the operator owns the final Definition (the
   same parent-session, propose-don't-assume discipline as `*spec`).
4. **Emit + GATE + own.** AgentSpec writes the 0.3.0 `agentspec.yaml` (loop position tracked OUTSIDE the
   card — the 0.2 `meta.loop_state` is retired, N01; the tracking mechanism rides the coordinated FU-69
   pass) and runs `*validate-spec`. On FAIL, surface the field-pathed errors, fix the offending block, re-emit, re-gate.
   On PASS, the reconciled spec is a trackable Definition AgentSpec OWNS — `*build` re-running against it
   now cascade-updates the impl (def → impl, PR-001). When the sync yields spec WRITES that touch the
   impl, `ai-engineer` applies them (gated).
5. **Reconcile the EVAL leg (the third leg, W2I5).** When `ai-architect`'s freshness probe flags the eval
   leg (`driftedLegs` contains `eval` — the impl amended past the eval criteria), it also drafts an
   eval-criteria reconcile delta for the applicable leg (eval-suite criteria for an agent/skill subject,
   code-quality criteria for a code subject). AgentSpec surfaces the delta to the operator (propose,
   don't assume) exactly as for a spec field, then the **evaluator's criteria-maintenance hook**
   (`reconcileEvalCriteria`) COMPUTES the grown set under the gate — an append-only upsert that never drops a
   criterion (EV-053) — and the **evaluator session PERSISTS** `result.criteria` to the located artifact
   (`persist-eval-criteria.ts` `persistEvalCriteria` → `.mutagent/evaluator/living-suite/<leg>.criteria.json`).
   The hook COMPUTES; the persist is the WRITE — and that write bumps the artifact's freshness, which is what
   returns the eval leg to `in-sync`. This is criteria maintenance, NOT judging; the evaluator stays
   judge-only (EV-051). The spec leg and the eval leg move together so def → impl → eval never falls out of
   lockstep.
6. **Re-probe to confirm in-sync (closing self-heal).** After the gated writes land (spec via `ai-engineer`,
   eval criteria via `persistEvalCriteria`), RE-RUN the freshness probe (`check-sync-spec.ts`) one final time.
   The procedure only completes when it reports `in-sync` on every leg that drifted (`driftedLegs` empty);
   `eval` still in `driftedLegs` means the criteria write was skipped or landed stale — the re-probe SURFACES
   it so the persist can be re-run, rather than closing `*sync-spec` on an unpersisted (still-drifted) leg.

> **Scope (subject-agnostic).** `*sync-spec` reads an arbitrary implementation surface (via
> `ai-architect`); it embeds NO per-connector / per-app logic. The drift is detected by a deterministic
> code predicate (`check-sync-spec.ts`, spec + eval legs); the reconcile itself is `ai-architect`
> reasoning, session-dispatched (Model-B — code detects, the agent reconciles). Builder ALSO reuses
> `ai-architect #sync-spec` build-internally when it detects drift mid-`*build`.

### Reverse-sync (Optimize-first) — the 0.3.0 no-silent-overwrite gate

⑤ OPTIMIZE may change implementation code **first**; the 0.3.0 card must then be reconciled **without
letting code silently redefine intent**. Code is useful evidence, not the design authority — the
operator remains the owner of *why* and *intended behavior*. The reverse-sync run:

1. **Read the impl** — `ai-architect #sync-spec` (the single implementation-reader) reads the changed
   surface read-only and produces an **explicit proposed delta at three levels**: (a) 0.3.0 **field**
   changes (which `spec.*` keys change and to what), (b) **decision-log** entries for consequential
   choices (append to `agentspec.decisions.md`, with supersession where a prior decision is overturned),
   and (c) **eval-criterion** changes (the eval leg, per the triad). Every proposed change **cites** the
   impl evidence.
2. **Operator gate — approve / revise / reject.** NEVER auto-apply. A **rejected** proposal leaves the
   card and sidecar **unchanged** (no silent overwrite). A **revised** proposal is re-drafted.
3. **Persist only approved deltas** — write the approved field changes into `agentspec.yaml`, the
   approved rationale into `agentspec.decisions.md` (keeping `spec.decisionsRef` and the YAML consistent
   — never publish/copy only one half), and the approved eval-criteria via the evaluator's persist path.
4. **Validate + re-probe to empty drift** — `*validate-spec` (structural+semantic) must pass on the
   updated card, then RE-RUN `check-sync-spec.ts` until **every** drifted leg reports `in-sync`
   (`driftedLegs` empty). The run only completes on an empty drift set.

**Proof (exit check):** a code-side change produces a cited spec/decision/eval proposal, records the
operator disposition, persists only approved truth, keeps YAML↔sidecar consistent, and ends with an
empty drift set. A rejected proposal leaves truth untouched.

---

## `*validate-spec` — the schema gate (script)

`kind: script` · `binds: scripts/validate/validate-spec.ts`. Reads a YAML spec path, parses it,
validates against the frozen `agentspec.mutagent.io/v0.3.0` contract — STRUCTURAL (`scripts/contract/agentspec.schema.ts`) then SEMANTIC (`scripts/validate/semantic-validator.ts`) —
prints field-pathed errors + exits non-zero on failure, or `[validate-spec] PASS` + exit 0 on
success. The worked template (`assets/templates/agentspec.yaml.tpl`) is asserted valid by the
test suite — copy it as a starting point.

---

## `*build` — handoff to BUILD (`mutagent-builder`)

`mutagent-agentspec` validates and emits `agentspec.yaml`. The next explicit operator command is
`*build`, routed by Helix to `mutagent-builder`. BUILD consumes the validated Definition, reuses
`ai-architect #sync-spec` build-internally when it detects drift, dispatches `ai-engineer` /
`ai-architect`, runs TDD + spec implementation coverage, and emits the build report + EVALUATE handoff
bundle. (The `*sync-spec` COMMAND is now owned by `mutagent-agentspec` — it delegates the same
`ai-architect #sync-spec` read.)

Agentspec does **not** keep an executable build owner row, build agents, or coverage gate. Its boundary
ends at a schema-valid spec plus the handoff suggestion.

---

## `*eval` — eval-driven development handoff (OUTLINED — Wave-3)

> A designed FEATURE at the doc/protocol level only — never a code import (PR-018). `mutagent-agentspec`
> does NOT depend on an evaluator skill to run standalone.

**Shape:** hand the built agent + its `spec.evaluation.criteria` (+ `scenarios`/`datasets`, D18/D19) to
an evaluator (the ADL EVALUATE stage) for eval-driven development. The spec's evaluation criteria SEED
the evaluator's eval-matrix (link, don't duplicate). When composed via Helix, `*eval` routes to the evaluator
skill; standalone, agentspec emits the eval criteria + (optionally) a thin self-contained eval stub.
The triad (spec ↔ impl ↔ eval) stays in lockstep with auto-spec-correction (PR-011) — the mechanism
lands with this stage.

---

## Loop position + transitions (PR-009)

The orchestrator KNOWS the next stage and proactively SUGGESTS it + renders loop position (tracked
OUTSIDE the 0.3.0 card — the 0.2 `meta.loop_state.stage` is retired, N01; the tracking mechanism rides
the coordinated FU-69 pass), but EVERY transition needs explicit operator confirmation. "Auto-orchestrate"
means suggest, never auto-run. Never auto-advance through a gate.
