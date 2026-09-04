// ---------------------------------------------------------------------------
// mutagent-optimize — the optimize-loop STATE MODEL (the deterministic core the
// optimize-loop-run.ts driver advances). Pure data + pure transitions: no clock,
// no random, no IO — every time-like input (elapsed budget, iteration) is passed
// IN, so the same (state, inputs) always yields the same next state + terminator.
//
// The loop is a BOUNDED, goal-legal FSM (Build → Verify → Eval → Gate →
// [Diagnose ↺]). It may only run if it declares an observable goal + hard
// termination gates (max-iters · wallclock budget · no-improvement) — else it
// refuses (see assertGoalLegal). An iteration counts as improvement ONLY on a
// strict, above-noise gain that does not regress variance (the variance-gate).
// ---------------------------------------------------------------------------

/** The FSM phases — S0..S5 + the terminal state. */
export const LoopPhase = {
  Init: "S0-init",
  Build: "S1-build", // ai-engineer #apply — WRITE (worktree-scoped)
  Verify: "S2-verify", // ai-architect PROCEED|STEER|ABORT
  Eval: "S3-eval", // evaluator re-eval swing — JUDGE
  Gate: "S4-gate", // GATE verdict PASS/FAIL
  Diagnose: "S5-diagnose", // analyzer RCA on new failures → back to S1
  Terminal: "terminal",
} as const;
export type LoopPhaseValue = (typeof LoopPhase)[keyof typeof LoopPhase];

/** How a bounded loop legally STOPS (goal-legal terminators). */
export const Terminator = {
  /** the observable goal was met (eval-pass · criterion · delta) */
  Converged: "converged",
  /** the eval delta flat-lined below the noise floor for N turns */
  NoImprovement: "no-improvement",
  /** hit the max-iters ceiling */
  MaxIters: "max-iters",
  /** hit the wallclock budget */
  Budget: "budget",
  /** ai-architect returned ABORT on an applied remedy */
  Aborted: "aborted",
} as const;
export type TerminatorValue = (typeof Terminator)[keyof typeof Terminator];

/** The observable goal a loop must declare to run at all. */
export type Goal =
  | { kind: "eval-pass" } // GATE = PASS (0 critical/high fail)
  | { kind: "criterion"; id: string } // a named criterion flips to pass
  | { kind: "delta"; min: number } // eval score improves by ≥ min
  // CODE-TARGET (Wave-2 W2I1). Converged = BOTH a hard deterministic gate (the code
  // subject's OWN test suite is green, `IterationRecord.testsGreen === true`) AND the
  // code-quality evaluator verdict passes (`gate === PASS`). NEITHER alone converges:
  // a green test suite with a failing quality verdict keeps looping, and a passing
  // quality verdict on a red test suite keeps looping. The session supplies both
  // signals per round (S1 build → test-green; S3/S4 → the quality gate) — see the
  // mutagent-optimize SKILL §2·5 code-target conduct branch.
  | { kind: "code-quality" }
  // NATURAL-LANGUAGE goal (Wave-2 W2I10; OT-4 widened to a criterion SET). A free-text
  // goal the operator typed (`*optimize <subject> --goal "<free text>"`). It carries the
  // raw `text` for provenance/audit, and is ILLEGAL until it is FROZEN — the loop needs an
  // OBSERVABLE, unchanging yardstick, so a free-text intent is not runnable on its own
  // (assertGoalLegal rejects `resolved === undefined` / an empty set, exactly as it rejects
  // an unbounded config). The INTERPRETATION of the text is AGENT reasoning done by the
  // top-level session at loop entry (interpret → confirm-once → freeze; SKILL §2·5), NOT a
  // code loop — a real NL intent usually decomposes into a COMPOSITION of binary criteria /
  // measurable-metric criteria, so the frozen form is a SET `resolved.criterionIds[]` (a
  // single-criterion intent is just a 1-element set). Once frozen, those ids name the
  // concrete criteria the loop runs against, and `goalMet` treats it like an AND of
  // `criterion` goals — met only when ALL listed ids pass (each a strict binary check).
  // A headless run (no human to confirm-freeze) therefore refuses at the goal-legal
  // gate — an unfrozen NL goal never runs unbounded.
  | { kind: "nl"; text: string; resolved?: { criterionIds: string[] } };

/**
 * The subject a loop is optimizing, by KIND — its ROLE (S15 / FU-69 §1.1). This axis mirrors the
 * SHIPPED AgentSpec 0.3.0 `kind` discriminator EXACTLY — the four kinds {agent, skill, multiAgent,
 * workflow} (operator ruling Q1=A, 2026-07-23; the PRD's 4-kind lock supersedes the FU-69 doc's
 * earlier two-value {agent|skill} role axis). It says WHAT the subject IS, never HOW it is realized.
 *
 * The code-vs-substrate distinction that used to be conflated onto this axis (the old
 * `code | agent | skill | platform` flat list — a category error, a Mastra agent is BOTH an `agent`
 * role AND `code` substrate) now lives on the SEPARATE `ARTIFACT_FORMATS` axis below. Goal legality
 * (the `code-quality` BOTH-gate) keys off `artifactFormat === "code"`, NEVER off this role axis
 * (FU-69 §1.4 with the operator's `artifact.format` supersession applied).
 *
 * `SUBJECT_KINDS` is the SINGLE SOURCE OF TRUTH for the legal role values — `SubjectKind` is derived
 * from it and `assertSubjectKind` validates raw CLI input (a bogus `--subject-kind` fails LOUD). The
 * inter-stage handover `SubjectKind` + config `TargetSubject` mirrors track the same 4-kind axis (S15
 * coordinated cutover).
 */
export const SUBJECT_KINDS = ["agent", "skill", "multiAgent", "workflow"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Type-guard: is `v` a recognized SubjectKind (role)? */
export function isSubjectKind(v: string): v is SubjectKind {
  return (SUBJECT_KINDS as readonly string[]).includes(v);
}

/**
 * Assert `v` is a recognized SubjectKind — throws (fail-closed) on an unrecognized value so a
 * bogus `--subject-kind` is rejected loudly rather than silently accepted. Used by the CLI
 * `assert-goal-legal --subject-kind` path.
 */
export function assertSubjectKind(v: string): asserts v is SubjectKind {
  if (!isSubjectKind(v)) {
    throw new Error(
      `unknown subject-kind '${v}' — expected one of: ${SUBJECT_KINDS.join(" · ")}`,
    );
  }
}

/**
 * The SUBSTRATE axis — how the subject is realized + deployed. Mirrors the AgentSpec 0.3.0
 * `targets[].artifact.format` enum EXACTLY (S15 / FU-69 §1.2, with `medium` superseded by
 * `artifact.format`, operator 2026-07-23):
 *   - `code`            — implementation IS source with its own test suite (Mastra / Agent-SDK / TS /
 *                         Python). The ONLY format that carries a deterministic test-suite gate, so the
 *                         `code-quality` BOTH-gate applies here and ONLY here.
 *   - `markdown`        — prompt / `.md`-defined (Claude Code, Codex): evals only, no code to test.
 *   - `platform-config` — the authoritative artifact lives on a hosted platform (reconstruct-spec,
 *                         applied via cloud-deploy): evals only.
 * ORTHOGONAL to `SUBJECT_KINDS`: any role × any format (an `agent` may be `code` OR `markdown`).
 */
export const ARTIFACT_FORMATS = ["code", "markdown", "platform-config"] as const;
export type ArtifactFormatValue = (typeof ARTIFACT_FORMATS)[number];

/** Type-guard: is `v` a recognized artifact format? */
export function isArtifactFormat(v: string): v is ArtifactFormatValue {
  return (ARTIFACT_FORMATS as readonly string[]).includes(v);
}

/** Assert `v` is a recognized artifact format — fail-closed on a bogus `--artifact-format`. */
export function assertArtifactFormat(v: string): asserts v is ArtifactFormatValue {
  if (!isArtifactFormat(v)) {
    throw new Error(
      `unknown artifact-format '${v}' — expected one of: ${ARTIFACT_FORMATS.join(" · ")}`,
    );
  }
}

/**
 * The apply-side enum in `@mutagent/tools` (`mutagent-cli apply --kind`). How an approved remedy is
 * MATERIALIZED — DERIVED from the substrate axis, not chosen independently (S15 / FU-69 §1.4).
 */
export const ApplyKind = {
  CodePr: "code-pr",
  Markdown: "markdown",
  CloudDeploy: "cloud-deploy",
} as const;
export type ApplyKindValue = (typeof ApplyKind)[keyof typeof ApplyKind];

/** The one legal `artifact.format → ApplyKind` mapping (S15 / FU-69 §1.4). Total over the enum. */
const ARTIFACT_FORMAT_TO_APPLY_KIND: Record<ArtifactFormatValue, ApplyKindValue> = {
  code: ApplyKind.CodePr,
  markdown: ApplyKind.Markdown,
  "platform-config": ApplyKind.CloudDeploy,
};

/**
 * Derive the ApplyKind from the subject's `artifact.format`: code→code-pr, markdown→markdown,
 * platform-config→cloud-deploy (S15 / FU-69 §1.4). Pure + total; the apply path is never chosen
 * independently of the substrate.
 */
export function deriveApplyKind(artifactFormat: ArtifactFormatValue): ApplyKindValue {
  return ARTIFACT_FORMAT_TO_APPLY_KIND[artifactFormat];
}

/** The loop's hard bounds + variance policy (the termination contract). */
export interface LoopConfig {
  goal: Goal;
  maxIters: number;
  budgetMs: number;
  /** consecutive non-improving turns before a no-improvement stop. */
  noImprovementStreak: number;
  /** the calibrated noise floor a delta must clear to count as improvement. */
  noiseFloor: number;
  /**
   * The subject KIND (role) the loop is optimizing (OPTIONAL) — one of the 4-kind axis
   * {agent, skill, multiAgent, workflow}. Informational/provenance: the role axis no longer
   * gates any goal (code-quality moved to the artifactFormat axis). Validated when supplied.
   */
  subjectKind?: SubjectKind;
  /**
   * The subject's `artifact.format` (substrate) — one of {code, markdown, platform-config}
   * (OPTIONAL). When present, `assertGoalLegal` enforces the artifact-format → goal legality
   * (a `code-quality` goal is illegal unless `artifactFormat === "code"`) — so a HEADLESS
   * `runOptimizeLoop` enforces the same guard the CLI enforces via `--artifact-format`, without
   * the flag. ADDITIVE: absent ⇒ the loop skips the artifact-format gate (unchanged behavior).
   */
  artifactFormat?: ArtifactFormatValue;
}

/** The ai-architect verdict on an applied remedy. */
export const ArchitectVerdict = {
  Proceed: "PROCEED",
  Steer: "STEER",
  Abort: "ABORT",
} as const;
export type ArchitectVerdictValue =
  (typeof ArchitectVerdict)[keyof typeof ArchitectVerdict];

/** The GATE verdict from the re-eval. */
export const GateVerdict = { Pass: "PASS", Fail: "FAIL" } as const;
export type GateVerdictValue = (typeof GateVerdict)[keyof typeof GateVerdict];

/** One iteration's recorded outcome (persisted in loop-state.json). */
export interface IterationRecord {
  iteration: number;
  verify: ArchitectVerdictValue;
  gate: GateVerdictValue;
  /** the eval score this turn (higher = better). */
  score: number;
  /** delta vs the previous kept score. */
  delta: number;
  /** whether this turn counted as an above-noise, variance-safe improvement. */
  improved: boolean;
  /**
   * CODE-TARGET (Wave-2 W2I1) — the hard deterministic test-suite gate result for
   * a `code` subject this turn: `true` iff the subject's OWN test suite ran green.
   * OPTIONAL + additive: undefined for non-code targets (they omit it, unchanged).
   * The `code-quality` goal requires this to be strictly `true` (an undefined /
   * absent signal never converges — safe default). It is a SEPARATE axis from
   * `gate` (the quality verdict) so both signals stay first-class + auditable in
   * loop-state.json; `goalMet` does the AND.
   */
  testsGreen?: boolean;
}

/** The loop-state.json cursor. */
export interface LoopState {
  iteration: number;
  phase: LoopPhaseValue;
  /** the score of the last KEPT (improving) iteration — the convergence anchor. */
  bestScore: number;
  /** running count of consecutive non-improving turns. */
  noImprovementCount: number;
  /** cumulative wallclock spent (ms), injected by the driver. */
  budgetSpentMs: number;
  history: IterationRecord[];
  terminator: TerminatorValue | null;
}

/** A loop is illegal (refuses to start) unless it declares real bounds. */
export function assertGoalLegal(config: LoopConfig): void {
  const problems: string[] = [];
  if (!config.goal) problems.push("no observable goal declared");
  if (!(config.maxIters > 0)) problems.push("maxIters must be > 0");
  if (!(config.budgetMs > 0)) problems.push("budgetMs must be > 0");
  if (!(config.noImprovementStreak > 0)) problems.push("noImprovementStreak must be > 0");
  if (config.noiseFloor < 0) problems.push("noiseFloor must be >= 0");
  // NATURAL-LANGUAGE goal (Wave-2 W2I10): an UNRESOLVED NL goal is NOT an observable,
  // bounded yardstick — it is a free-text intent, not yet a measurable criterion. It is
  // illegal exactly like an unbounded config, so the loop (interactive OR headless)
  // refuses to run it. A headless run has no human to confirm-freeze, so this gate is
  // precisely what makes it fall back / refuse rather than spin on an un-yardsticked goal.
  if (
    config.goal &&
    config.goal.kind === "nl" &&
    (config.goal.resolved === undefined || config.goal.resolved.criterionIds.length === 0)
  ) {
    problems.push(
      'natural-language goal is unresolved — freeze it to a measurable criterion set first ' +
        '(interpret → confirm-once → freeze; SKILL §2·5). A free-text goal is not a runnable yardstick.',
    );
  }
  if (problems.length > 0) {
    throw new Error(`optimize loop is not goal-legal — refusing to run: ${problems.join("; ")}`);
  }
  // ARTIFACT-FORMAT gate (S15 / FU-69 §1.4): when the config names the substrate, enforce that
  // the goal is applicable to it (a `code-quality` goal is illegal unless artifact.format ===
  // "code"). Folding this into assertGoalLegal — the ONE gate both the CLI and the headless
  // `runOptimizeLoop` call — lets a HEADLESS run enforce the guard without a flag. The role
  // (subjectKind) no longer gates any goal — code-quality keys off the substrate, never the role.
  // Absent artifactFormat ⇒ skipped (unchanged additive behavior).
  if (config.artifactFormat !== undefined) {
    assertGoalAllowedForArtifact(config.goal, config.artifactFormat);
  }
}

/**
 * ARTIFACT-FORMAT → GOAL legality (S15 / FU-69 §1.4; supersedes the old subject-kind gate). The
 * `code-quality` BOTH-gate is only meaningful for a `code` artifact.format (it ANDs a real test
 * suite with a quality verdict); a non-code substrate (`markdown` · `platform-config`) has no code
 * to test, so `code-quality` NEVER fires there — it must use an eval-based goal (`eval-pass` ·
 * `criterion` · `delta` · a frozen NL criterion). Legality keys off the SUBSTRATE axis, NEVER off
 * the role axis (an `agent` may be `code` OR `markdown`). All eval-based goals are valid for ANY
 * artifact.format (code included), so this gate constrains ONLY `code-quality`. Throws clearly.
 */
export function assertGoalAllowedForArtifact(goal: Goal, artifactFormat: ArtifactFormatValue): void {
  if (goal.kind === "code-quality" && artifactFormat !== "code") {
    throw new Error(
      `goal 'code-quality' is only valid for a 'code' artifact.format — a '${artifactFormat}' subject has ` +
        'no test suite / code to gate; use an eval-based goal (eval-pass · criterion · delta · a frozen NL criterion)',
    );
  }
}

/**
 * Parse the `--goal` argument (Wave-2 W2I10) into a `Goal`. Recognizes the four
 * STRUCTURED shapes and treats anything else as a NATURAL-LANGUAGE goal (free text) —
 * the catch-all is deliberate: an NL goal is illegal until frozen (see assertGoalLegal),
 * so a typo'd structured goal cannot silently run; it surfaces at the confirm-freeze step.
 *   eval-pass | code-quality | criterion:<id> | delta:<n> | "<any free text>"
 * PURE: no IO, no clock. Throws (fail-loud) on a malformed structured shape or empty input.
 */
export function parseGoal(raw: string): Goal {
  const s = raw.trim();
  if (!s) throw new Error("goal is empty — pass eval-pass · criterion:<id> · delta:<n> · code-quality · a free-text goal");
  if (s === "eval-pass") return { kind: "eval-pass" };
  if (s === "code-quality") return { kind: "code-quality" };
  if (s.startsWith("criterion:")) {
    const id = s.slice("criterion:".length).trim();
    if (!id) throw new Error('criterion goal needs an id — "criterion:<id>"');
    return { kind: "criterion", id };
  }
  if (s.startsWith("delta:")) {
    // Guard the EMPTY payload FIRST: `Number("") === 0` (and `Number.isFinite(0) === true`),
    // so without this an empty `delta:` would silently parse to `{kind:"delta",min:0}` — a
    // min of 0 converges on ANY above-noise gain, which is not what an operator who typed a
    // bare `delta:` meant. Fail loud instead (a missing threshold is a malformed goal).
    const payload = s.slice("delta:".length).trim();
    if (!payload) throw new Error('delta goal needs a number — "delta:<n>" (got an empty payload)');
    const min = Number(payload);
    if (!Number.isFinite(min)) throw new Error('delta goal needs a finite number — "delta:<n>"');
    return { kind: "delta", min };
  }
  // Everything else is a free-text (natural-language) goal — UNRESOLVED until frozen.
  return { kind: "nl", text: s };
}

/**
 * FREEZE a natural-language goal (Wave-2 W2I10; OT-4 widened to a criterion SET) to a
 * concrete, measurable criterion COMPOSITION — the step that makes it goal-legal. The
 * session INTERPRETS the free text into one or more binary / measurable-metric criteria
 * (agent reasoning at entry) and CONFIRMS once with the operator; this pure transform
 * records that frozen decision on the goal (keeping the original `text` for audit). After
 * freezing, `goalMet` runs it as an AND of `criterion` goals — met only when ALL listed
 * ids pass. Accepts either a single id (a 1-element set — back-compat) or a list, and
 * splits comma-separated ids so the CLI can pass `--criterion a,b`. Throws if the goal is
 * not an NL goal, or if no criterion id is supplied.
 */
export function freezeNlGoal(goal: Goal, criterionIds: string | string[]): Goal {
  if (goal.kind !== "nl") {
    throw new Error(`freezeNlGoal: goal is '${goal.kind}', not a natural-language goal — nothing to freeze`);
  }
  const ids = (Array.isArray(criterionIds) ? criterionIds : [criterionIds])
    .flatMap((c) => c.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("freezeNlGoal: a criterion id is required to freeze the NL goal");
  return { kind: "nl", text: goal.text, resolved: { criterionIds: ids } };
}

/** The variance-gate: an above-noise gain that does NOT regress variance. */
export function isImprovement(delta: number, noiseFloor: number, varianceRegressed: boolean): boolean {
  return delta > noiseFloor && !varianceRegressed;
}

/** Whether the observable goal is met this turn. */
export function goalMet(goal: Goal, rec: IterationRecord, criteriaPassed: Set<string>): boolean {
  switch (goal.kind) {
    case "eval-pass":
      return rec.gate === GateVerdict.Pass;
    case "criterion":
      return criteriaPassed.has(goal.id);
    case "delta":
      return rec.improved && rec.delta >= goal.min;
    case "code-quality":
      // BOTH-gate (Wave-2 W2I1): test-green AND quality-verdict PASS. `=== true`
      // makes an undefined/absent test signal fail-safe (never a false converge).
      return rec.testsGreen === true && rec.gate === GateVerdict.Pass;
    case "nl":
      // NATURAL-LANGUAGE goal (Wave-2 W2I10; OT-4 widened to a criterion SET). Only a
      // FROZEN NL goal is ever met — an unresolved / empty-set one can't reach here
      // (assertGoalLegal refuses to run it), and if it somehow does, it is never met
      // (fail-safe: the empty-set guard stops `[].every` from vacuously converging).
      // Frozen ⇒ an AND of `criterion` goals: met only when EVERY resolved id is in the
      // passed set (each id is a strict binary check / measurable-metric criterion).
      return (
        goal.resolved !== undefined &&
        goal.resolved.criterionIds.length > 0 &&
        goal.resolved.criterionIds.every((id) => criteriaPassed.has(id))
      );
    default: {
      const _never: never = goal;
      throw new Error(`unknown goal kind ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Compute the terminator (or null to continue) AFTER an iteration is recorded.
 * Ordering is deliberate: an ABORT halts immediately; then goal (success) wins
 * over the bounded stops so a converging final turn is reported as Converged.
 */
export function checkTerminators(
  state: LoopState,
  config: LoopConfig,
  lastVerify: ArchitectVerdictValue,
  criteriaPassed: Set<string>,
): TerminatorValue | null {
  const last = state.history[state.history.length - 1];
  if (lastVerify === ArchitectVerdict.Abort) return Terminator.Aborted;
  if (last && goalMet(config.goal, last, criteriaPassed)) return Terminator.Converged;
  if (state.noImprovementCount >= config.noImprovementStreak) return Terminator.NoImprovement;
  if (state.iteration >= config.maxIters) return Terminator.MaxIters;
  if (state.budgetSpentMs >= config.budgetMs) return Terminator.Budget;
  return null;
}

/** The next phase from the current one given the two in-loop gate results. */
export function nextPhase(
  phase: LoopPhaseValue,
  verify?: ArchitectVerdictValue,
  gate?: GateVerdictValue,
): LoopPhaseValue {
  switch (phase) {
    case LoopPhase.Init:
      return LoopPhase.Build;
    case LoopPhase.Build:
      return LoopPhase.Verify;
    case LoopPhase.Verify:
      // ABORT ends the turn; STEER re-builds; PROCEED advances to eval.
      if (verify === ArchitectVerdict.Abort) return LoopPhase.Terminal;
      if (verify === ArchitectVerdict.Steer) return LoopPhase.Build;
      return LoopPhase.Eval;
    case LoopPhase.Eval:
      return LoopPhase.Gate;
    case LoopPhase.Gate:
      // PASS → the turn may converge (driver checks terminators); FAIL → diagnose.
      return gate === GateVerdict.Pass ? LoopPhase.Terminal : LoopPhase.Diagnose;
    case LoopPhase.Diagnose:
      return LoopPhase.Build; // RCA remedy → next Build turn
    case LoopPhase.Terminal:
      return LoopPhase.Terminal;
    default: {
      const _never: never = phase;
      throw new Error(`unknown phase ${JSON.stringify(_never)}`);
    }
  }
}

/** A fresh loop-state cursor. */
export function initLoopState(): LoopState {
  return {
    iteration: 0,
    phase: LoopPhase.Init,
    bestScore: Number.NEGATIVE_INFINITY,
    noImprovementCount: 0,
    budgetSpentMs: 0,
    history: [],
    terminator: null,
  };
}

/**
 * Record one completed iteration into the cursor (pure — returns a new state).
 * Applies the variance-gate to decide improvement + advance/reset the streak.
 */
export function recordIteration(
  state: LoopState,
  config: LoopConfig,
  input: {
    verify: ArchitectVerdictValue;
    gate: GateVerdictValue;
    score: number;
    varianceRegressed: boolean;
    budgetSpentMs: number;
    /**
     * CODE-TARGET (Wave-2 W2I1) — the deterministic test-suite gate for a `code`
     * subject this turn. OPTIONAL: omit for non-code targets (recorded as
     * undefined, no behavior change). Threaded verbatim into the record so the
     * `code-quality` goal's BOTH-gate can AND it with the quality verdict.
     */
    testsGreen?: boolean;
  },
): LoopState {
  const iteration = state.iteration + 1;
  const prevBest = state.bestScore;
  const delta = prevBest === Number.NEGATIVE_INFINITY ? input.score : input.score - prevBest;
  const improved =
    prevBest === Number.NEGATIVE_INFINITY
      ? input.score > config.noiseFloor // first turn: any real signal
      : isImprovement(delta, config.noiseFloor, input.varianceRegressed);
  const rec: IterationRecord = {
    iteration,
    verify: input.verify,
    gate: input.gate,
    score: input.score,
    delta,
    improved,
    // Only stamp the field when the session supplied it — a non-code turn keeps the
    // record shape identical to pre-W2I1 (no `testsGreen` key ⇒ byte-identical).
    ...(input.testsGreen === undefined ? {} : { testsGreen: input.testsGreen }),
  };
  return {
    iteration,
    phase: LoopPhase.Gate,
    bestScore: improved ? input.score : prevBest,
    noImprovementCount: improved ? 0 : state.noImprovementCount + 1,
    budgetSpentMs: input.budgetSpentMs,
    history: [...state.history, rec],
    terminator: null,
  };
}
