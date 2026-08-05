/**
 * scripts/normalize/read-unitf.ts
 * The STRANGLER entry point: read a handed-over UniTF JSONL (+ optional
 * `manifest.json`) and project it, via the adapter, into the skill's canonical
 * `TraceBody[]` / `TraceMetadata[]` / `EntityContext`.
 * Type A — Pure Script for the parse/project core; a thin `import.meta.main` file
 * transport mirrors the other normalizers (REQ-052).
 *
 * Replaces (additively, at read time) the whole `scripts/fetch/*` +
 * `scripts/normalize/platforms/*` fetch/normalize stack: after migration the
 * orchestrator reads `traces.jsonl` produced by `mutagent-cli` from the
 * HandoverBundle inputs[], instead of fetching + per-platform normalizing inside
 * the skill. See ../../../mutagent-tools/references/MIGRATION-diagnostics-evaluator.md
 * §2.2 (new ingestion entry point) + §4.2 (Helix drives the CLI pre-stage).
 *
 * Tolerance contract mirrors local-jsonl `normalizeLocalJsonlFileWithDrops`:
 * blank lines skipped; lines that fail JSON.parse OR are not UniTF-shaped are
 * COUNTED + SAMPLED (tolerant-but-visible) and NEVER abort the corpus. Manifest
 * validation surfaces WARNINGS (format / count / truncation) but never aborts a
 * partial export — matches the existing partial-load behavior.
 */

import type { EntityContext, TraceBody, TraceMetadata } from "./trace.ts";
import type { UnifiedTrace, UnitfTraceManifest } from "./unitf-types.ts";
import { UNITF_MANIFEST_FORMAT, isUnifiedTraceLike } from "./unitf-types.ts";
import {
  projectUniTFEntityContext,
  projectUniTFToTraceBody,
} from "./unitf-adapter.ts";

/** Default number of raw bad-line samples retained for operator triage. */
export const DEFAULT_UNITF_DROPPED_SAMPLE_LIMIT = 5;

/** Tolerant-but-visible parse of a UniTF JSONL string. Deterministic. */
export interface UniTFParseResult {
  traces: UnifiedTrace[];
  /** Lines dropped: failed JSON.parse OR parsed-but-not-a-UniTF-record. */
  droppedLineCount: number;
  /** First-N raw dropped lines (verbatim), capped at the sample limit. */
  droppedSamples: string[];
}

/**
 * Parse a UniTF JSONL string into `UnifiedTrace[]` with VISIBLE drops. One record
 * per line (NDJSON). Blank lines are skipped and NOT counted as drops. A line that
 * parses as JSON but fails the structural `isUnifiedTraceLike` guard is counted as
 * a drop (so a stray non-UniTF record never reaches the projection).
 */
export function parseUniTFJsonl(
  content: string,
  sampleLimit: number = DEFAULT_UNITF_DROPPED_SAMPLE_LIMIT,
): UniTFParseResult {
  const traces: UnifiedTrace[] = [];
  let droppedLineCount = 0;
  const droppedSamples: string[] = [];

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      droppedLineCount += 1;
      if (droppedSamples.length < sampleLimit) droppedSamples.push(line);
      continue;
    }
    if (isUnifiedTraceLike(parsed)) {
      traces.push(parsed);
    } else {
      droppedLineCount += 1;
      if (droppedSamples.length < sampleLimit) droppedSamples.push(line);
    }
  }

  return { traces, droppedLineCount, droppedSamples };
}

/**
 * Validate a parsed manifest against the parsed trace count. Returns WARNINGS
 * (never throws, never aborts). Empty array = clean. Mirrors the migration's
 * "surface warnings but do NOT abort a partial export" rule.
 */
export function validateUniTFManifest(
  manifest: UnitfTraceManifest | undefined,
  actualTraceCount: number,
): string[] {
  const warnings: string[] = [];
  if (!manifest) return warnings;
  if (manifest.format !== undefined && manifest.format !== UNITF_MANIFEST_FORMAT) {
    warnings.push(
      `manifest.format is "${manifest.format}" — expected "${UNITF_MANIFEST_FORMAT}"`,
    );
  }
  if (manifest.count !== undefined && manifest.count !== actualTraceCount) {
    warnings.push(
      `manifest.count (${manifest.count}) != parsed trace count (${actualTraceCount})`,
    );
  }
  if (manifest.truncated === true) {
    warnings.push(
      `export is truncated${manifest.truncationReason ? ` (${manifest.truncationReason})` : ""} — diagnosing a partial slice`,
    );
  }
  if (manifest.warnings) warnings.push(...manifest.warnings);
  return warnings;
}

/** Full result of reading a handed-over UniTF export. */
export interface UniTFReadResult {
  /** One projected TraceBody per UniTF record (RCA input). */
  bodies: TraceBody[];
  /** Convenience: the metadata list (== bodies.map(b => b.metadata)). */
  metadata: TraceMetadata[];
  /** Entity context projected from the batch (ext.agent overlay). */
  entity: EntityContext;
  /** Count of successfully-projected records. */
  traceCount: number;
  /** Dropped-line accounting (thread into RunMeta.partial_loads). */
  droppedLineCount: number;
  droppedSamples: string[];
  /** Manifest warnings (format / count / truncation) — non-fatal. */
  manifestWarnings: string[];
}

/**
 * Pure core: project a UniTF JSONL string (+ optional manifest JSON string) into
 * the diagnostics ingestion shapes. No I/O — testable without a filesystem.
 */
export function readUniTFHandoverFromStrings(
  jsonlContent: string,
  manifestContent?: string,
  opts?: { source?: string; fallbackName?: string },
): UniTFReadResult {
  const { traces, droppedLineCount, droppedSamples } = parseUniTFJsonl(jsonlContent);

  let manifest: UnitfTraceManifest | undefined;
  if (manifestContent && manifestContent.trim()) {
    try {
      manifest = JSON.parse(manifestContent) as UnitfTraceManifest;
    } catch {
      manifest = undefined; // unreadable manifest is non-fatal (warn below via count)
    }
  }
  const manifestWarnings = validateUniTFManifest(manifest, traces.length);
  if (manifestContent && manifestContent.trim() && !manifest) {
    manifestWarnings.push("manifest.json failed to parse — proceeding without it");
  }

  const bodies = traces.map(projectUniTFToTraceBody);
  const entity = projectUniTFEntityContext(traces, opts);

  return {
    bodies,
    metadata: bodies.map((b) => b.metadata),
    entity,
    traceCount: traces.length,
    droppedLineCount,
    droppedSamples,
    manifestWarnings,
  };
}

/**
 * Read a handed-over UniTF export from disk (the HandoverBundle inputs[] paths)
 * and project it. `manifestPath` is optional — when present its warnings are
 * surfaced but never abort. Deterministic given identical file contents.
 */
export async function readUniTFHandover(args: {
  jsonlPath: string;
  manifestPath?: string;
  source?: string;
  fallbackName?: string;
}): Promise<UniTFReadResult> {
  const { readFileSync } = await import("fs");
  const jsonlContent = readFileSync(args.jsonlPath, "utf8");
  const manifestContent = args.manifestPath
    ? readFileSync(args.manifestPath, "utf8")
    : undefined;
  return readUniTFHandoverFromStrings(jsonlContent, manifestContent, {
    ...(args.source ? { source: args.source } : {}),
    ...(args.fallbackName ? { fallbackName: args.fallbackName } : {}),
  });
}

// ── PATH B: the arriving JUDGMENT (`HandoverBundle.acceptance`) ───────────────
//
// TWO intake paths reach this module. Both hand over the SAME trace package; only
// one of them also hands over a judgment:
//
//   PATH A  discovery → diagnostics.  A trace package ONLY, no judgment.
//           Diagnostics analyses from zero. UNCHANGED — absent `acceptance` the
//           behaviour here is byte-identical to the pre-PATH-B reader.
//   PATH B  discovery → evaluator → diagnostics.  The same trace package carried
//           forward PLUS the evaluator's EV-051 judgment (`acceptance`). The
//           traces are STILL what diagnostics reads from; the judgment only says
//           WHERE TO LOOK FIRST.
//
// ⛔ PR-035 / R2.1 — A JUDGMENT IS A FOCUS, NEVER A SUBSTITUTE FOR THE DEEP READ.
//    An arriving judgment contributes ZERO LLM deep-reads and NEVER yields a
//    `priorSignalsRef`. `scripts/sample/deep-read-gate.ts` still HARD-REFUSES a
//    fresh run with `llmReadCount === 0 && !priorSignalsRef`, and a populated
//    `acceptance` does not move that verdict by one byte. If a judgment could
//    stand in for the deep read we would have built a shortcut that makes
//    diagnostics WORSE at root-causing than it is today: the evaluator states
//    WHAT failed from the outside — only a deep read can establish WHY. That is
//    why `DiagnosisFocus` below deliberately carries NO read-count field and NO
//    prior-signals field: there is nothing on it that the gate could consume.
//    See `evaluateDeepReadGate`'s `hasArrivingJudgment` input, which exists
//    precisely so that "a judgment arrived" is recorded WITHOUT changing the
//    verdict.
//
// The bundle shape is the FROZEN, closed `HandoverBundle` (v0.1.0) the evaluator
// emits at `mutagent-evaluator/.../scripts/route-failures.ts`. It is read
// TOLERANTLY here (sealed-sibling: mirrored by shape, never imported across the
// package boundary) — a partial/malformed bundle is REPORTED via `warnings[]`,
// never silently swallowed and never allowed to abort a usable trace package.

/** `inputs[]` id of the UniTF JSONL (`kind:"trace"`). */
export const HANDOVER_TRACE_LIST_ID = "trace-list";
/** `inputs[]` id of the optional trace manifest (`kind:"config"`). */
export const HANDOVER_TRACE_MANIFEST_ID = "trace-manifest";

/**
 * The EV-051 emit shape of one `acceptance.criteria` line:
 *   `<criterionId> [<severity>/<flag>] FAILED on trace <traceId>: <critique>`
 * A line that does NOT match is retained verbatim with `parsed:false` + a warning
 * — it is never dropped.
 */
const FOCUS_CRITERION_RE =
  /^(\S+)\s+\[([^\]/]+)\/([^\]]+)\]\s+FAILED on trace\s+(\S+):\s?([\s\S]*)$/;

/** One line of the arriving judgment. `raw` is ALWAYS the verbatim source line. */
export interface FocusCriterion {
  raw: string;
  /** True iff `raw` matched the EV-051 emit shape. */
  parsed: boolean;
  criterionId?: string;
  severity?: string;
  flag?: string;
  traceId?: string;
  critique?: string;
}

/**
 * The arriving judgment, structured for use as a FOCUS.
 *
 * Deliberately absent (PR-035): any read-count, any `priorSignalsRef`, any
 * "evidence" field. Nothing here can satisfy the deep-read gate.
 */
export interface DiagnosisFocus {
  /** `acceptance.goal` verbatim. */
  goal: string;
  /** Every `acceptance.criteria` line, parsed where possible, never dropped. */
  criteria: FocusCriterion[];
  /** De-duped first-seen-order criterion ids the evaluator flagged. */
  criterionIds: string[];
  /** De-duped first-seen-order trace ids to look at FIRST (not: to look at ONLY). */
  focusTraceIds: string[];
  /** Deterministic one-liner suitable for `analyzer_dispatch.scope.focus`. */
  focusLine: string;
  /** Shape problems found while extracting. Surfaced, never swallowed. */
  warnings: string[];
}

export interface FocusExtraction {
  /** Present iff the bundle carried ≥1 acceptance criteria line (PATH B). */
  focus?: DiagnosisFocus;
  /** Shape problems. Empty on PATH A (absent acceptance is legal, not a warning). */
  warnings: string[];
}

function dedupeInOrder(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Extract the judgment out of a `HandoverBundle.acceptance` block.
 *
 * PATH A (no judgment) is the SILENT case: `undefined`/`null` acceptance, or an
 * `acceptance` with an empty `criteria[]` (the evaluator routed zero failures,
 * or the bundle came straight from discovery), returns no focus and NO warning —
 * that is a legal, expected handover, not a defect.
 *
 * Everything else that is malformed produces a warning. Pure + deterministic.
 */
export function extractDiagnosisFocus(acceptance: unknown): FocusExtraction {
  const warnings: string[] = [];

  if (acceptance === undefined || acceptance === null) return { warnings };

  if (typeof acceptance !== "object" || Array.isArray(acceptance)) {
    warnings.push(
      `acceptance is not an object (got ${Array.isArray(acceptance) ? "array" : typeof acceptance}) — no focus extracted`,
    );
    return { warnings };
  }

  const block = acceptance as Record<string, unknown>;

  let goal = "";
  if (typeof block.goal === "string" && block.goal.trim().length > 0) {
    goal = block.goal;
  } else if (block.goal !== undefined) {
    warnings.push("acceptance.goal is present but not a non-empty string");
  } else {
    warnings.push("acceptance.goal is absent (the frozen contract requires it)");
  }

  const rawCriteria = block.criteria;
  if (rawCriteria === undefined) {
    warnings.push("acceptance.criteria is absent — no focus extracted");
    return { warnings };
  }
  if (!Array.isArray(rawCriteria)) {
    warnings.push(
      `acceptance.criteria is not an array (got ${typeof rawCriteria}) — no focus extracted`,
    );
    return { warnings };
  }
  // Empty criteria === "nothing failed / nothing routed". PATH-A-equivalent, silent.
  if (rawCriteria.length === 0) return { warnings };

  const criteria: FocusCriterion[] = [];
  rawCriteria.forEach((entry, i) => {
    if (typeof entry !== "string") {
      warnings.push(`acceptance.criteria[${i}] is not a string (got ${typeof entry}) — skipped`);
      return;
    }
    const line = entry.trim();
    if (line.length === 0) {
      warnings.push(`acceptance.criteria[${i}] is blank — skipped`);
      return;
    }
    const m = FOCUS_CRITERION_RE.exec(line);
    if (!m) {
      warnings.push(
        `acceptance.criteria[${i}] does not match the EV-051 emit shape ` +
          `"<criterionId> [<severity>/<flag>] FAILED on trace <traceId>: <critique>" — ` +
          `retained verbatim, unparsed`,
      );
      criteria.push({ raw: entry, parsed: false });
      return;
    }
    criteria.push({
      raw: entry,
      parsed: true,
      criterionId: m[1],
      severity: m[2],
      flag: m[3],
      traceId: m[4],
      critique: m[5],
    });
  });

  if (criteria.length === 0) return { warnings };

  const criterionIds = dedupeInOrder(criteria.map((c) => c.criterionId));
  const focusTraceIds = dedupeInOrder(criteria.map((c) => c.traceId));
  const unparsedCount = criteria.filter((c) => !c.parsed).length;
  const focusLine =
    `EVAL-ROUTED FOCUS — ${criteria.length} failed criteria` +
    (unparsedCount > 0 ? ` (${unparsedCount} unparsed)` : "") +
    (criterionIds.length > 0 ? ` (${criterionIds.join(", ")})` : "") +
    (focusTraceIds.length > 0 ? ` on trace(s) ${focusTraceIds.join(", ")}` : "") +
    ". Look here FIRST; the deep read is still mandatory (PR-035).";

  return {
    focus: { goal, criteria, criterionIds, focusTraceIds, focusLine, warnings },
    warnings,
  };
}

/** What a `handover.json` yields to the diagnostics run. */
export interface HandoverIntake {
  /** `inputs[trace-list].path` — the UniTF JSONL. VERBATIM from the bundle. */
  traceListPath?: string;
  /** `inputs[trace-manifest].path` — optional. VERBATIM from the bundle. */
  traceManifestPath?: string;
  /** PATH B only. Absent on PATH A. */
  focus?: DiagnosisFocus;
  /** Bundle-level + acceptance-level problems. Never silently swallowed. */
  warnings: string[];
  /** Best-effort echo for the run log. */
  bundleVersion?: string;
  adlStage?: string;
  subjectName?: string;
}

/**
 * Pure core: read a `handover.json` string into the trace-package locators + the
 * (optional) judgment. Paths are returned VERBATIM — the on-disk wrapper resolves
 * them relative to the bundle.
 *
 * FAIL-LOUD on an unreadable envelope (not valid JSON / not an object): the caller
 * explicitly pointed at a handover, so there is nothing to degrade to. Everything
 * INSIDE a readable envelope degrades to `warnings[]` so a partial bundle still
 * lets a usable trace package through.
 */
export function readHandoverBundleFromString(content: string): HandoverIntake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`handover.json is not valid JSON: ${String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `handover.json must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }

  const bundle = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const bundleVersion = typeof bundle.bundle_version === "string" ? bundle.bundle_version : undefined;
  const adlStage = typeof bundle.adl_stage === "string" ? bundle.adl_stage : undefined;
  if (!bundleVersion) warnings.push("handover.bundle_version is absent or not a string");
  if (adlStage !== undefined && adlStage !== "diagnose") {
    warnings.push(`handover.adl_stage is "${adlStage}" — expected "diagnose"`);
  }

  let subjectName: string | undefined;
  const subject = bundle.subject;
  if (typeof subject === "object" && subject !== null && !Array.isArray(subject)) {
    const name = (subject as Record<string, unknown>).name;
    if (typeof name === "string") subjectName = name;
  }

  let traceListPath: string | undefined;
  let traceManifestPath: string | undefined;
  const inputs = bundle.inputs;
  if (inputs === undefined) {
    warnings.push("handover.inputs[] is absent — no trace package located in the bundle");
  } else if (!Array.isArray(inputs)) {
    warnings.push(`handover.inputs is not an array (got ${typeof inputs}) — no trace package located`);
  } else {
    const refs = inputs.filter(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && !Array.isArray(e),
    );
    if (refs.length !== inputs.length) {
      warnings.push(`handover.inputs[] contains ${inputs.length - refs.length} non-object entr(ies) — skipped`);
    }

    const locator = (ref: Record<string, unknown>, id: string): string | undefined => {
      const path = ref.path;
      if (typeof path === "string" && path.length > 0) return path;
      const uri = ref.uri;
      if (typeof uri === "string" && uri.length > 0) {
        warnings.push(`handover.inputs '${id}' has a uri but no path — diagnostics reads from disk`);
        return undefined;
      }
      warnings.push(`handover.inputs '${id}' has neither path nor uri`);
      return undefined;
    };

    const byId = (id: string): Record<string, unknown> | undefined =>
      refs.find((r) => r.id === id);

    const traceRef =
      byId(HANDOVER_TRACE_LIST_ID) ??
      (() => {
        const fallback = refs.find((r) => r.kind === "trace");
        if (fallback) {
          warnings.push(
            `handover.inputs has no '${HANDOVER_TRACE_LIST_ID}' entry — falling back to the first kind:"trace" ref ('${String(fallback.id)}')`,
          );
        }
        return fallback;
      })();
    if (!traceRef) {
      warnings.push(`handover.inputs has no '${HANDOVER_TRACE_LIST_ID}' (kind:"trace") entry`);
    } else {
      traceListPath = locator(traceRef, HANDOVER_TRACE_LIST_ID);
    }

    // The manifest is matched by id ONLY — kind:"config" is also used for other
    // payloads (e.g. discovery's TraceQuery), so a kind-based fallback would
    // silently hand the reader the wrong file.
    const manifestRef = byId(HANDOVER_TRACE_MANIFEST_ID);
    if (manifestRef) traceManifestPath = locator(manifestRef, HANDOVER_TRACE_MANIFEST_ID);
  }

  const extraction = extractDiagnosisFocus(bundle.acceptance);
  warnings.push(...extraction.warnings);

  return {
    ...(traceListPath ? { traceListPath } : {}),
    ...(traceManifestPath ? { traceManifestPath } : {}),
    ...(extraction.focus ? { focus: extraction.focus } : {}),
    warnings,
    ...(bundleVersion ? { bundleVersion } : {}),
    ...(adlStage ? { adlStage } : {}),
    ...(subjectName ? { subjectName } : {}),
  };
}

/**
 * Read a `handover.json` from disk. Relative `inputs[].path` values are resolved
 * against the bundle's own directory (the run dir), so the returned locators are
 * ready to hand to `readUniTFHandover`.
 */
export async function readHandoverBundle(args: {
  handoverPath: string;
}): Promise<HandoverIntake> {
  const { readFileSync } = await import("fs");
  const { dirname, isAbsolute, resolve } = await import("path");

  const handoverPath = resolve(args.handoverPath);
  const intake = readHandoverBundleFromString(readFileSync(handoverPath, "utf8"));
  const base = dirname(handoverPath);
  const rebase = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : isAbsolute(p) ? p : resolve(base, p);

  return {
    ...intake,
    ...(rebase(intake.traceListPath) ? { traceListPath: rebase(intake.traceListPath) } : {}),
    ...(rebase(intake.traceManifestPath)
      ? { traceManifestPath: rebase(intake.traceManifestPath) }
      : {}),
  };
}

// ── REQ-052: INTERNAL CLI transport ───────────────────────────────────────────
//
// Mirrors the local-jsonl file transport so the strangler entry point is runnable
// via scripts/cli/run.sh without inline `bun -e` glue (banned by R-SELF-03-c).
//
//   run.sh scripts/normalize/read-unitf.ts \
//     [--handover <handover.json>] \
//     --in <traces.jsonl> \
//     [--manifest <manifest.json>] \
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>] \
//     [--out-focus <diagnosis-focus.json>]
//
// --in is a UniTF .jsonl (one UnifiedTrace per line). Bad/non-UniTF lines are
// tolerated-but-visible: the dropped count + manifest warnings go to stderr.
// ≥1 --out-* is required. Deterministic — no clock/random/network/LLM.
//
// --handover (PATH A *and* PATH B) is the arriving `HandoverBundle` envelope. It
// SUPPLIES --in/--manifest from `inputs[]` when they are not passed explicitly
// (an explicit flag always wins), and extracts `acceptance` into the PATH-B focus
// written by --out-focus. --in remains REQUIRED either way: the traces are what
// diagnostics reads from on BOTH paths — the judgment only says where to look
// first and NEVER substitutes for the deep read (PR-035).

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const handoverPath = get("--handover");
  const outMetadataPath = get("--out-metadata");
  const outEntityPath = get("--out-entity");
  const outFocusPath = get("--out-focus");

  let intake: HandoverIntake | undefined;
  if (handoverPath) {
    try {
      intake = await readHandoverBundle({ handoverPath });
    } catch (err) {
      process.stderr.write(`Error: ${err}\n`);
      process.exit(1);
    }
  } else if (outFocusPath) {
    process.stderr.write("Error: --out-focus requires --handover <handover.json>\n");
    process.exit(1);
  }

  const inPath = get("--in") ?? intake?.traceListPath;
  const manifestPath = get("--manifest") ?? intake?.traceManifestPath;

  if (!inPath || (!outMetadataPath && !outEntityPath && !outFocusPath)) {
    process.stderr.write(
      "Usage: run.sh scripts/normalize/read-unitf.ts [--handover <handover.json>] " +
        "--in <traces.jsonl> [--manifest <manifest.json>] [--out-metadata <path>] " +
        "[--out-entity <path>] [--out-focus <path>]\n",
    );
    process.exit(1);
  }

  for (const w of intake?.warnings ?? []) {
    process.stderr.write(`[read-unitf] handover warning: ${w}\n`);
  }

  try {
    const jsonlContent = readFileSync(resolve(inPath), "utf8");
    const manifestContent = manifestPath
      ? readFileSync(resolve(manifestPath), "utf8")
      : undefined;
    const result = readUniTFHandoverFromStrings(jsonlContent, manifestContent);

    if (result.droppedLineCount > 0) {
      process.stderr.write(
        `[read-unitf] dropped ${result.droppedLineCount} non-UniTF/unparseable line(s)\n`,
      );
    }
    for (const w of result.manifestWarnings) {
      process.stderr.write(`[read-unitf] manifest warning: ${w}\n`);
    }

    if (outMetadataPath) {
      writeFileSync(
        resolve(outMetadataPath),
        JSON.stringify(result.metadata, null, 2),
        "utf8",
      );
      process.stdout.write(
        `TraceMetadata[] (${result.metadata.length}) written to: ${outMetadataPath}\n`,
      );
    }
    if (outEntityPath) {
      writeFileSync(
        resolve(outEntityPath),
        JSON.stringify(result.entity, null, 2),
        "utf8",
      );
      process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
    }
    if (outFocusPath) {
      if (intake?.focus) {
        writeFileSync(
          resolve(outFocusPath),
          JSON.stringify(intake.focus, null, 2),
          "utf8",
        );
        process.stdout.write(
          `DiagnosisFocus (${intake.focus.criteria.length} criteria) written to: ${outFocusPath}\n`,
        );
        // PR-035: make the invariant visible in the run log, every single time.
        process.stderr.write(
          "[read-unitf] PATH B — a judgment arrived. It is a FOCUS (where to look " +
            "FIRST), NOT evidence: the deep-read gate still HARD-REFUSES a run with " +
            "llmReadCount===0 && !priorSignalsRef (PR-035).\n",
        );
      } else {
        // Explicit, never silent: the operator asked for a focus and there is none.
        process.stderr.write(
          "[read-unitf] no judgment in the handover (PATH A: acceptance absent or " +
            "no criteria) — no focus written\n",
        );
      }
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
