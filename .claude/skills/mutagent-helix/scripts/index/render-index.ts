/**
 * scripts/index/render-index.ts
 * F4 — the `.mutagent/index.md` REGISTRY renderer (pure model → markdown).
 * Type A — Pure Script (no I/O, no clock — the model already carries the injected date).
 *
 * The rendered markdown IS the machine surface (no sidecar JSON): section headers +
 * markdown links are what downstream reads. HIGH-LEVEL ONLY — identity · stage · verdict ·
 * build target + LINKS. NEVER eval criteria / scenarios (anti-drift; see build-index.ts).
 *
 * DETERMINISM: a pure function of the model. Same model in → byte-identical string out.
 * Output ends with exactly one trailing newline (POSIX-friendly, stable across regens).
 */

import type {
  IndexCodeLink,
  IndexContextLink,
  IndexEntry,
  IndexModel,
} from "./build-index.ts";

const TITLE = "# MutagenT — Agent Index";
const BLURB_1 =
  "> Spec ↔ implementation registry. Regenerated at each ADL stage — do not hand-edit.";
const BLURB_2 =
  "> HIGH-LEVEL links only (anti-drift): identity · stage · verdict · version/date + links. No eval criteria/scenarios.";
const EMPTY_NOTE = "_No agent specs registered yet._";

/** The em-dash placeholder for an absent value (verdict / runtime). */
const NONE = "—";

/**
 * Link out to a PROJECT-ROOT-relative path from the index, which lives at
 * `<root>/.mutagent/index.md`. Config paths are project-root-relative (determinism rule),
 * so hop out of `.mutagent/` with a `../` prefix. Absolute paths (unusual) pass through.
 */
function projectRootHref(p: string): string {
  if (p.startsWith("/")) return p;
  return `../${p.replace(/^\.\//, "")}`;
}

/** `[label](href)` — label defaults to the raw path (its most recognizable form). */
function mdLink(hrefPath: string, label: string, projectRoot: boolean): string {
  const href = projectRoot ? projectRootHref(hrefPath) : hrefPath;
  return `[${label}](${href})`;
}

function renderCodeRefs(refs: IndexCodeLink[]): string[] {
  if (refs.length === 0) return [];
  const lines = ["- **Agent code / tooling / harness / runtime:**"];
  for (const r of refs) {
    const suffix = r.why ? ` — ${r.why}` : "";
    lines.push(`  - ${mdLink(r.path, r.path, true)}${suffix}`);
  }
  return lines;
}

function renderContextLinks(links: IndexContextLink[]): string[] {
  if (links.length === 0) return [];
  const lines = ["- **Context / product docs:**"];
  for (const c of links) {
    const what = c.what ? ` — ${c.what}` : "";
    const when = c.when ? ` _(when: ${c.when})_` : "";
    lines.push(`  - ${mdLink(c.path, c.path, true)}${what}${when}`);
  }
  return lines;
}

/**
 * Render one agent's section. `updated` is the model's injected date (a single regen stamp
 * for the whole file) — NOT the spec's own `loop_state.updated_at`, so the file is byte-stable
 * under an injected clock (the F4 determinism contract).
 */
export function renderEntry(entry: IndexEntry, updated: string): string[] {
  const verdict = entry.lastVerdict ?? NONE;
  const lines: string[] = [
    `## ${entry.name} — \`spec_id: ${entry.specId}\`  ·  spec v${entry.specVersion}  ·  updated ${updated}`,
    `- **Spec:** ${mdLink(entry.specPath, "agentspec.yaml", false)} · stage: ${entry.stage} · verdict: ${verdict}`,
  ];
  if (entry.build) {
    lines.push(
      `- **Build:** target ${entry.build.targetFramework} · runtime ${entry.build.runtime}`,
    );
  }
  lines.push(...renderCodeRefs(entry.codeRefs));
  lines.push(...renderContextLinks(entry.contextLinks));
  return lines;
}

/**
 * Render the whole index model to markdown. PURE: same model → byte-identical string.
 * Layout: title · two-line anti-drift blurb · `updated <date> · N agent(s)` summary ·
 * one `##` section per agent (sorted by spec_id upstream). Empty index → a friendly note.
 */
export function renderIndex(model: IndexModel): string {
  const count = model.entries.length;
  const summary = `_updated ${model.updated} · ${count} ${count === 1 ? "agent" : "agents"}_`;

  const blocks: string[] = [TITLE, "", BLURB_1, BLURB_2, "", summary, ""];

  if (count === 0) {
    blocks.push(EMPTY_NOTE);
  } else {
    for (const entry of model.entries) {
      blocks.push(...renderEntry(entry, model.updated), "");
    }
    blocks.pop(); // drop the trailing spacer; the final newline is added below.
  }

  return blocks.join("\n") + "\n";
}
