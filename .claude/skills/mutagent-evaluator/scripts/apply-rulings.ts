/**
 * scripts/apply-rulings.ts — the operator's rulings, from the report to the store.
 * ---------------------------------------------------------------------------
 * THE MISSING HALF. The decisions store (`decisions-store.ts`) records what the operator
 * accepted and rejected, and the mining brief reads the rejections back so nothing is
 * re-proposed forever. What was missing was the path IN: the operator ruled in the report
 * and the ruling went nowhere.
 *
 * THE PATH: the operator reviews in the report UI, copies one block, and that block is
 * applied here. No chat narration, no dictation, no transcription layer between the
 * ruling and the file.
 *
 * ── WHY THE COPIED BLOCK CARRIES INSTRUCTIONS, NOT JUST DATA ────────────────────────
 * Per the operator: "make the pasted clipboard also have a directive and clear
 * explanation for the follow-up actions. Do not assume that the agent will understand
 * anything." The receiver of this block is usually a coding agent with no memory of the
 * review, no access to the report, and no idea what a `nd-` id is. A bare JSON payload
 * would be handed to something that does not know what to do with it — so the block is a
 * SELF-CONTAINED INSTRUCTION with the payload embedded, in the same spirit as the handoff
 * format (`references/handoff-format.md`): context → what to do → the data → how to
 * verify → what NOT to do.
 *
 * ── WHY EMIT AND PARSE LIVE IN ONE FILE ─────────────────────────────────────────────
 * G7 deliberately kept the three report renderers free of a shared module: their handoff
 * PROSE differs per surface and a spec is the right contract. This is the opposite case —
 * a MACHINE-READABLE format that must round-trip exactly. An emitter and a parser that
 * can drift are a silent data-loss bug, so they are defined together and round-tripping
 * is asserted by test. The renderers call the emitter; they still do not call each other.
 *
 * PURE except the store read/write in the CLI path. No clock, no random, no network, no LLM.
 */
import { readFileSync } from "node:fs";
import {
  DecisionKind,
  DecisionTargetKind,
  recordDecisions,
  type DecisionKindValue,
  type DecisionsStore,
  type DecisionTargetKindValue,
} from "./decisions-store.ts";

/** One ruling as it travels in the copied block. */
export interface Ruling {
  /** the criterion id / near-duplicate pair id / observation id being ruled on. */
  target: string;
  kind: DecisionKindValue;
  /** which surface the target came from — decides how the ruling is applied. */
  targetKind: DecisionTargetKindValue;
  /**
   * The statement VERBATIM. Load-bearing on a REJECT: the tombstone is compared against
   * future proposals by MEANING, and a tombstone with no statement cannot participate in
   * that comparison — it would silently stop preventing rediscovery.
   */
  statement?: string;
  /** why — shown back to the operator when a rejected item recurs. */
  why?: string;
  /** the amended text (kind === "revise"). */
  revisedStatement?: string;
}

/** The whole copied payload. */
export interface RulingsDocument {
  /** which run produced the proposals — provenance, so a stale block is recognisable. */
  runId: string;
  /** which report the operator ruled in. */
  surface: "discover" | "review" | "evaluate";
  rulings: Ruling[];
}

/** The fenced marker the payload sits inside, so it survives being pasted into prose. */
export const RULINGS_OPEN = "<!-- mutagent:rulings -->";
export const RULINGS_CLOSE = "<!-- /mutagent:rulings -->";

/**
 * Render the copy-paste block: a SELF-CONTAINED instruction with the payload inside.
 *
 * Everything outside the fence is for the receiver — which may be a coding agent that has
 * never seen the report. Everything inside the fence is the machine payload. The parser
 * reads only the fence, so the prose can be rewritten freely without breaking the format.
 */
export function renderRulingsBlock(doc: RulingsDocument): string {
  const accepts = doc.rulings.filter((r) => r.kind === DecisionKind.Accept).length;
  const rejects = doc.rulings.filter((r) => r.kind === DecisionKind.Reject).length;
  const revises = doc.rulings.filter((r) => r.kind === DecisionKind.Revise).length;
  return [
    `# Operator rulings — ${doc.surface} · run ${doc.runId}`,
    "",
    "## What this is",
    `A human reviewed ${doc.rulings.length} proposal(s) in the MutagenT evaluator's`,
    `${doc.surface} report and ruled on each one: ${accepts} accepted, ${rejects} rejected` +
      `${revises > 0 ? `, ${revises} revised` : ""}.`,
    "These rulings are NOT yet recorded. Recording them is your job.",
    "",
    "## What to do — one command",
    "```bash",
    "bun .claude/skills/mutagent-evaluator/scripts/apply-rulings.ts --from <this-file>",
    "```",
    "Save this whole block to a file and pass it as `--from`. The command is idempotent:",
    "running it twice records the same rulings once, so a re-paste is safe.",
    "",
    "## What it does",
    "- an **accept** makes the criterion PERMANENT in the evaluation suite, carrying its",
    "  kind (code-defined / llm-judge / hybrid) — the kind decides which machinery runs it.",
    "- a **reject** records a tombstone. Nothing is deleted; the tombstone is what stops the",
    "  same rule being proposed again on every future run.",
    "- a **revise** admits the amended wording, linked to the original id so existing",
    "  references still resolve.",
    "",
    "## How to verify it worked",
    "```bash",
    "bun .claude/skills/mutagent-evaluator/scripts/apply-rulings.ts --from <file> --dry-run",
    "```",
    "prints what WOULD change without writing. After a real apply, the store at",
    "`.mutagent/evaluator/suite/operator-decisions.json` gains one entry per ruling, and the",
    "next `*discover` run will not re-propose anything rejected here.",
    "",
    "## What NOT to do",
    "- Do NOT edit the `target` ids below. They are how the ruling finds what it rules on.",
    "- Do NOT hand-edit the store file — it is append-only and a malformed store is refused",
    "  rather than silently reset.",
    "- Do NOT drop the `statement` on a reject. The tombstone is matched by MEANING against",
    "  future proposals; without the statement it silently stops preventing rediscovery.",
    "",
    "## The rulings",
    RULINGS_OPEN,
    "```json",
    JSON.stringify(doc, null, 2),
    "```",
    RULINGS_CLOSE,
    "",
  ].join("\n");
}

const KINDS = new Set<string>(Object.values(DecisionKind));
const TARGET_KINDS = new Set<string>(Object.values(DecisionTargetKind));

/**
 * Parse a pasted block back into a document. Reads ONLY between the fences, so surrounding
 * prose, quoting, or an email signature cannot break it.
 *
 * FAIL-LOUD on anything it cannot understand. A rulings block that half-applies is worse
 * than one that is refused: the operator would believe every ruling landed. PURE.
 */
export function parseRulingsBlock(raw: string): { doc: RulingsDocument } | { error: string } {
  const start = raw.indexOf(RULINGS_OPEN);
  const end = raw.indexOf(RULINGS_CLOSE);
  if (start < 0 || end < 0 || end < start) {
    return { error: `no rulings payload found — the block must contain ${RULINGS_OPEN} … ${RULINGS_CLOSE}` };
  }
  const inner = raw.slice(start + RULINGS_OPEN.length, end);
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(inner);
  const body = (fence !== null ? fence[1]! : inner).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { error: `the rulings payload is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const d = parsed as Partial<RulingsDocument>;
  if (typeof d.runId !== "string" || d.runId.length === 0) return { error: "rulings payload has no runId" };
  if (d.surface !== "discover" && d.surface !== "review" && d.surface !== "evaluate") {
    return { error: `rulings payload has an unknown surface '${String(d.surface)}'` };
  }
  if (!Array.isArray(d.rulings)) return { error: "rulings payload has no rulings[]" };
  for (const [i, r] of d.rulings.entries()) {
    const x = r as Partial<Ruling>;
    if (typeof x.target !== "string" || x.target.length === 0) return { error: `ruling ${i} has no target` };
    if (typeof x.kind !== "string" || !KINDS.has(x.kind)) {
      return { error: `ruling ${i} ('${x.target}') has an unknown kind '${String(x.kind)}' (expected ${[...KINDS].join(" | ")})` };
    }
    if (typeof x.targetKind !== "string" || !TARGET_KINDS.has(x.targetKind)) {
      return { error: `ruling ${i} ('${x.target}') has an unknown targetKind '${String(x.targetKind)}'` };
    }
    if (x.kind === DecisionKind.Reject && (typeof x.statement !== "string" || x.statement.length === 0)) {
      // refused rather than accepted-and-degraded: a statement-less tombstone LOOKS like a
      // recorded rejection while quietly failing to prevent the rediscovery it exists for.
      return { error: `ruling ${i} ('${x.target}') is a REJECT with no statement — a tombstone without its statement cannot stop the rule being re-proposed` };
    }
    if (x.kind === DecisionKind.Revise && (typeof x.revisedStatement !== "string" || x.revisedStatement.length === 0)) {
      return { error: `ruling ${i} ('${x.target}') is a REVISE with no revisedStatement` };
    }
  }
  return { doc: d as RulingsDocument };
}

/** Apply a parsed document to the store. Idempotent (the store dedupes by ruling id). PURE. */
export function applyRulings(store: DecisionsStore, doc: RulingsDocument): DecisionsStore {
  return recordDecisions(
    store,
    doc.rulings.map((r) => ({
      kind: r.kind,
      targetKind: r.targetKind,
      target: r.target,
      runId: doc.runId,
      ...(r.statement !== undefined ? { statement: r.statement } : {}),
      ...(r.why !== undefined ? { rationale: r.why } : {}),
      ...(r.revisedStatement !== undefined ? { revisedStatement: r.revisedStatement } : {}),
    })),
  );
}

/** A human-readable summary of what an apply changed — the `--dry-run` output. */
export function summarizeRulings(before: DecisionsStore, doc: RulingsDocument): string {
  const after = applyRulings(before, doc);
  const added = after.decisions.length - before.decisions.length;
  const lines = [
    `${doc.rulings.length} ruling(s) from ${doc.surface} run ${doc.runId}`,
    `  ${added} new · ${doc.rulings.length - added} already recorded (idempotent re-apply)`,
  ];
  for (const r of doc.rulings) lines.push(`  ${r.kind.toUpperCase().padEnd(6)} ${r.target}${r.why !== undefined ? ` — ${r.why}` : ""}`);
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const from = flag("from");
  if (from === undefined) {
    console.error("usage: apply-rulings.ts --from <file> [--store-dir <dir>] [--dry-run]");
    process.exit(2);
  }
  const parsed = parseRulingsBlock(readFileSync(from, "utf8"));
  if ("error" in parsed) {
    // named, not swallowed: a half-applied ruling set is worse than a refused one.
    console.error(`apply-rulings REFUSED: ${parsed.error}`);
    process.exit(1);
  }
  const { readDecisionsStore, writeDecisionsStore } = await import("./aggregate-discover.ts");
  const { livingSuiteDir } = await import("./artifact-paths.ts");
  const dir = flag("store-dir") ?? livingSuiteDir();
  const before = readDecisionsStore(dir);
  if (argv.includes("--dry-run")) {
    console.info(summarizeRulings(before, parsed.doc));
    console.info("\n(dry run — nothing written)");
    process.exit(0);
  }
  const path = writeDecisionsStore(dir, applyRulings(before, parsed.doc));
  console.info(`${summarizeRulings(before, parsed.doc)}\n\nwrote ${path}`);
  process.exit(0);
}
