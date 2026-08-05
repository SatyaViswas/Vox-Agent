/**
 * scripts/read-manifest.ts — EV-6: the sibling TraceManifest leg of the Discovery handoff.
 * ---------------------------------------------------------------------------
 * The Discovery handoff is a PATH PAIR — the UniTF `.jsonl` PLUS a sibling
 * `TraceManifest` that reports the slice (count · format · truncation · coverage).
 * Diagnostics reads BOTH and audits the slice BEFORE it judges; the evaluator used
 * to read only the JSONL (a bare `--traces` path) and never opened the manifest —
 * so a truncated or partially-malformed export was judged silently as if complete
 * (EV-6). This wires the manifest leg into the evaluator intake, WARN-not-fail, the
 * way diagnostics' `read-unitf.ts` `validateUniTFManifest` does.
 *
 * STANDALONE — the manifest shape is VENDORED (a minimal structural subset of
 * `@mutagent/tools` `trace-manifest.ts`), NOT imported: the standalone-publish
 * guard forbids the evaluator reaching into `@mutagent/tools`
 * (MIGRATION-diagnostics-evaluator.md:417). Only the fields the audit reads are
 * mirrored; diagnostics vendors its own identical copy.
 *
 * PURE except for the effectful `validateSiblingManifest` (one fs read of a sibling
 * path). No clock / random / network.
 */
import { existsSync, readFileSync } from "node:fs";

/** The manifest `format` marker that pairs with the UniTF version. */
export const UNITF_MANIFEST_FORMAT = "unitf@0.1" as const;

/**
 * The sibling TraceManifest (frozen `TraceManifest v0.1.0`), structural subset —
 * only the fields the slice audit inspects. Every field is optional so a partial
 * or older manifest degrades to fewer warnings rather than throwing.
 */
export interface UnitfTraceManifest {
  manifest_version?: string;
  count?: number;
  truncated?: boolean;
  truncationReason?: string;
  format?: string;
  coverage?: {
    fetched?: number;
    malformed?: number;
    deduped?: number;
  };
  warnings?: string[];
}

/**
 * The sibling manifest path for a handed-over traces file: `<path>.manifest.json`,
 * with a `.jsonl` suffix REPLACED (`traces.jsonl` → `traces.manifest.json`) —
 * mirrors `@mutagent/tools` `manifestPathFor`. A `.gz` suffix is stripped first
 * (the evaluator loads `.jsonl.gz` too) so `traces.jsonl.gz` also resolves to
 * `traces.manifest.json`. PURE.
 */
export function manifestPathForTraces(tracesPath: string): string {
  const base = tracesPath.endsWith(".gz") ? tracesPath.slice(0, -".gz".length) : tracesPath;
  return base.endsWith(".jsonl")
    ? base.slice(0, -".jsonl".length) + ".manifest.json"
    : base + ".manifest.json";
}

/**
 * Validate a parsed manifest against the parsed trace count. Returns WARNINGS
 * (never throws, never aborts) — the migration's "surface warnings but do NOT
 * abort a partial export" rule. Empty array = clean / no manifest. Mirrors
 * diagnostics `validateUniTFManifest`.
 */
export function validateUnitfManifest(
  manifest: UnitfTraceManifest | undefined,
  actualTraceCount: number,
): string[] {
  const warnings: string[] = [];
  if (!manifest) return warnings;
  if (manifest.format !== undefined && manifest.format !== UNITF_MANIFEST_FORMAT) {
    warnings.push(`manifest.format is "${manifest.format}" — expected "${UNITF_MANIFEST_FORMAT}"`);
  }
  if (manifest.count !== undefined && manifest.count !== actualTraceCount) {
    warnings.push(
      `manifest.count (${manifest.count}) != parsed trace count (${actualTraceCount}) — ` +
        `the slice is incomplete (a truncated/partially-malformed export judged as if complete)`,
    );
  }
  if (manifest.truncated === true) {
    warnings.push(
      `export is truncated${manifest.truncationReason ? ` (${manifest.truncationReason})` : ""} — ` +
        `judging a PARTIAL slice`,
    );
  }
  // Coverage cross-check: fetched should account for the parsed + malformed + deduped
  // records; a fetched count that exceeds what landed on disk is a silent drop.
  const cov = manifest.coverage;
  if (cov?.fetched !== undefined) {
    const accountedFor = actualTraceCount + (cov.malformed ?? 0) + (cov.deduped ?? 0);
    if (cov.fetched !== accountedFor) {
      warnings.push(
        `manifest.coverage.fetched (${cov.fetched}) != parsed(${actualTraceCount}) + ` +
          `malformed(${cov.malformed ?? 0}) + deduped(${cov.deduped ?? 0}) = ${accountedFor} — ` +
          `records went missing between fetch and hand-off`,
      );
    }
  }
  if (manifest.warnings) warnings.push(...manifest.warnings);
  return warnings;
}

/**
 * Read + validate the sibling manifest for a handed-over traces file. Effectful
 * (one fs read). NON-fatal throughout: an ABSENT manifest returns [] (the handoff
 * may predate the manifest leg); an UNREADABLE / unparseable manifest yields a
 * single warning and proceeds. Returns the human-readable warning list the caller
 * surfaces on stderr.
 */
export function validateSiblingManifest(tracesPath: string, actualTraceCount: number): string[] {
  const manifestPath = manifestPathForTraces(tracesPath);
  if (!existsSync(manifestPath)) return []; // no manifest leg — nothing to audit
  let manifest: UnitfTraceManifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UnitfTraceManifest;
  } catch {
    return [`sibling manifest '${manifestPath}' failed to read/parse — proceeding without slice audit`];
  }
  return validateUnitfManifest(manifest, actualTraceCount);
}
