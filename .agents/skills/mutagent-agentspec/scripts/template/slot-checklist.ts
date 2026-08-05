/**
 * scripts/template/slot-checklist.ts
 * The ENUMERATE-FIRST template-slot checklist (SPEC-1 · PR-025).
 * Type A — Pure core (deriveSlotChecklist, no I/O) + a thin guarded CLI. Mirrors validate-spec.ts.
 *
 * WHY: a `*sync-spec` reverse-generate reads an implementation and reverse-maps it onto the spec in
 * one free-reading pass — with NO step that first enumerates the real surface into a checklist, it
 * silently captures only a FRACTION of the command / hook / file surface, and the `*validate-spec`
 * gate checks field SHAPES only (an incomplete spec passes exactly as cleanly as a complete one).
 * This script derives, from the ONE worked template (assets/templates/agentspec.yaml.tpl), the
 * canonical set of Definition / Build / Appendix SLOTS a draft must DELIBERATELY fill or mark N/A —
 * the completeness scaffold the enumerate-first pass drives off (PR-025). It is NOT a mechanical
 * tools↔jobs diff: it emits the template's slot skeleton; the actual fill + the impl→spec cross-verify
 * are `ai-architect #sync-spec`'s reasoning.
 *
 * Usage: scripts/cli/run.sh scripts/template/slot-checklist.ts [template.yaml] [--json]
 *   exit 0 = the checklist derived  → one row per slot (section · cardinality · path), or JSON
 *   exit 1 = the template could not be read/parsed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * The `spec.*` sections whose slots a draft must deliberately fill or mark empty (AgentSpec 0.3.0).
 * A given card carries exactly ONE kind-native body (agent | skill | multiAgent | workflow); the
 * derived checklist reflects whichever sections the worked template actually contains.
 */
const SECTIONS = [
  "intent",
  "context",
  "actions",
  "capabilities",
  "agent",
  "skill",
  "multiAgent",
  "workflow",
  "targets",
  "evaluation",
  "decisionsRef",
] as const;
type Section = (typeof SECTIONS)[number];

/** One template slot the enumerate-first pass must FILL (from the surface) or mark N/A. */
export interface SlotEntry {
  /** dotted path, e.g. "definition.tools.integration". */
  path: string;
  /** the top-level section the slot lives in. */
  section: Section;
  /** list = a 0..n array; object = a nested-object leaf; scalar = a single value. */
  cardinality: "list" | "object" | "scalar";
}

export interface SlotChecklist {
  slots: SlotEntry[];
  sections: Section[];
}

/**
 * Structural CONTAINER keys nested INSIDE a section that we DESCEND into so their child slots are
 * listed individually. Top-level object sections (intent · capabilities · agent | skill | … ·
 * evaluation) are always walked; this set only governs deeper nesting — `persona` inside an Agent
 * body. A key NOT in this set is a leaf slot even when its value is an object (e.g. agent.workflow,
 * whose internals are the graph body, not fixed fill-slots).
 */
const CONTAINER_KEYS = new Set(["persona"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function classify(v: unknown): SlotEntry["cardinality"] {
  if (Array.isArray(v)) return "list";
  if (isPlainObject(v)) return "object";
  return "scalar";
}

/**
 * PURE core. Parse the worked template and walk its `spec.*` sections — descending object sections
 * (and nested CONTAINER keys), emitting list/scalar sections as single slots — to derive the
 * canonical slot checklist. No I/O; on a parse failure, a non-object root, or a missing `spec`
 * returns an empty checklist (the CLI reports it as exit 1).
 */
export function deriveSlotChecklist(templateText: string): SlotChecklist {
  let parsed: unknown;
  try {
    parsed = parseYaml(templateText);
  } catch {
    return { slots: [], sections: [] };
  }
  if (!isPlainObject(parsed)) return { slots: [], sections: [] };
  const spec = parsed.spec;
  if (!isPlainObject(spec)) return { slots: [], sections: [] };

  const slots: SlotEntry[] = [];
  const sectionsSeen: Section[] = [];

  const walk = (prefix: string, node: Record<string, unknown>, section: Section): void => {
    for (const [key, value] of Object.entries(node)) {
      const slotPath = `${prefix}.${key}`;
      if (isPlainObject(value) && CONTAINER_KEYS.has(key)) {
        walk(slotPath, value, section);
      } else {
        slots.push({ path: slotPath, section, cardinality: classify(value) });
      }
    }
  };

  for (const section of SECTIONS) {
    const value = spec[section];
    if (value === undefined) continue;
    sectionsSeen.push(section);
    if (isPlainObject(value)) {
      walk(section, value, section);
    } else {
      // A list section (context · actions · targets) or a scalar section (decisionsRef) is one slot.
      slots.push({ path: section, section, cardinality: classify(value) });
    }
  }

  return { slots, sections: sectionsSeen };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function defaultTemplatePath(): string {
  // scripts/template/ -> skill root -> assets/templates/agentspec.yaml.tpl
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "assets", "templates", "agentspec.yaml.tpl");
}

function runCli(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const positional = args.find((a) => !a.startsWith("--"));
  const templatePath = positional ? path.resolve(positional) : defaultTemplatePath();

  let text: string;
  try {
    text = fs.readFileSync(templatePath, "utf-8");
  } catch (err) {
    process.stderr.write(`Error reading template ${templatePath}: ${String(err)}\n`);
    return 1;
  }

  const checklist = deriveSlotChecklist(text);
  if (checklist.slots.length === 0) {
    process.stderr.write(`[slot-checklist] FAIL — could not derive slots from ${templatePath}\n`);
    return 1;
  }

  if (json) {
    console.info(JSON.stringify(checklist, null, 2));
    return 0;
  }

  console.info(
    `[slot-checklist] ${checklist.slots.length} template slots — FILL each from the enumerated surface or mark N/A (PR-025):`,
  );
  console.info("section     cardinality  slot");
  console.info("──────────  ───────────  ────────────────────────────────────────");
  for (const s of checklist.slots) {
    console.info(`${s.section.padEnd(10)}  ${s.cardinality.padEnd(11)}  ${s.path}`);
  }
  return 0;
}

const isMain =
  typeof import.meta !== "undefined" && (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
