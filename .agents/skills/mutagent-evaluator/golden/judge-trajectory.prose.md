# golden/judge-trajectory.prose.md — the C-PIN prose surface (VERSIONED anchor)

> The #mode-judge-trajectory judge constructs its prompt AT REASON-TIME from the
> packet + this mode's prose — so THIS prose is the load-bearing C-PIN surface.
> Any change to the workflow below is a judge-behavior change and MUST bump the
> version here (the W-gate byte-identity proof anchors against this snapshot).

## v3.2 — 2026-07-31 · LAYER SEMANTICS CORRECTION (L2 many-paths · L3 recoverability · L4 presumed-fatal)

Change vs v3.1 (the L2/L3/L4 clauses of the WALK line, plus one clause on CONFLICT
DISCIPLINE). These are CORRECTIONS of what the walk previously asserted, not additions:

- **L2** asked "actual-vs-expected decision path". An agent can follow DIFFERENT
  trajectories to the same goal, so sequence-divergence is not evidence of anything.
  It now asks whether every MANDATORY step is present somewhere.
- **L3** treated any failed tool as making everything downstream suspect. A failure that
  was RETRIED and SUCCEEDED is ordinary resilience; only an IRRECOVERABLE one (retried,
  never succeeded, workflow cannot complete) poisons what follows. Collapsing the two was
  the largest available source of false findings. `CE-P6` computes the discriminator
  mechanically.
- **L4** gains "a context gap is PRESUMED FATAL" — you cannot succeed with bad context,
  so a passing outcome above a context gap is an UNEXPLAINED SUCCESS, stated as such.
- **CONFLICT DISCIPLINE** gains the precedence reading (context ▸ tools ▸ trajectory ▸
  outcome) as an EXPLANATION only — explicitly never a resolution and never a gate input.

VERBATIM snapshot of the mode workflow follows.

## v3.1 — 2026-07-24 · REF-CONTRACT HARDENING (the first-real-run verify-surface flip)

Change vs v3.0 (ONE workflow line — GATHER): the ref contract is made explicit
after the first real run showed judge-cited packet-shaped refs reading as DEAD
at deterministic re-verify (both verifier-UPHELD HIGH fails silently downgraded
→ gate flipped fail→incomplete). Now: `ref.obs` = the packet's `trajectoryId`
(NEVER an observation name — batch-order first-match can locate the wrong
trajectory), `ref.path` = packet-shaped `trajectory.N`/`transcript.N` OR
trace-shaped `observations.N` (both re-resolve — the verifier reconstructs the
packet views via `verifySituationViews`), dot form canonical, brackets
tolerated (`readPath` normalizes). VERBATIM snapshot of the mode workflow
follows.

```yaml
  - evaluate:
      meta:
        what: "Score ONE trajectory against the WHOLE eval matrix (was the eval-matrix-judge agent). The DEFAULT/headline judging cell."
        does: "Reads a MatrixPacket (the whole matrix + one trajectory + transcript + pinned envelope), BUILDS its judging prompt from the packet + the shared write-judge-prompt.md, scores every criterion for that trajectory, writes a per-trajectory MatrixVerdictFile."
        why:  "Per-TRAJECTORY fan-out (one judge scores the whole matrix for one session) = high throughput across many sessions. EV-048. This is the headline *evaluate path."
        how:  "Unlike the criterion axis, NO script renders the prompt — the parent's matrix-judge.ts PREPs only a DATA packet (keyed by trajectoryKey); THIS mode constructs the prompt at reason-time. Its prompt-construction prose is therefore the load-bearing C-PIN surface (golden/judge-trajectory.prose.md)."
      display: "Score one trajectory against the WHOLE eval matrix (headline)"
      description: |
        PURPOSE: the DEFAULT headline judging cell — one judge per trajectory scores
        the entire eval matrix for that session → per-criterion verdicts. Critique-
        before-verdict, binary, inaction-can-be-success, whole-matrix-per-trajectory.

        USAGE: dispatched by the parent, MASS-PARALLEL (one per trajectory). Reads
        <trajectory_key>.packet.json (a MatrixPacket — DATA, NOT a rendered prompt);
        BUILDS the prompt from it + write-judge-prompt.md; writes the MatrixVerdictFile.
      dispatch: { mode: judge, axis: trajectory }
      pre_gate.loads:
        - "references/write-judge-prompt.md"    # SHARED 4-component contract (both judge axes; now BIND-before-judge)
        - "references/grounded-adjudication.md"  # GA doctrine: bind · gather refs · typed assumptions · abstain · verify
        - "references/workflows/orchestrator-protocol.md"  # Step 2 dispatch FSM
      workflow:
        - "Pre-read references/write-judge-prompt.md (the 4-component judging contract — your lens) + references/grounded-adjudication.md"
        - "Read your assigned <trajectory_key>.packet.json (MatrixPacket: subject · trajectoryId · WHOLE matrix · trajectory · transcript · pinned envelope) — judge exactly this, never re-derive the data"
        - "Frame the trajectory in its ROUTE/intended-outcome (CONTEXT) before scoring"
        - "v3 LAYERED WALK (D1=B+, operator-frozen): the walk IS a fixed layer sequence you run INSIDE this one dispatch. Honor `packet.layerScope` when present (absent/empty = FULL walk). The phases: (L0 code checks) if the code-eval library is present at scripts/code-eval-library.ts, RUN it yourself via Bash over the packet's trajectory JSON and record each hit as codeEvalHits[{pattern,anchor,detail}] — a fired pattern is evidence, not a verdict; (L1 outcome) classify the SCENARIO from the inbound intent + tool inventory, derive its expectedExit[] terminal actions, glance ONLY at end-state evidence and emit layerVerdicts[{layer:'L1',verdict,scenario,expectedExit,refs,note}]; (STOPPING RULES) if L1 passes AND every criterion is answerable from evidence gathered so far → you may set earlyExit:'L1' and mark L2-L4 as {verdict:'skipped'} — but a criterion may NEVER go unverdicted because the agent did the right thing; if ANY criterion is unanswerable OR L1 fails/undecidable → descend; (L2 trajectory) is every MANDATORY step present SOMEWHERE in the session (a required guard/approval/consent check)? An agent can follow DIFFERENT trajectories to reach the same goal — a path that merely diverges from the one you expected is NOT a finding; only a MISSING mandatory step is. Judge presence-of-required-steps, never sequence-equality-with-an-expected-script; emit layerVerdicts L2 (+ divergence in localize); (L3 tool outputs) per-observation structural validity + completeness — external-data correctness is UNVERIFIABLE (fence). A failing tool call is NOT itself a defect: classify RECOVERABILITY — failed→retried→SUCCEEDED is ordinary resilience and NOT a finding; failed→retried→never succeeded (workflow cannot complete) is IRRECOVERABLE and a real failure; failed→never retried while the agent proceeds as if it had the data is fault-passthrough (the agent is inventing). Only an IRRECOVERABLE failure makes everything downstream suspect. CE-P6 computes this mechanically — read it, do not re-derive it; emit layerVerdicts L3 (+firstProblemOrigin); (L4 context) for each critical operational send: was required context retrieved AND present in history AT THAT TIME (chronology-sorted!) — distinguish gapKind retrieval (never fetched) vs attention (present, ignored). A context gap is PRESUMED FATAL: you cannot succeed with bad context — without what it needed the agent could only have guessed right, so a passing outcome on top of a context gap is an UNEXPLAINED SUCCESS and must be stated as one, never as confirmation; emit layerVerdicts L4. Record layersEngaged. CONFLICT DISCIPLINE (OT-1): when your own layers disagree (e.g. L1 pass vs L2 fail) emit BOTH verdicts honestly with a note — NEVER reconcile them yourself; the aggregate surfaces the conflict for a human. You MAY state which layer is most upstream (precedence: context ▸ tools ▸ trajectory ▸ outcome — the most upstream failing layer EXPLAINS the run, and no downstream pass clears an upstream failure) — but that is an EXPLANATION, never a resolution and never a gate input: the GATE is driven by criteria severity alone."
        - "Score EVERY criterion in the matrix for THIS trajectory: read only what the row needs (judgeInputs); compare against statement + passCondition — criteria are the SUPER-LAYER: they may bind evidence from ANY walk phase"
        - "BIND (L1) per row: each criterion TERM must resolve in THIS trajectory; an unbound term ⇒ uncertain + blockedBy:{kind:factual-intent} (INDETERMINATE), ABSTAIN — never fail"
        - "GATHER: cite a structured ref {obs,path,value} for the claim AND any absence (ref.obs = the packet's trajectoryId, NEVER an observation name; ref.path = packet-shaped trajectory.N/transcript.N OR trace-shaped observations.N — dot form canonical, brackets tolerated); surface TYPED assumptions for any ungroundable premise → uncertain(blockedBy)"
        - "Critique BEFORE verdict; commit to result ∈ {pass,fail} (uncertain when the INPUTS can't decide — abstain-on-silence); binary, severity is the row's"
        - "Inaction-can-be-success: a correct HOLD (no send during a non-critical outbound_guard) is a PASS even with zero tool calls"
        - "Write <trajectory_key>.verdict.json (a MatrixVerdictFile {trajectoryId, judgeModel, temperature:0, verdicts[]} — each verdict may carry refs?/assumptions?/blockedBy?)"
        - "EMIT-CONTRACT (HARD, WS-1): on every COMPLETE-fidelity trajectory you MUST also persist the §9.4 walk — `understanding` (M2), `expectedTrajectory` (M3), `agentSteps` (the target step lane), and `judgeSteps` (your anchored reasoning). These are NOT optional: the parent runs a machine `assessEmitCompleteness` gate (scripts/emit-completeness.ts) that LOUDLY flags any wholly-dropped field, and a verdict missing them STARVES the report's Trajectory (§2) + Self-Eval (§5) tabs. `agentSteps` is factual trace data (reconstruct it from the ordered tool steps you were given — order by startTime, the observations array is reverse-chronological); M2/M3/judgeSteps are YOUR reasoning. Only an INCOMPLETE (node-1) trajectory is exempt (it emits verdicts:[] and no walk)."
        - "v3 EMIT-CONTRACT ADDITIONS (E-NEW): alongside the §9.4 walk, persist layerVerdicts[] (one per engaged layer, skipped ones marked), earlyExit?, layersEngaged, codeEvalHits[] (when the library ran), and the emissions SELF-MANIFEST {emitted[], missing[{key,reason}]} — list honestly what you gathered vs what this contract expects; a missing emission with a stated reason is a NAMED degrade, a silent drop is a defect (MR-5 catches it same-run)."
        - "Verdicts are independently VERIFIED (#mode-verify · ≠ judge · downgrade-only); a CRIT/HIGH uncertain rolls the run up to INCOMPLETE at the gate (no false-green)"
      compresses:
        - "read MatrixPacket DATA; frame in ROUTE (CONTEXT)"
        - "build judging prompt from packet + write-judge-prompt.md"
        - "BIND terms · GATHER refs + typed assumptions · abstain on silence"
        - "score whole matrix per trajectory, critique-before-verdict"
        - "emit MatrixVerdictFile (then independent VERIFY, downgrade-only)"
      preserves: "the eval-matrix-judge discipline (the headline cell; prompt-construction prose at golden/judge-trajectory.prose.md) — folded INLINE as 'Mode: judge — axis trajectory' (below); the standalone assets/agents/eval-matrix-judge.md was RETIRED in the 5→3 consolidation (Phase 3a, df6a6e8c8). This file is its canonical home."
```

## history

- v3.2 (2026-07-31): layer semantics correction — L2 mandatory-step presence (many valid paths), L3 recoverable vs irrecoverable tool failure (CE-P6), L4 context gap presumed fatal, precedence as explanation-never-gate.
- v3.1 (2026-07-24): GATHER ref-contract hardening — obs=trajectoryId, packet-OR-trace-shaped paths, dot canonical/brackets tolerated (fixes the verify-surface fail→incomplete flip found on the first real-trace run).
- v3.0 (2026-07-24): layered walk + v3 emit-contract (evaluator-v3, operator-frozen).
- v2.2 and earlier: prose lived inline in evaluator.md only; no on-disk snapshot existed (this file materializes the long-referenced golden anchor).
