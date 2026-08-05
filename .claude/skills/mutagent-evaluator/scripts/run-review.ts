/**
 * run-review — the `*review` RUN COMPOSER.
 *
 * WHAT THIS CLOSES. `render-review-report-v3.ts` could render the W4 review surface,
 * but nothing ASSEMBLED its input: producing the report meant hand-building a
 * `RenderReviewV3Input` in a session driver. This module reads an existing run
 * directory — the artifacts `*evaluate` already persists, no new ones — and produces
 * `review-report.html` beside `evaluation-report.html`. After this, the SYSTEM
 * produces the review report; a human no longer does.
 *
 * It is the analogue of run-evaluate's `writeRunReport` and the discovery composer,
 * and it reuses their conventions: the same run/report directory layout, the same
 * strict verdict-file parser, the same "v2 output kept alongside" transition rule.
 *
 * ── WHAT IT READS (all pre-existing) ──────────────────────────────────────────
 *   <runDir>/run-input.full.json   subject · criteria · pin · producedAt, and the
 *                                  INGESTED trajectories (with their observations,
 *                                  which give the drill's left lane real tool I/O)
 *   <runDir>/run-input.json        the same minus the heavy arrays — the fallback,
 *                                  used only when the full file is absent
 *   <runDir>/verdicts/*.verdict.json   one judged trajectory each
 *
 * `*.verify.json` files live in the same directory and are NOT verdicts (they are
 * the independent-verify ledger); they are excluded by suffix, not by guesswork.
 *
 * ── THE JOIN, AND WHY IT IS NOT THE FILENAME ──────────────────────────────────
 * A verdict file is named for its PACKET, not its trajectory: `ffc2f7c7.verdict.json`
 * carries `trajectoryId: "b90818a24afc5069"`. The join is therefore on the parsed
 * `trajectoryId` — never on the file stem, which would silently produce a report
 * whose traces match nothing.
 *
 * ── HONESTY ───────────────────────────────────────────────────────────────────
 * An ingested trajectory with no verdict file is NOT silently dropped: the composer
 * counts it and emits a `scopeNote` naming how many of the ingested trajectories were
 * judged, which the surface renders as a declared scope reduction. `run-input.json`'s
 * placeholder strings (it stores `"<5 EvalTraces>"` in place of the arrays) are
 * detected and treated as ABSENT rather than parsed as data.
 *
 * ── DELIBERATELY OUT OF SCOPE — this is NOT W4 ────────────────────────────────
 * No feedback store, no ruling persistence, no propagation of a ruling into
 * `*validate`, no calibration application. This module PRODUCES the artifact; it does
 * not consume a reviewer's answer. That loop is task #9 and is a separate contract.
 *
 * PURE except the file reads and the report write.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMatrixVerdictFile } from "./contracts/eval-matrix.ts";
import type { MatrixCriterion, MatrixVerdictFile } from "./contracts/eval-matrix.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";
import { runDir as defaultRunDir } from "./artifact-paths.ts";
import { renderReviewReportV3, writeReviewRunReportV3, type RenderReviewV3Input } from "./render-review-report-v3.ts";

/** the trajectory shape the review surface needs — id plus real observations. */
interface IngestedTrace {
  id: string;
  observations?: { type?: string; name?: string; input?: unknown; output?: unknown }[];
}

/** the subset of a persisted run-input this composer reads. */
interface PersistedRunInput {
  subject?: { name?: string; kind?: string };
  trajectories?: unknown;
  criteria?: MatrixCriterion[];
  subjectProfile?: unknown;
  pin?: { model?: string; temperature?: number };
  producedAt?: string;
}

export interface ReviewRunArgs {
  runId: string;
  /** repo root; defaults to process.cwd(). Reports land under its `.mutagent`. */
  cwd?: string;
  /** override the run directory (defaults to the standard runs/<runId> path). */
  runDir?: string;
  /** see render-review-report-v3: this surface renders identically either way. */
  audience?: "internal" | "external";
  devFeedback?: boolean;
  /** the living-suite version these criteria came from, when known. */
  suiteVersion?: string;
  /** appended to the composer's own derived scope note. */
  scopeNote?: string;
}

export interface ReviewRunResult {
  report: string;
  fallback: string | null;
  runId: string;
  trajectoriesIngested: number;
  trajectoriesJudged: number;
  verdicts: number;
  criteria: number;
  /** verdict files whose trajectoryId matched no ingested trajectory. */
  unjoinedTrajectoryIds: string[];
}

/** `run-input.json` stores `"<5 EvalTraces>"` where the full file stores the array. */
function asArray<T>(v: unknown): T[] | null {
  return Array.isArray(v) ? (v as T[]) : null;
}

/** Read the persisted run-input, preferring the full file. FAIL-LOUD when neither exists. */
function readRunInput(dir: string): { data: PersistedRunInput; path: string } {
  for (const name of ["run-input.full.json", "run-input.json"]) {
    const p = join(dir, name);
    if (existsSync(p)) return { data: JSON.parse(readFileSync(p, "utf8")) as PersistedRunInput, path: p };
  }
  throw new Error(
    `run-review: no run-input.full.json or run-input.json in '${dir}'. ` +
      "The review surface is composed from an EXISTING *evaluate run — point it at a run directory that has one.",
  );
}

/** Every `*.verdict.json` in the run's verdict dir, parsed strictly. */
function readVerdictFiles(dir: string): MatrixVerdictFile[] {
  const vdir = join(dir, "verdicts");
  if (!existsSync(vdir)) throw new Error(`run-review: no verdicts/ directory in '${dir}' — nothing has been judged for this run.`);
  // `.verify.json` is the independent-verify ledger, NOT a verdict — excluded by
  // suffix so a future sibling artifact cannot silently be parsed as a verdict.
  const names = readdirSync(vdir).filter((f) => f.endsWith(".verdict.json")).sort();
  if (names.length === 0) throw new Error(`run-review: no *.verdict.json files in '${vdir}' — nothing has been judged for this run.`);
  return names.map((n) => {
    try {
      return parseMatrixVerdictFile(readFileSync(join(vdir, n), "utf8"));
    } catch (e) {
      // name the FILE — a schema violation with no filename is unactionable when
      // a run carries dozens of verdicts.
      throw new Error(`run-review: ${n} is not a valid verdict file — ${String((e as Error).message).slice(0, 200)}`);
    }
  });
}

/**
 * Assemble a `RenderReviewV3Input` from a run directory. Pure apart from the reads,
 * and exported so the composition can be asserted without writing a report.
 */
export function readReviewRunInput(args: ReviewRunArgs): { input: RenderReviewV3Input; stats: Omit<ReviewRunResult, "report" | "fallback"> } {
  const dir = args.runDir ?? defaultRunDir(args.runId, args.cwd);
  if (!existsSync(dir)) throw new Error(`run-review: run directory not found: '${dir}'`);
  const { data } = readRunInput(dir);

  const criteria = asArray<MatrixCriterion>(data.criteria);
  if (criteria === null || criteria.length === 0)
    throw new Error(`run-review: the run-input in '${dir}' carries no criteria array — the review surface has nothing to show rows for.`);

  const files = readVerdictFiles(dir);
  // the full run-input holds real trajectories; the lean one holds a placeholder
  // STRING, which must read as absent rather than be coerced into a trace list.
  const ingested = asArray<IngestedTrace>(data.trajectories) ?? [];
  const ingestedIds = new Set(ingested.map((t) => t.id));
  const judgedIds = new Set(files.map((f) => f.trajectoryId));
  const unjoined = [...judgedIds].filter((id) => !ingestedIds.has(id));

  // NAMED scope: an ingested-but-unjudged trajectory is declared, never dropped.
  const notes: string[] = [];
  if (ingested.length > 0 && judgedIds.size < ingested.length)
    notes.push(`${judgedIds.size} of ${ingested.length} ingested trajectories carry a judge verdict; the rest are not shown`);
  if (ingested.length === 0)
    notes.push("the run-input carried no trajectory array, so the drill shows the judge's own step record rather than raw tool I/O");
  if (unjoined.length > 0)
    notes.push(`${unjoined.length} verdict file(s) reference a trajectory absent from the run-input (${unjoined.join(", ")})`);
  if (args.scopeNote !== undefined) notes.push(args.scopeNote);

  const input: RenderReviewV3Input = {
    subjectName: data.subject?.name ?? args.runId,
    runId: args.runId,
    audience: args.audience ?? "internal",
    criteria,
    files,
    ...(ingested.length > 0 ? { traces: ingested } : {}),
    ...(data.subjectProfile !== undefined && typeof data.subjectProfile === "object" && data.subjectProfile !== null
      ? { subjectProfile: data.subjectProfile as Record<string, unknown> }
      : {}),
    pin: { model: data.pin?.model ?? "(judge model not recorded in the run-input)", temperature: 0 },
    ...(data.producedAt !== undefined ? { generatedAt: data.producedAt } : {}),
    ...(args.suiteVersion !== undefined ? { suiteVersion: args.suiteVersion } : {}),
    ...(notes.length > 0 ? { scopeNote: notes.join(" · ") } : {}),
    ...(args.devFeedback !== undefined ? { devFeedback: args.devFeedback } : {}),
  };

  return {
    input,
    stats: {
      runId: args.runId,
      trajectoriesIngested: ingested.length,
      trajectoriesJudged: judgedIds.size,
      verdicts: files.reduce((a, f) => a + f.verdicts.length, 0),
      criteria: criteria.length,
      unjoinedTrajectoryIds: unjoined,
    },
  };
}

/**
 * THE COMPOSER — read a run directory and write `review-report.html` (plus the v1
 * `review-report.v2.html` fallback when the run carries ingested traces the v1 UI
 * can consume). Returns the paths and what was actually composed.
 */
export function writeReviewRunReport(args: ReviewRunArgs): ReviewRunResult {
  const { input, stats } = readReviewRunInput(args);
  const repoRoot = args.cwd ?? process.cwd();
  // the v1 annotation UI consumes EvalTrace[]; the ingested trajectories ARE that
  // shape in a persisted run-input. Absent ⇒ no fallback is written and the result
  // says so with `fallback: null`, rather than an empty file pretending to be one.
  const evalTraces = (input.traces ?? []) as unknown as EvalTrace[];
  const { report, fallback } = writeReviewRunReportV3(input, repoRoot, evalTraces.length > 0 ? evalTraces : undefined);
  return { ...stats, report, fallback };
}

/** Render without writing — for tests and for callers that want the HTML in hand. */
export function renderReviewRunReport(args: ReviewRunArgs): string {
  return renderReviewReportV3(readReviewRunInput(args).input);
}

/* ── CLI entrypoint ────────────────────────────────────────────────────────────
 *
 *   bun scripts/run-review.ts <runId> [--cwd <repoRoot>] [--run-dir <dir>]
 *                                     [--suite <version>] [--dev-feedback]
 *
 * This is the production caller the `*review` command's parent Bash invokes, mirroring
 * build-review-ui.ts's CLI. Costs nothing: it reads artifacts an `*evaluate` run has
 * already produced and dispatches no judge.
 */
declare const Bun: { argv: string[] } | undefined;

function parseArgv(argv: string[]): ReviewRunArgs | null {
  const [runId] = argv;
  if (runId === undefined || runId.startsWith("--")) return null;
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = flag("cwd");
  const rd = flag("run-dir");
  const suite = flag("suite");
  return {
    runId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(rd !== undefined ? { runDir: rd } : {}),
    ...(suite !== undefined ? { suiteVersion: suite } : {}),
    ...(argv.includes("--dev-feedback") ? { devFeedback: true } : {}),
  };
}

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const args = parseArgv(argv);
  if (args === null) {
    console.error("usage: run-review.ts <runId> [--cwd <repoRoot>] [--run-dir <dir>] [--suite <version>] [--dev-feedback]");
    process.exit(2);
    return;
  }
  const r = writeReviewRunReport(args);
  console.info(
    `review report written: ${r.report}\n` +
      `  ${r.trajectoriesJudged}/${r.trajectoriesIngested || r.trajectoriesJudged} trajectories judged · ` +
      `${r.verdicts} judge verdicts · ${r.criteria} criteria` +
      (r.fallback !== null ? `\n  v1 fallback: ${r.fallback}` : "\n  v1 fallback: not written (the run carries no ingested traces)") +
      (r.unjoinedTrajectoryIds.length > 0 ? `\n  WARNING: ${r.unjoinedTrajectoryIds.length} verdict(s) reference an unknown trajectory` : ""),
  );
  process.exit(0);
}

if (typeof Bun !== "undefined" && Bun.argv[1]?.endsWith("run-review.ts") === true) {
  await main();
}
