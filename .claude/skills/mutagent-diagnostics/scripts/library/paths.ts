/**
 * scripts/library/paths.ts
 * R2.3 — class-memory library path resolution. LOCAL (per-install) + GITIGNORED.
 * Type A — Pure Script (path construction only; the base dir is INJECTABLE).
 *
 * The library is the skill's cross-run memory: per-entity journals of approved
 * findings + regex patterns that get matched FIRST in Tier-0 (so a known failure
 * mode is recognised cheaply on the next run). It lives LOCAL under the unified
 * `.mutagent/` at the install/init dir (`<root>/.mutagent/diagnostics/library/`)
 * and is GITIGNORED — we commit the library CODE + a .gitignore entry, NEVER the
 * library DATA (it is install-/operator-specific and may carry operator-private
 * invocation briefs via D2). Relocated from the former per-host home dir to the
 * local `.mutagent/` source of truth (operator decision 2026-06-29): the library
 * is now per-install, not cross-project per-host.
 *
 * Layout (Evolvr-style):
 *   <root>/.mutagent/diagnostics/library/
 *     INDEX.md                      # deterministic ToC, sorted by entity
 *     by-entity/<entity-slug>/
 *       entity.json                 # machine record (name, type, runs[], priors)
 *       journal.md                  # append-only human log of approved findings
 *       patterns/<pattern-id>.json  # regex detectors promoted from approved findings
 *       deep-read-ledger.json       # BLOCK G — cross-run deep-read digests (deduped by traceId)
 *
 * The base dir is INJECTABLE (defaults to the process cwd = the host project root
 * where `.mutagent/` lives) so tests pass a temp dir and never touch real disk.
 */

import { join } from "path";

/** Root of the local class-memory library. Injectable base for tests. */
export function libraryRoot(base: string = process.cwd()): string {
  return join(base, ".mutagent", "diagnostics", "library");
}

export function indexPath(base?: string): string {
  return join(libraryRoot(base), "INDEX.md");
}

export function byEntityRoot(base?: string): string {
  return join(libraryRoot(base), "by-entity");
}

export function entityDir(entitySlug: string, base?: string): string {
  return join(byEntityRoot(base), entitySlug);
}

export function entityJsonPath(entitySlug: string, base?: string): string {
  return join(entityDir(entitySlug, base), "entity.json");
}

export function journalPath(entitySlug: string, base?: string): string {
  return join(entityDir(entitySlug, base), "journal.md");
}

export function patternsDir(entitySlug: string, base?: string): string {
  return join(entityDir(entitySlug, base), "patterns");
}

export function patternPath(entitySlug: string, patternId: string, base?: string): string {
  return join(patternsDir(entitySlug, base), `${patternId}.json`);
}

/**
 * BLOCK G — per-entity deep-read ledger file (cross-run digests, deduped by traceId).
 * Lives under the entity's class-memory dir, alongside entity.json — same local,
 * gitignored boundary as the rest of the library.
 */
export function deepReadLedgerPath(entitySlug: string, base?: string): string {
  return join(entityDir(entitySlug, base), "deep-read-ledger.json");
}

/**
 * UNIFIED VERDICT LEDGER — per-entity finding-verdict memory (both polarities:
 * approved + dismissed). Lives alongside entity.json in the entity's class-memory
 * dir, same local + gitignored boundary as the rest of the library. Separate file
 * (like deep-read-ledger.json) so the approved-only entity.json write gate stays clean
 * and the approve→pattern promote bytes are unchanged.
 */
export function verdictLedgerPath(entitySlug: string, base?: string): string {
  return join(entityDir(entitySlug, base), "verdict-ledger.json");
}

/**
 * Deterministic entity slug: lowercase, non-alphanumerics → "-", collapse repeats,
 * trim leading/trailing "-". Stable across runs so the same entity always maps to
 * the same library dir.
 */
export function entitySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}
