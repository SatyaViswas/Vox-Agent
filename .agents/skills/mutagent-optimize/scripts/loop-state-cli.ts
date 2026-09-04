/**
 * scripts/loop-state-cli.ts — the ONE-SHOT decision CLI for the optimize loop.
 * ---------------------------------------------------------------------------
 * WHY: the interactive `*optimize` loop is conducted by the TOP-LEVEL SESSION
 * (only the session can Task-dispatch sub-agents; a sub-agent cannot). The session
 * is an AGENT, not a TS program — it cannot `import` the pure decision functions
 * in `loop-state.ts`. This CLI EXPOSES those functions one-shot so the conducting
 * session can call them BETWEEN Task dispatches (write loop-state.json → shell this
 * CLI to decide terminator / next phase / improvement → act on the printed result).
 *
 * It is PURE: reads state/config from JSON files + flags, prints a machine-readable
 * result, no clock / no network. `budget-ms` (elapsed wall time) is INJECTED by the
 * conductor. Mirrors the diagnostics `orchestrator-protocol` inline model: the
 * session conducts; deterministic decisions are shelled to a script.
 *
 *   bun run scripts/loop-state-cli.ts <command> [args]
 *     init
 *     assert-goal-legal   <config.json> [--subject-kind <agent|skill|multiAgent|workflow>] [--artifact-format <code|markdown|platform-config>]
 *     parse-goal          <raw>                                   # "<free text>" | eval-pass | criterion:<id> | delta:<n> | code-quality → Goal JSON
 *     freeze-goal         <config.json> --criterion <id> [--criterion <id> …]   # freeze a natural-language goal → a criterion SET (repeat --criterion, or a comma list "a,b") → updated config JSON
 *     record-iteration    <state.json> <config.json> --verify <PROCEED|STEER|ABORT> --gate <PASS|FAIL> --score <n> --variance-regressed <true|false> --budget-ms <n> [--tests-green <true|false>]
 *     check-terminators   <state.json> <config.json> --last-verify <PROCEED|STEER|ABORT> [--criteria a,b]
 *     next-phase          <phase> [--verify <..>] [--gate <..>]
 *     is-improvement      --delta <n> --noise-floor <n> --variance-regressed <true|false>
 *     goal-met            <config.json> <record.json> [--criteria a,b]
 *     accept-amend        <input.json> --dialect <eval|diagnostics|amend> [--subject <s>] [--brief]
 */

import { readFileSync } from "node:fs";

import {
  assertArtifactFormat,
  assertGoalAllowedForArtifact,
  assertGoalLegal,
  assertSubjectKind,
  checkTerminators,
  freezeNlGoal,
  goalMet,
  initLoopState,
  isImprovement,
  nextPhase,
  parseGoal,
  recordIteration,
} from "./loop-state.ts";
import type {
  ArchitectVerdictValue,
  GateVerdictValue,
  IterationRecord,
  LoopConfig,
  LoopPhaseValue,
  LoopState,
} from "./loop-state.ts";
import {
  amendToBuildRemedy,
  eddChangeRequestToAmend,
  remedyToAmend,
  validateAmendRequest,
} from "./contracts/amend-request.ts";
import type { AmendRequest, EddChangeRequestLike, RemedyLike } from "./contracts/amend-request.ts";

export interface CliResult {
  out: string;
  code: number;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
  /**
   * All occurrences of each flag, in order — so a REPEATED flag (e.g. `--criterion a
   * --criterion b`) is not lost to last-wins. `flags` keeps its last-wins string for the
   * single-value callers; `lists` is the additive multi-value view (used by freeze-goal).
   */
  lists: Record<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let value: string;
      if (next === undefined || next.startsWith("--")) {
        value = "true";
      } else {
        value = next;
        i++;
      }
      flags[key] = value;
      (lists[key] ??= []).push(value);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, lists };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/**
 * Revive a LoopState read from JSON. `bestScore`'s "no kept iteration yet" sentinel
 * is `Number.NEGATIVE_INFINITY`, which `JSON.stringify` writes as `null`; restore it
 * so recordIteration's first-turn detection holds across the JSON round-trip. Pure
 * boundary fix — loop-state.ts is unchanged.
 */
function readState(path: string): LoopState {
  const raw = readJson<LoopState & { bestScore: number | null }>(path);
  return { ...raw, bestScore: raw.bestScore === null ? Number.NEGATIVE_INFINITY : raw.bestScore };
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (v === undefined) throw new Error(`missing required flag --${key}`);
  return v;
}

function requirePositional(pos: string[], i: number, name: string): string {
  const v = pos[i];
  if (v === undefined) throw new Error(`missing required argument <${name}>`);
  return v;
}

function parseCriteria(flags: Record<string, string>): Set<string> {
  const raw = flags["criteria"];
  return new Set(raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : []);
}

const USAGE = [
  "loop-state-cli — one-shot decisions for the optimize loop (the conducting session shells this)",
  "commands: init · assert-goal-legal · parse-goal · freeze-goal · record-iteration · check-terminators · next-phase · is-improvement · goal-met · accept-amend",
  "see the file header for exact args.",
].join("\n");

/**
 * Run one CLI invocation. PURE w.r.t. the process: returns { out, code } instead
 * of writing/exiting, so tests call it directly. The import.meta.main shell prints
 * + exits with the result.
 */
export function runLoopStateCli(argv: string[]): CliResult {
  const [command, ...rest] = argv;
  const { positionals, flags, lists } = parseArgs(rest);

  try {
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        return { out: USAGE, code: command === undefined ? 1 : 0 };

      case "init":
        return { out: JSON.stringify(initLoopState()), code: 0 };

      case "assert-goal-legal": {
        const config = readJson<LoopConfig>(requirePositional(positionals, 0, "config.json"));
        try {
          assertGoalLegal(config);
          // `--subject-kind` (role axis, S15/FU-69): VALIDATE only. The role no longer gates any
          // goal (code-quality moved to the substrate axis). assertSubjectKind still rejects a
          // bogus value LOUD (fail-closed) so an invalid `--subject-kind` never slips past.
          const subjectKind = flags["subject-kind"];
          if (subjectKind !== undefined) assertSubjectKind(subjectKind);
          // `--artifact-format` (substrate axis) is where code-quality legality lives now: validate
          // the raw flag, then enforce the goal is applicable (a `code-quality` goal is illegal
          // unless artifact.format === "code"). Folds into the SAME entry gate the session calls.
          const artifactFormat = flags["artifact-format"];
          if (artifactFormat !== undefined) {
            assertArtifactFormat(artifactFormat);
            assertGoalAllowedForArtifact(config.goal, artifactFormat);
          }
          return { out: "ok — goal-legal (observable goal + hard terminators + scope)", code: 0 };
        } catch (e) {
          return { out: `ILLEGAL: ${e instanceof Error ? e.message : String(e)}`, code: 1 };
        }
      }

      case "parse-goal": {
        // Parse the `--goal` arg into a Goal (Wave-2 W2I10). Free text → an UNRESOLVED
        // natural-language goal (illegal until frozen); structured shapes → their kind.
        const raw = requirePositional(positionals, 0, "raw-goal");
        return { out: JSON.stringify(parseGoal(raw)), code: 0 };
      }

      case "freeze-goal": {
        // Freeze a natural-language goal to a concrete criterion SET (Wave-2 W2I10; OT-4) —
        // the session INTERPRETS + CONFIRMS the free text (agent reasoning at entry), then
        // shells this pure transform to record the frozen decision on the config, making it
        // goal-legal. A real NL goal usually decomposes into MULTIPLE binary criteria, so
        // this accepts repeated `--criterion` flags AND a comma list ("a,b"); freezeNlGoal
        // splits + trims. Prints the UPDATED config JSON (overwrite config.json with it).
        const config = readJson<LoopConfig>(requirePositional(positionals, 0, "config.json"));
        const criterionIds = lists["criterion"];
        if (criterionIds === undefined) throw new Error("missing required flag --criterion");
        const frozen = freezeNlGoal(config.goal, criterionIds);
        return { out: JSON.stringify({ ...config, goal: frozen }), code: 0 };
      }

      case "record-iteration": {
        const state = readState(requirePositional(positionals, 0, "state.json"));
        const config = readJson<LoopConfig>(requirePositional(positionals, 1, "config.json"));
        const next = recordIteration(state, config, {
          verify: requireFlag(flags, "verify") as ArchitectVerdictValue,
          gate: requireFlag(flags, "gate") as GateVerdictValue,
          score: Number(requireFlag(flags, "score")),
          varianceRegressed: requireFlag(flags, "variance-regressed") === "true",
          budgetSpentMs: Number(requireFlag(flags, "budget-ms")),
          // CODE-TARGET (Wave-2 W2I1) — OPTIONAL. Present only when the session
          // conducts a `code` subject round: it records the deterministic
          // test-suite gate so the `code-quality` goal's BOTH-gate can AND it with
          // the quality verdict. Absent ⇒ undefined (non-code turn, unchanged).
          ...(flags["tests-green"] === undefined
            ? {}
            : { testsGreen: flags["tests-green"] === "true" }),
        });
        return { out: JSON.stringify(next), code: 0 };
      }

      case "check-terminators": {
        const state = readState(requirePositional(positionals, 0, "state.json"));
        const config = readJson<LoopConfig>(requirePositional(positionals, 1, "config.json"));
        const term = checkTerminators(
          state,
          config,
          requireFlag(flags, "last-verify") as ArchitectVerdictValue,
          parseCriteria(flags),
        );
        // A stop-reason exits NON-ZERO so a shell `if` can branch; "continue" is exit 0.
        return term === null ? { out: "continue", code: 0 } : { out: term, code: 3 };
      }

      case "next-phase": {
        const phase = requirePositional(positionals, 0, "phase") as LoopPhaseValue;
        const next = nextPhase(
          phase,
          flags["verify"] as ArchitectVerdictValue | undefined,
          flags["gate"] as GateVerdictValue | undefined,
        );
        return { out: next, code: 0 };
      }

      case "is-improvement": {
        const ok = isImprovement(
          Number(requireFlag(flags, "delta")),
          Number(requireFlag(flags, "noise-floor")),
          requireFlag(flags, "variance-regressed") === "true",
        );
        return { out: ok ? "true" : "false", code: ok ? 0 : 1 };
      }

      case "goal-met": {
        const config = readJson<LoopConfig>(requirePositional(positionals, 0, "config.json"));
        const rec = readJson<IterationRecord>(requirePositional(positionals, 1, "record.json"));
        const ok = goalMet(config.goal, rec, parseCriteria(flags));
        return { out: ok ? "true" : "false", code: ok ? 0 : 1 };
      }

      case "accept-amend": {
        // Wave-2 W2I2 (unify amend formats): the CONSUMER accept-gate. Reads either amend
        // dialect (or an already-unified amend) and normalizes to the ONE `AmendRequest`
        // superset the ⑤ OPTIMIZE S1 build handover reads. --brief prints the collapsed NL
        // build brief instead of the JSON (what the existing string seam consumes).
        const inputPath = requirePositional(positionals, 0, "input.json");
        const dialect = requireFlag(flags, "dialect");
        let amend: AmendRequest;
        if (dialect === "eval") {
          amend = eddChangeRequestToAmend(readJson<EddChangeRequestLike>(inputPath));
        } else if (dialect === "diagnostics") {
          const subject = requireFlag(flags, "subject");
          amend = remedyToAmend(readJson<RemedyLike>(inputPath), subject);
        } else if (dialect === "amend") {
          amend = validateAmendRequest(readJson<unknown>(inputPath));
        } else {
          return { out: `accept-amend: --dialect must be eval|diagnostics|amend (got "${dialect}")`, code: 2 };
        }
        // Belt-and-braces: the normalized amend must itself satisfy the accept-gate.
        validateAmendRequest(amend);
        if (flags["brief"] === "true") return { out: amendToBuildRemedy(amend), code: 0 };
        return { out: JSON.stringify(amend), code: 0 };
      }

      default:
        return { out: `unknown command '${command}'\n${USAGE}`, code: 2 };
    }
  } catch (e) {
    return { out: `ERROR: ${e instanceof Error ? e.message : String(e)}`, code: 2 };
  }
}

// ── CLI shell (the only impure edge) ──────────────────────────────────────────
if (import.meta.main) {
  const result = runLoopStateCli(process.argv.slice(2));
  if (result.code === 0 || result.code === 3) console.info(result.out);
  else console.error(result.out);
  process.exit(result.code);
}
