/**
 * scripts/optimize-loop-run.ts — the deterministic optimize-loop FSM harness.
 * ---------------------------------------------------------------------------
 * ⚠️ THIS IS NOT THE INTERACTIVE RUNTIME. The interactive `*optimize` loop is
 * conducted by the TOP-LEVEL SESSION (Model B) — the session is the only thing
 * that can Task-dispatch sub-agents, so the SESSION conducts the loop per the
 * SKILL.md "runtime conduct" procedure, calling the pure decisions one-shot via
 * `scripts/loop-state-cli.ts` between dispatches. There is deliberately NO
 * production `CrewBindings` implementation that `await`s Task dispatches (a
 * sub-agent cannot spawn sub-agents; a TS `while` awaiting dispatches is the wrong
 * shape for the interactive runtime). See CLAUDE.md "Two runtimes".
 *
 * What this file IS — two legitimate NON-interactive uses of the SAME FSM:
 *   (a) the UNIT-TEST HARNESS — tests drive the ring with a scripted fake crew to
 *       prove the loop-state decisions end-to-end (tests/optimize-loop-run.test.ts).
 *   (b) a future HEADLESS VERIFICATION driver (Model A / SimuLatte sim-run) — a
 *       deterministic child-spawn run for CI/regression, NOT a live operator loop.
 *
 * INVARIANT (for both uses): the driver is deterministic TypeScript, NEVER an LLM.
 * LLM work happens only inside the crew, reached through the INJECTED `CrewBindings`
 * seam. Every time-like input (`now`, `monotonic`) + the crew + the fs writer are
 * injected, so the same (config, crew, clock) always yields the same trajectory +
 * terminator. The crew seam is a TEST/verification abstraction — the interactive
 * "crew binding" is the SKILL.md procedure (an agent action), not a TS object.
 */

import {
  ArchitectVerdict,
  GateVerdict,
  LoopPhase,
  Terminator,
  assertGoalLegal,
  checkTerminators,
  initLoopState,
  recordIteration,
} from "./loop-state.ts";
import type {
  ArchitectVerdictValue,
  GateVerdictValue,
  LoopConfig,
  LoopState,
  TerminatorValue,
} from "./loop-state.ts";
import type { AmendRequest } from "./contracts/amend-request.ts";

/** What one crew phase needs. */
export interface TurnContext {
  iteration: number;
  /** the best (kept) score so far — the crew may use it for the amend brief. */
  bestScore: number;
  /** the prior diagnose remedy fed into this Build turn (empty on the first). */
  remedy: string;
  /**
   * Wave-2 W2I2 (unify amend formats) — the OPTIONAL structured amend request that
   * fed this Build turn, normalized to the unified `AmendRequest` superset. Both the
   * evaluator (EddChangeRequest) and diagnostics (Remedy) dialects map INTO this one
   * shape via scripts/contracts/amend-request.ts, so the S1 build handover reads a
   * single contract regardless of emitter. ADDITIVE: absent on legacy string-only
   * turns (`remedy` is the collapsed NL brief via `amendToBuildRemedy`), so the FSM
   * + existing harness tests are unchanged.
   */
  amend?: AmendRequest;
}

/** The evaluator's re-eval outcome for one turn. */
export interface EvalOutcome {
  score: number;
  gate: GateVerdictValue;
  criteriaPassed: string[];
  varianceRegressed: boolean;
  /**
   * CODE-TARGET (Wave-2 W2I1) — the deterministic test-suite gate for a `code`
   * subject: `true` iff the subject's OWN test suite ran green this turn. OPTIONAL:
   * a non-code target omits it (undefined). Under a `code-quality` goal the
   * BOTH-gate requires this strictly `true` AND `gate === PASS` to converge. In the
   * interactive runtime this signal originates in S1 (ai-engineer's code-target TDD
   * inner loop); the crew seam surfaces it here for the non-interactive harness.
   */
  testsGreen?: boolean;
}

/**
 * The crew seam for the NON-interactive uses only (unit test · future headless
 * verification). The interactive runtime has NO such TS binding — the session
 * conducts and Task-dispatches the real sub-agents per SKILL.md. Kept abstract so
 * the FSM is driveable by a scripted fake crew (no LLM, no sub-agents) in tests,
 * or by a headless child-spawn binding (Model A / sim-run) for CI regression.
 */
export interface CrewBindings {
  /** S1 — ai-engineer #apply (worktree-scoped WRITE). Returns the applied diff summary. */
  build(ctx: TurnContext): Promise<{ appliedDiff: string }>;
  /** S2 — ai-architect PROCEED|STEER|ABORT on the applied change. */
  verify(ctx: TurnContext): Promise<ArchitectVerdictValue>;
  /** S3+S4 — evaluator re-eval swing → score + GATE verdict. */
  evaluate(ctx: TurnContext): Promise<EvalOutcome>;
  /** S5 — analyzer RCA on the new failures (feeds the next Build). Only on a FAIL gate. */
  diagnose(ctx: TurnContext): Promise<{ remedy: string }>;
}

/** Everything injected → determinism (mirrors sim-run.ts RunOptions). */
export interface RunOptions {
  runId: string;
  crew: CrewBindings;
  /** injected ISO clock (audit stamps). */
  now: () => string;
  /** injected monotonic ms (budget accounting) — NOT wall-clock. */
  monotonic: () => number;
  /** where loop-state.json + the report are written. */
  projectRoot: string;
  /** fs writer seam (tests capture without touching disk). */
  writeFile: (path: string, contents: string) => void;
  mkdirp: (path: string) => void;
  /** wirecard sink (default: console.info via the CLI). */
  out: (line: string) => void;
  /** emit the living HTML report. */
  html?: boolean;
}

export interface RunResult {
  state: LoopState;
  terminator: TerminatorValue;
  /** the final wirecard (also emitted via opts.out during the run). */
  wirecard: string;
  /** the report HTML (present when opts.html). */
  reportHtml?: string;
}

const runDir = (projectRoot: string, runId: string): string =>
  `${projectRoot}/.mutagent/optimize/runs/${runId}`;

/**
 * Run the bounded optimize loop. Deterministic given (config, crew, clock).
 * Throws (goal-legality) if the config is not bounded.
 */
export async function runOptimizeLoop(config: LoopConfig, opts: RunOptions): Promise<RunResult> {
  // Refuses an un-yardsticked loop: unbounded config OR an unresolved natural-language
  // goal (Wave-2 W2I10). A headless run has NO human to confirm-freeze an NL goal, so an
  // unfrozen NL goal throws here — the driver never runs a free-text goal unbounded (it
  // must be a structured goal or a pre-frozen NL criterion). See assertGoalLegal.
  assertGoalLegal(config);
  const dir = runDir(opts.projectRoot, opts.runId);
  opts.mkdirp(dir);

  const start = opts.monotonic();
  let state = initLoopState();
  let remedy = "";
  let terminator: TerminatorValue | null = null;
  let lastVerify: ArchitectVerdictValue = ArchitectVerdict.Proceed;

  // hard iteration ceiling belt-and-suspenders (checkTerminators also enforces it)
  while (terminator === null && state.iteration < config.maxIters + 1) {
    const iteration = state.iteration + 1;
    const ctx: TurnContext = { iteration, bestScore: state.bestScore, remedy };

    // S1 BUILD (ai-engineer #apply, worktree-scoped)
    await opts.crew.build(ctx);

    // S2 VERIFY (ai-architect)
    lastVerify = await opts.crew.verify(ctx);

    let evalOut: EvalOutcome;
    if (lastVerify === ArchitectVerdict.Abort) {
      // ABORT ends the turn with no eval — record a non-improving turn at the best score.
      evalOut = { score: state.bestScore === Number.NEGATIVE_INFINITY ? 0 : state.bestScore, gate: GateVerdict.Fail, criteriaPassed: [], varianceRegressed: false };
    } else if (lastVerify === ArchitectVerdict.Steer) {
      // STEER — the change needs rework; count a non-improving turn, re-build next iteration.
      evalOut = { score: state.bestScore === Number.NEGATIVE_INFINITY ? 0 : state.bestScore, gate: GateVerdict.Fail, criteriaPassed: [], varianceRegressed: false };
    } else {
      // S3+S4 EVAL + GATE (evaluator re-eval swing)
      evalOut = await opts.crew.evaluate(ctx);
    }

    const budgetSpentMs = opts.monotonic() - start;
    state = recordIteration(state, config, {
      verify: lastVerify,
      gate: evalOut.gate,
      score: evalOut.score,
      varianceRegressed: evalOut.varianceRegressed,
      budgetSpentMs,
      // CODE-TARGET (Wave-2 W2I1) — threaded verbatim (undefined for non-code turns
      // + for ABORT/STEER turns that never reached eval). The BOTH-gate lives in
      // loop-state's goalMet(code-quality); the driver only carries the signal.
      testsGreen: evalOut.testsGreen,
    });

    // persist the cursor + emit the wirecard every iteration
    opts.writeFile(`${dir}/loop-state.json`, JSON.stringify(state, null, 2) + "\n");
    opts.out(renderWirecard(state, config, lastVerify, false));

    terminator = checkTerminators(state, config, lastVerify, new Set(evalOut.criteriaPassed));
    if (terminator !== null) break;

    // S5 DIAGNOSE — a FAIL gate that is still continuing gets RCA to feed the next Build.
    if (evalOut.gate === GateVerdict.Fail && lastVerify === ArchitectVerdict.Proceed) {
      remedy = (await opts.crew.diagnose(ctx)).remedy;
    } else {
      remedy = "";
    }
  }

  // by construction the loop only exits via a terminator; default to MaxIters.
  const finalTerminator = terminator ?? Terminator.MaxIters;
  state = { ...state, terminator: finalTerminator, phase: LoopPhase.Terminal };
  opts.writeFile(`${runDir(opts.projectRoot, opts.runId)}/loop-state.json`, JSON.stringify(state, null, 2) + "\n");

  const wirecard = renderWirecard(state, config, lastVerify, true);
  opts.out(wirecard);

  let reportHtml: string | undefined;
  if (opts.html) {
    reportHtml = renderReportHtml(state, config, opts.runId, opts.now());
    opts.writeFile(`${runDir(opts.projectRoot, opts.runId)}/optimize-report.html`, reportHtml);
  }

  return { state, terminator: finalTerminator, wirecard, reportHtml };
}

/** The periodic terminal dashboard — iteration · phase · per-gate · Δ · terminator. */
export function renderWirecard(
  state: LoopState,
  config: LoopConfig,
  lastVerify: ArchitectVerdictValue,
  terminal: boolean,
): string {
  const last = state.history[state.history.length - 1];
  const lines: string[] = [];
  lines.push(
    `┌─ optimize ${terminal ? "· TERMINAL" : ""} ─ iter ${state.iteration}/${config.maxIters} · phase ${state.phase}`,
  );
  if (last) {
    // CODE-TARGET (Wave-2 W2I1) — surface the deterministic test-suite gate ONLY when
    // it was recorded (a `code` subject turn). Absent ⇒ the line is byte-identical to
    // pre-W2I1 for every non-code target.
    const testsCell =
      last.testsGreen === undefined ? "" : `  ·  tests ${last.testsGreen ? "GREEN" : "red"}`;
    lines.push(
      `│  verify ${lastVerify}  ·  gate ${last.gate}${testsCell}  ·  score ${last.score.toFixed(3)}  ·  Δ ${last.delta >= 0 ? "+" : ""}${last.delta.toFixed(3)}  ·  ${last.improved ? "OPTIMIZED" : "flat"}`,
    );
  }
  lines.push(
    `│  best ${state.bestScore === Number.NEGATIVE_INFINITY ? "—" : state.bestScore.toFixed(3)}  ·  no-improve ${state.noImprovementCount}/${config.noImprovementStreak}  ·  budget ${Math.round(state.budgetSpentMs)}ms/${config.budgetMs}ms`,
  );
  if (terminal && state.terminator) {
    lines.push(`└─ TERMINATED: ${state.terminator}  (goal: ${goalLabel(config)})`);
  } else {
    lines.push(`└─ goal: ${goalLabel(config)}`);
  }
  return lines.join("\n");
}

function goalLabel(config: LoopConfig): string {
  switch (config.goal.kind) {
    case "eval-pass":
      return "eval-pass (GATE PASS)";
    case "criterion":
      return `criterion:${config.goal.id}`;
    case "delta":
      return `delta:${config.goal.min}`;
    case "code-quality":
      return "code-quality (tests-green + quality verdict)";
    case "nl":
      // NATURAL-LANGUAGE goal (Wave-2 W2I10). A headless run can only reach here with a
      // FROZEN NL goal — an unfrozen one is rejected by assertGoalLegal above (no human
      // to confirm-freeze headless), so the driver refuses rather than run unbounded.
      return config.goal.resolved
        ? `nl→criterion:${config.goal.resolved.criterionIds.join(",")} ("${config.goal.text}")`
        : `nl (UNRESOLVED: "${config.goal.text}")`;
    default: {
      const _never: never = config.goal;
      throw new Error(`unknown goal ${JSON.stringify(_never)}`);
    }
  }
}

/** The living HTML report — per-iteration score trajectory + terminator + Δ. */
export function renderReportHtml(state: LoopState, config: LoopConfig, runId: string, at: string): string {
  const rows = state.history
    .map(
      (r) =>
        `<tr><td>${r.iteration}</td><td>${r.verify}</td><td>${r.gate}</td><td>${r.score.toFixed(3)}</td><td>${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(3)}</td><td>${r.improved ? "✓" : "·"}</td></tr>`,
    )
    .join("\n");
  const best = state.bestScore === Number.NEGATIVE_INFINITY ? "—" : state.bestScore.toFixed(3);
  return `<!doctype html>
<meta charset="utf-8">
<title>optimize · ${runId}</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0b0a12;color:#e9e6f4;margin:0;padding:24px}
  h1{font-size:18px;color:#a78bfa} .meta{color:#918bab;font-size:12px}
  table{border-collapse:collapse;margin-top:16px;font-size:13px}
  th,td{border:1px solid #2b2640;padding:6px 12px;text-align:right}
  th{background:#15121d;color:#a78bfa} .term{margin-top:14px;color:#4ade80}
</style>
<h1>mutagent-optimize · ⑤ OPTIMIZE loop</h1>
<div class="meta">run ${runId} · rendered ${at} · goal ${goalLabel(config)} · best ${best}</div>
<table>
  <thead><tr><th>iter</th><th>verify</th><th>gate</th><th>score</th><th>Δ</th><th>improved</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<div class="term">TERMINATED: ${state.terminator ?? "—"} · ${state.iteration} iteration(s) · best ${best}</div>
`;
}
