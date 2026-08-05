/**
 * scripts/cli/prep.ts — the PREP entrypoint for the agent-dispatch engine.
 * ---------------------------------------------------------------------------
 * Emits the task-spec files the parent session dispatches to eval-judge /
 * error-analyst subagents (references/workflows/orchestrator-protocol.md). This
 * is the I/O shell over the TESTED PREP cores (scripts/prep-tasks.ts); it calls
 * NO LLM and NO provider — it only writes the EXACT prompts to be judged on the
 * host runtime, keyed by content hash.
 *
 *   prep.ts --stage determiner --traces <handover.jsonl|.gz> --task-dir <dir> --model <pinned>
 *           [--profile <vocab.json|.yaml>]  # operator-supplied SubjectVocab (EV-049)
 *           [--source <name>]               # SELECTION override — pick a source by name
 *   prep.ts --stage judge      --traces <f> --criteria <criteria.json> \
 *           --verdict-dir <discover-verdicts> --task-dir <dir> --model <pinned>
 *
 * SOURCE SELECTION (--source): when `global.sources[]` has >1 entry and none is
 * `default:true`, the run-start config surfaces a `needs-selection` state; the
 * PARENT session then ASKS the operator to pick one (AskUserQuestion / chat
 * multi-choice) and re-invokes with `--source <name>`. When >1 entry has exactly
 * one `default:true`, the config surfaces `confirm-default` (F2) — the PARENT
 * CONFIRMS the preselected default (a yes/no ask; distinct from the open pick)
 * before it is used. A single source or an explicit `--source` skips the prompt.
 *
 * MODEL INTENT SACRED: --model is the pinned host model (temperature pinned 0,
 * C-PIN); it is carried verbatim on every task spec for the subagent to honor —
 * never swapped. The `judge` stage REQUIRES the determiner verdict files
 * (--verdict-dir) already collected (Stage A done) — see the protocol.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseUnitfJsonl } from "../read-unitf-traces.ts";
import { validateSiblingManifest } from "../read-manifest.ts";
import { prepDeterminerTasks, prepJudgeTasks } from "../prep-tasks.ts";
import { selectColdStartSuite, type ColdStartMeta } from "../cold-start-project.ts";
import { profileSubject } from "../profile-subject.ts";
import { deriveSubjectFrame } from "../subject-profile.ts";
import { loadProfileVocab } from "../load-profile-vocab.ts";
import { buildMatrixPacket, writeMatrixPacket, packetFileName } from "../matrix-judge.ts";
import { configPathFor, loadEvaluatorConfig, type SourceBinding } from "../config/load.ts";
import { readMemoryDir, renderRecallContext } from "../memory/read.ts";
import type { ContextLink } from "../config/schema.ts";
import type { JudgeTaskSpec, PinnedEnvelope } from "../agent-dispatch.ts";
import type { PipelineOptions } from "../run-pipeline.ts";
import type { DiscoveredCriterion } from "../contracts/eval-types.ts";
import type { MatrixCriterion } from "../contracts/eval-matrix.ts";
import { SubjectKind } from "../route-failures.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Surface the SELECTION contract's source-binding state so the PARENT session can
 * wire the run-start ASK. prep runs in a subagent-context I/O shell that CANNOT
 * invoke AskUserQuestion — so it prints the binding + candidate names; the parent
 * (which owns the ask mechanism: AskUserQuestion on Claude Code / chat multi-choice
 * elsewhere) does the actual PROMPT. `bound` (single · `default:true` · `--source`)
 * ⇒ silent, no prompt. `needs-selection` is NON-fatal for gating (the source EXISTS;
 * only DISCOVER needs a pick — code/dataset runs need no source at all).
 */
function surfaceSourceBinding(binding: SourceBinding): void {
  switch (binding.kind) {
    case "confirm-default": {
      // F2 — a preselected default among many: surface a CONFIRM ask (yes/no),
      // distinct from the open needs-selection pick. NON-fatal: the default is usable
      // as-is on accept / non-interactive / --source.
      const names = binding.sources.map((s) => s.name).join(", ");
      process.stdout.write(
        `prep: source CONFIRM-DEFAULT — ${binding.sources.length} sources, default is ` +
          `'${binding.source.name}'. PARENT: confirm the default via the platform ask ` +
          `mechanism (AskUserQuestion / chat multi-choice; '${binding.source.name}' PRESELECTED, ` +
          `operator may override), or accept it non-interactively (--source <name> / CI). ` +
          `Candidates: ${names}\n`,
      );
      break;
    }
    case "needs-selection": {
      const names = binding.sources.map((s) => s.name).join(", ");
      process.stdout.write(
        `prep: source SELECTION required — ${binding.sources.length} sources, none default. ` +
          `PARENT: ask the operator to pick one via the platform ask mechanism ` +
          `(AskUserQuestion / chat multi-choice), then re-run with --source <name>. ` +
          `Candidates: ${names}\n`,
      );
      break;
    }
    case "multiple-defaults": {
      const names = binding.sources.filter((s) => s.default === true).map((s) => s.name).join(", ");
      process.stderr.write(
        `prep: ambiguous config — >1 source marked default:true (${names}). ` +
          `Fix the config (exactly one default) or pass --source <name>.\n`,
      );
      break;
    }
    case "unknown-name":
      process.stderr.write(
        `prep: --source "${binding.name}" matched no source in global.sources[].\n`,
      );
      break;
    // `bound` (silent — nothing to ask) / `none` (no source; code/dataset runs are fine): no output.
    case "bound":
    case "none":
      break;
  }
}

/**
 * Config → flag precedence for the pinned judge model. The `--model` FLAG WINS;
 * the unified `.mutagent/config.yaml` (`global.models.{judge_model,default}`)
 * fills the gap. Model-intent-sacred: no silent swap — this only supplies a
 * DEFAULT when the operator gave no `--model`. Also reads AutoMemory + context
 * links at run start (additive; an absent config is a no-op). `--project-root`
 * (default cwd) locates the LOCAL `.mutagent/`. Returns the resolved model (or
 * undefined) + a compact run-start context banner (recall + context links).
 */
function resolveRunStartConfig(argv: string[]): {
  modelFromConfig: string | undefined;
  startContext: string;
} {
  const projectRoot = resolve(flag(argv, "project-root") ?? process.cwd());
  // SELECTION contract: `--source <name>` is the explicit run-time source override
  // (WINS over `default:true` / auto-bind); absent ⇒ default precedence.
  const selectSourceName = flag(argv, "source");
  const cfg = loadEvaluatorConfig(configPathFor(projectRoot), { selectSourceName });

  let modelFromConfig: string | undefined;
  const contextLinks: ContextLink[] = [];
  if (cfg.status === "migration-required") {
    // Fork B — surface the migration directive; do NOT parse the old shape.
    process.stderr.write(`prep: ${cfg.error}\n`);
  } else if (cfg.status === "ok") {
    if (cfg.config.judgeModel.kind === "resolved") modelFromConfig = cfg.config.judgeModel.model;
    // PHASE 4 — load global.context[] (every run) + lifecycle.evaluator.context[].
    contextLinks.push(...cfg.config.globalContext, ...cfg.config.evaluatorContext);
    // SELECTION — surface the source-binding state so the PARENT session can wire
    // the run-start ASK (prep is a subagent-context I/O shell — it cannot invoke
    // AskUserQuestion; it SURFACES the state + candidate names, the parent prompts).
    surfaceSourceBinding(cfg.config.source);
  }

  // PHASE 3 — read AutoMemory at run start, filtered to {evaluate, general}.
  const memory = readMemoryDir(join(projectRoot, ".mutagent", "memory"));
  const parts: string[] = [];
  const recall = renderRecallContext(memory.entries);
  if (recall !== "") parts.push(recall);
  if (contextLinks.length > 0) {
    parts.push(
      "Context links:\n" +
        contextLinks.map((c) => `- ${c.path} — ${c.what} (why: ${c.why}; when: ${c.when})`).join("\n"),
    );
  }
  return { modelFromConfig, startContext: parts.join("\n\n") };
}

/**
 * Load the handed-over UniTF trace file as text (`mutagent-cli trace fetch
 * --export` writes one `UnifiedTrace` record per line). `.gz` → gunzip | jq -c;
 * else read text. `parseUnitfJsonl` projects each UniTF record → EvalTrace. The
 * skill NEVER fetches — Helix runs `mutagent-cli trace fetch` before dispatch.
 */
function loadNdjson(file: string, limit?: number): string {
  const headN = limit !== undefined ? ` | head -n ${limit}` : "";
  if (file.endsWith(".gz")) {
    return execSync(`gunzip -c ${JSON.stringify(file)} | jq -c '.'${headN}`, {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
    });
  }
  const text = readFileSync(file, "utf8");
  if (limit === undefined) return text;
  return text.split("\n").slice(0, limit).join("\n");
}

/**
 * Write a manifest of emitted task keys → verdict files (what the parent must
 * dispatch + collect). When the determiner (cold discover) stage subsamples via
 * the cold-start sampler, its `coldStart` block rides along so a thin-negative
 * cold suite is surfaced to the parent as LOW-CONFIDENCE (the report metadata).
 */
function writeManifest(taskDir: string, specs: JudgeTaskSpec[], coldStart?: ColdStartMeta): void {
  const manifest = {
    count: specs.length,
    tasks: specs.map((s) => ({ key: s.key, unit: s.unit, taskFile: `${s.key}.task.json`, verdictFile: s.verdictFile })),
    ...(coldStart !== undefined ? { coldStart } : {}),
  };
  writeFileSync(join(taskDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stage = flag(argv, "stage");
  const tracesFile = flag(argv, "traces");
  const taskDir = flag(argv, "task-dir");
  const limit = flag(argv, "limit");

  // Config → flag precedence: --model WINS; the unified config supplies the
  // default (global.models.judge_model/default). Also reads AutoMemory + context
  // links at run start (additive — absent config/memory is a no-op).
  const { modelFromConfig, startContext } = resolveRunStartConfig(argv);
  const model = flag(argv, "model") ?? modelFromConfig;

  if (tracesFile === undefined || taskDir === undefined || model === undefined) {
    throw new Error(
      "prep: --traces <f>, --task-dir <dir> and a pinned model are required " +
        "(--model <pinned> OR global.models.judge_model/default in .mutagent/config.yaml)",
    );
  }
  if (startContext !== "") process.stdout.write(`prep: run-start context —\n${startContext}\n`);
  const pin: PinnedEnvelope = { model, temperature: 0 };
  const ndjson = loadNdjson(tracesFile, limit !== undefined ? Number.parseInt(limit, 10) : undefined);
  const { traces, skipped, emptyPromptTraceIds } = parseUnitfJsonl(ndjson);

  // EV-6 — read + validate the sibling TraceManifest (count/format/truncation) and
  // WARN on mismatch, the way diagnostics does (read-unitf.ts). The evaluator used
  // to read ONLY the JSONL, so a truncated/partial slice was judged as if complete.
  for (const w of validateSiblingManifest(tracesFile, traces.length)) {
    process.stderr.write(`prep: MANIFEST WARNING — ${w}\n`);
  }

  // INF-1 — never silently emit empty: surface any record whose prompt-bearing span
  // still projected an empty prompt (the Claude Code 21/21-blank class). Loud on
  // stderr so a projection miss can never pass unnoticed again.
  if (emptyPromptTraceIds.length > 0) {
    process.stderr.write(
      `prep: EMPTY-PROMPT WARNING — ${emptyPromptTraceIds.length}/${traces.length} trace(s) have a ` +
        `prompt-bearing span but projected an EMPTY input.prompt (a trace-read miss; the judge would ` +
        `score them blind). traceIds: ${emptyPromptTraceIds.slice(0, 10).join(", ")}` +
        `${emptyPromptTraceIds.length > 10 ? ", …" : ""}\n`,
    );
  }
  if (skipped > 0) {
    process.stderr.write(`prep: ${skipped} line(s) skipped (malformed / non-UniTF).\n`);
  }

  // DEFAULT *evaluate PREP — one eval-matrix packet per trajectory (the headline cell).
  if (stage === "matrix") {
    const criteriaFile = flag(argv, "criteria");
    if (criteriaFile === undefined) {
      throw new Error("prep --stage matrix: --criteria <matrix.json> is required");
    }
    const matrix = JSON.parse(readFileSync(criteriaFile, "utf8")) as MatrixCriterion[];
    const subjectName = traces[0]?.name ?? "unknown-subject";
    const ids = traces.map((trace) => writeMatrixPacket(taskDir, buildMatrixPacket(subjectName, trace, matrix, pin)));
    writeFileSync(
      join(taskDir, "manifest.json"),
      JSON.stringify({ count: ids.length, packets: ids.map((id) => ({ trajectoryId: id, packetFile: packetFileName(id) })) }, null, 2),
    );
    process.stdout.write(`prep: stage=matrix emitted ${ids.length} trajectory packet(s) → ${taskDir}\n`);
    return;
  }

  let specs: JudgeTaskSpec[];
  let coldStartMeta: ColdStartMeta | undefined;
  if (stage === "determiner") {
    // The determiner reads its subject vocab off the profile (EV-002 / EV-049).
    // The profiler auto-infers a best-effort vocab; the SEMANTIC fields it can't
    // infer (sendTool / recoveryTools / guardCounterAttr) stay empty → the engine
    // reports those signals as UNKNOWN (honest-null). An operator may supply them
    // via `--profile <f>` (JSON/YAML), which OVERLAYS the inferred-vocab base —
    // e.g. `{"sendTool":"sendMessage"}` for a sample subject — with NO subject
    // name hardcoded in the engine.
    const inferred = profileSubject(traces).vocab;
    const profileFile = flag(argv, "profile");
    const vocab =
      profileFile !== undefined ? loadProfileVocab(profileFile, inferred) : inferred;
    // EV-5.3 COLD-START SUBSAMPLE (the SAFE call site) — the determiner IS the cold
    // discover front-door: there is NO suite/judge yet, so we balance a ✓/✗ bootstrap
    // from mechanical labels FIRST, then hand the SELECTED traces to the untouched
    // `prepDeterminerTasks` (which still emits exactly one determiner task per
    // selected trace). `--cold-size` caps the suite; absent ⇒ the incoming trace
    // count, a PASS-THROUGH that only subsamples when an explicit cap is given (its
    // own ✓/✗ imbalance still flags low-confidence). Cold path ONLY — the warm
    // (suite-present) judge stage below NEVER touches the sampler.
    const coldSizeFlag = flag(argv, "cold-size");
    const coldSize = coldSizeFlag !== undefined ? Number.parseInt(coldSizeFlag, 10) : traces.length;
    const cold = selectColdStartSuite(traces, { size: coldSize });
    coldStartMeta = cold.meta;
    // EV-1 — the subject-aware determiner frame, derived from the FULL parsed batch
    // (NOT the cold subsample) via the SHARED `deriveSubjectFrame` so it is byte-
    // identical to what the Stage-B pipeline builds → the cross-stage determiner cache
    // lines up. subjectName mirrors run-pipeline's `subject.name` (traces[0].name).
    const determinerSubjectName = traces[0]?.name ?? "unknown-subject";
    const subjectFrame = deriveSubjectFrame(determinerSubjectName, traces);
    specs = prepDeterminerTasks(cold.selected, { dir: taskDir, pin, vocab, subject: subjectFrame });
  } else if (stage === "judge") {
    const criteriaFile = flag(argv, "criteria");
    const verdictDir = flag(argv, "verdict-dir");
    if (criteriaFile === undefined || verdictDir === undefined) {
      throw new Error("prep --stage judge: --criteria <f> and --verdict-dir <discover-verdicts> are required");
    }
    const criteria = JSON.parse(readFileSync(criteriaFile, "utf8")) as DiscoveredCriterion[];
    const subjectName = traces[0]?.name ?? "unknown-subject";
    const pipeline: PipelineOptions = {
      criteria,
      pin: { modelId: model, temperature: 0 },
      subject: { kind: SubjectKind.Agent, name: subjectName, path: `subjects/${subjectName}` },
      producedBy: "mutagent-evaluator/prep",
      producedAt: "1970-01-01T00:00:00Z", // PREP-only stamp — judge prompts don't depend on it
    };
    specs = await prepJudgeTasks(traces, { verdictDir, taskDir, pin, pipeline });
  } else {
    throw new Error("prep: --stage must be 'matrix' (default *evaluate), 'determiner', or 'judge'");
  }

  writeManifest(taskDir, specs, coldStartMeta);
  process.stdout.write(
    `prep: stage=${stage} emitted ${specs.length} task-spec(s) → ${taskDir} ` +
      `(unique by content key: ${new Set(specs.map((s) => s.key)).size})\n`,
  );
  if (coldStartMeta !== undefined) {
    process.stdout.write(
      `prep: cold-start suite ${coldStartMeta.selected}/${coldStartMeta.input} traces ` +
        `(✓${coldStartMeta.passCount} ✗${coldStartMeta.failCount}` +
        `${coldStartMeta.minBothHeld ? "" : ", MIN-BOTH BROKEN"})` +
        `${coldStartMeta.lowConfidence ? " — LOW-CONFIDENCE (thin negatives; re-balance after real verdicts)" : ""}\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`prep FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
