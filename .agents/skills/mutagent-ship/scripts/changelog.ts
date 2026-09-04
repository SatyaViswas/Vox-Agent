import {
  ChangelogSource,
  type ChangelogSourceValue,
  type ShipManifest,
} from "./ship-manifest.ts";

// Re-export the source enum so changelog consumers (and tests) can name it from
// the changelog module — the changelog IS its home concept.
export { ChangelogSource, type ChangelogSourceValue } from "./ship-manifest.ts";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the standardized PR changelog contract (ship PRD §3).
//
// Every ship PR body is RENDERED from the manifest + a changelog source — never
// freehand. All six sections are MANDATORY; a missing section fails the
// changelog-contract gate (SL-9 S1 asserts `PR artifact exists ∧
// changelog-contract holds`). The `## Evidence & Provenance` section is the
// audit spine — it is what makes the PR self-auditing.
//
// KP-7 — changelog SOURCE precedence: evaluate-report > build-report > git-log.
//
// NDA / publish hygiene (PRD §3): the rendered body is leak-safe by
// construction — subject paths + artifact links only; never raw trace content,
// never client identifiers, never private-org names. The renderer only ever
// emits paths/refs it is handed; it never inlines trace bodies.
//
// Pure + deterministic: no I/O, no clock. Same input ⇒ byte-identical body.
// ---------------------------------------------------------------------------

/** The six MANDATORY section headers, in render order (ship PRD §3 table). */
export const CHANGELOG_SECTIONS = [
  "## Problem",
  "## Solution",
  "## Changes",
  "## Evidence & Provenance",
  "## Verification",
  "## Risks & Limitations",
] as const;

/** Which changelog sources are available for this ship (KP-7 precedence input). */
export interface ChangelogSourceAvailability {
  /** The evaluate-report summary + its ArtifactRef path (highest precedence). */
  evaluateReport?: { summary: string; ref: string };
  /** The build-report summary + its ArtifactRef path (middle precedence). */
  buildReport?: { summary: string; ref: string };
  /** The annotated git-log range summary (the always-available floor). */
  gitLog?: { summary: string; ref: string };
}

export interface ResolvedChangelogSource {
  source: ChangelogSourceValue;
  summary: string;
  ref: string;
}

/**
 * Resolve the changelog SOURCE by the KP-7 precedence: evaluate > build > git-log.
 * Returns the highest-precedence AVAILABLE source. Throws if none is available
 * (git-log is the floor — a caller that provides nothing is a programming error,
 * fail-loud rather than emit an empty Solution).
 */
export function resolveChangelogSource(
  avail: ChangelogSourceAvailability,
): ResolvedChangelogSource {
  if (avail.evaluateReport) {
    return {
      source: ChangelogSource.EvaluateReport,
      summary: avail.evaluateReport.summary,
      ref: avail.evaluateReport.ref,
    };
  }
  if (avail.buildReport) {
    return {
      source: ChangelogSource.BuildReport,
      summary: avail.buildReport.summary,
      ref: avail.buildReport.ref,
    };
  }
  if (avail.gitLog) {
    return {
      source: ChangelogSource.GitLog,
      summary: avail.gitLog.summary,
      ref: avail.gitLog.ref,
    };
  }
  throw new Error(
    "resolveChangelogSource: no changelog source available — at least git-log " +
      "(the floor) must be provided (KP-7)",
  );
}

/** One row of the `## Changes` table — a file and WHY it matters (not just WHAT). */
export interface ChangeRow {
  /** The explicit path — the SAME path staged in the commit (PRD §3 §3 contract). */
  file: string;
  /** WHY this file changed (purpose, not a restatement of the diff). */
  purpose: string;
}

export interface ChangelogInput {
  manifest: ShipManifest;
  /** WHY this ship exists — the subject + what changed since last ship (1–3 sentences). */
  problem: string;
  /** The resolved changelog source (from resolveChangelogSource). */
  resolvedSource: ResolvedChangelogSource;
  /** The changed files → purpose table (explicit paths only). */
  changes: ChangeRow[];
  /** What was verified pre-ship (evaluate suite summary, build TDD result). */
  verificationPreShip: string;
  /** Honest gaps — what the eval did NOT cover, watch blind spots. */
  risks: string;
}

const mdTableEscape = (s: string): string => s.replace(/\|/g, "\\|");

/**
 * Render the standardized ship-PR changelog body from the manifest + resolved
 * source. Deterministic; all six sections always present (the contract gate
 * below re-asserts this on the rendered string). The `## Evidence & Provenance`
 * section is derived from the manifest — the audit spine.
 */
export function renderChangelog(input: ChangelogInput): string {
  const { manifest: m, resolvedSource: src } = input;

  const changesRows =
    input.changes.length > 0
      ? input.changes
          .map((c) => `| \`${mdTableEscape(c.file)}\` | ${mdTableEscape(c.purpose)} |`)
          .join("\n")
      : "| _(no file changes enumerated)_ | — |";

  // The post-merge watch plan, described honestly from the manifest.
  const watchPlan =
    `window ${m.watch.window_minutes}m · baseline mode \`${m.watch.baseline.mode}\` · ` +
    `deploy-confirm \`${m.deploy.confirm}\` (${m.target.deploy_semantics}) · ` +
    `acquisition \`${m.watch.acquisition}\``;

  return [
    "## Problem",
    "",
    input.problem.trim(),
    "",
    "## Solution",
    "",
    `${src.summary.trim()}`,
    "",
    `_Changelog source: \`${src.source}\` (KP-7 precedence: evaluate > build > git-log)._`,
    "",
    "## Changes",
    "",
    "| File | Purpose (WHY) |",
    "|---|---|",
    changesRows,
    "",
    "## Evidence & Provenance",
    "",
    `- **Evaluate GATE verdict**: \`${m.evidence.evaluate_verdict}\` (PASS · 0 CRIT/HIGH — the entry-gate proof)`,
    `- **Verdict commit**: \`${m.subject.commit}\``,
    `- **Ship manifest**: \`.mutagent/ship/runs/${m.ship_id}/ship-manifest.yaml\``,
    `- **Changelog source declaration**: \`${src.source}\` → \`${src.ref}\``,
    m.evidence.build_report ? `- **Build report**: \`${m.evidence.build_report}\`` : "- **Build report**: _(none)_",
    "",
    "## Verification",
    "",
    `**Pre-ship:** ${input.verificationPreShip.trim()}`,
    "",
    `**Post-merge watch will verify:** ${watchPlan}.`,
    "",
    "## Risks & Limitations",
    "",
    input.risks.trim(),
    "",
  ].join("\n");
}

export interface ContractResult {
  ok: boolean;
  /** The section headers that are MISSING (empty when ok). */
  missing: string[];
  /** True iff `## Evidence & Provenance` is present AND non-empty (the audit spine). */
  evidencePopulated: boolean;
}

/**
 * The changelog-contract gate (SL-9 S1): every one of the six mandatory sections
 * must be present, AND `## Evidence & Provenance` must be populated (its body must
 * carry the evaluate-verdict line). Pure string check over a rendered body — so a
 * hand-edited or truncated body is caught before the PR opens.
 */
export function checkChangelogContract(body: string): ContractResult {
  const missing = CHANGELOG_SECTIONS.filter((h) => {
    // Header must appear at the start of a line (a real section, not a mention).
    const re = new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    return !re.test(body);
  });

  // Evidence & Provenance must carry the verdict line (the audit spine, not an empty header).
  const evidenceIdx = body.indexOf("## Evidence & Provenance");
  const nextHeaderIdx = body.indexOf("## Verification");
  const evidenceBlock =
    evidenceIdx >= 0 && nextHeaderIdx > evidenceIdx
      ? body.slice(evidenceIdx, nextHeaderIdx)
      : "";
  const evidencePopulated =
    /Evaluate GATE verdict/.test(evidenceBlock) && /Verdict commit/.test(evidenceBlock);

  return {
    ok: missing.length === 0 && evidencePopulated,
    missing,
    evidencePopulated,
  };
}
