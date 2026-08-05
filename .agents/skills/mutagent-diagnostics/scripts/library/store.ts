/**
 * scripts/library/store.ts
 * R2.3 (+D2) — class-memory library read/write store.
 * Type A — Pure Script (file I/O; clock + home INJECTED for determinism).
 *
 * WRITE GATE (R2.3, LOAD-BEARING): the library is written ONLY from operator-
 * APPROVED findings. writeApprovedFinding() refuses unless the caller passes
 * `approved: true`. There is NO bypass — an un-approved finding NEVER lands in
 * the library (mirrors the report's approval gate; do not bypass it).
 *
 * DETERMINISM: INDEX.md is sorted by entity slug; journal.md is append-only;
 * pattern files are stable JSON. The only non-determinism (timestamps) is injected
 * by the caller so tests are byte-stable.
 *
 * The library lives PER-HOST + GITIGNORED — see paths.ts. We never commit data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, statSync } from "fs";
import {
  libraryRoot,
  indexPath,
  byEntityRoot,
  entityDir,
  entityJsonPath,
  journalPath,
  patternsDir,
  patternPath,
  deepReadLedgerPath,
  verdictLedgerPath,
  entitySlug,
} from "./paths.ts";
import type {
  DeepReadLedgerEntry,
  LibraryEntity,
  LibraryPattern,
  LibraryRunRecord,
  VerdictLedgerEntry,
  VerdictPolarity,
  VerdictSeverity,
} from "./types.ts";
import { DEEP_READ_LEDGER_TTL_MS } from "./types.ts";

export interface ApprovedFindingInput {
  entityName: string;
  entityType: LibraryEntity["entityType"];
  /** MUST be true — the write gate refuses otherwise (R2.3 approved-only). */
  approved: boolean;
  findingId: string;
  signal: string;
  /** Regex source promoted as a Tier-0 detector (plain regex). */
  regex: string;
  regexFlags?: string;
  /** D2 — verbatim operator invocation that produced this run. */
  operatorInvocation?: string;
  runId: string;
  /** INJECTED timestamp (ISO8601) — keeps writes deterministic in tests. */
  nowIso: string;

  // ── UNIFIED VERDICT LEDGER mirror (OPT-IN, additive) ─────────────────────────
  // When `entityFingerprint` is supplied, writeApprovedFinding ADDITIONALLY mirrors an
  // "approved" verdict into the unified verdict-ledger.json (so the ledger records BOTH
  // polarities). This is PURELY additive — a new file write; entity.json / patterns /
  // journal / INDEX bytes are UNCHANGED. Absent → no mirror (fully backward-compatible).
  /** Current entity fingerprint — presence ENABLES the approved-verdict mirror. */
  entityFingerprint?: string;
  /** Failure-mode triple for the mirrored approved verdict (provenance + memory). */
  what?: string;
  why?: string;
  where?: string;
  /** OPTIONAL richer narration (failureOrigin.whatHappened) for the mirrored verdict. */
  whatHappened?: string;
  /** Severity of the approved finding (mirrored verdict baseline). Defaults to "info". */
  severity?: VerdictSeverity;
}

export interface WriteResult {
  written: boolean;
  reason: string;
  entitySlug: string;
}

/** Ensure a directory exists (idempotent). */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Load an entity record, or null when absent. */
export function loadEntity(slug: string, home?: string): LibraryEntity | null {
  const p = entityJsonPath(slug, home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LibraryEntity;
  } catch {
    return null;
  }
}

/**
 * R2.3 — the SOLE library write path. Refuses unless `approved === true`. Creates
 * the per-entity dir, upserts entity.json (append run + pattern), appends to the
 * journal, writes the pattern file, and regenerates INDEX.md deterministically.
 */
export function writeApprovedFinding(input: ApprovedFindingInput, home?: string): WriteResult {
  const slug = entitySlug(input.entityName);

  // WRITE GATE — approved-only (R2.3). No bypass.
  if (!input.approved) {
    return {
      written: false,
      reason: "REFUSED — library write requires an operator-APPROVED finding (R2.3 approved-only gate).",
      entitySlug: slug,
    };
  }

  ensureDir(entityDir(slug, home));
  ensureDir(patternsDir(slug, home));

  // Upsert entity.json.
  const existing = loadEntity(slug, home);
  const runRecord: LibraryRunRecord = {
    runId: input.runId,
    diagnosedAt: input.nowIso,
    operatorInvocation: input.operatorInvocation,
    approvedFindingCount: 1,
  };
  const pattern: LibraryPattern = {
    patternId: `${slug}-${input.findingId}`,
    signal: input.signal,
    regex: input.regex,
    flags: input.regexFlags,
    sourceFindingId: input.findingId,
    approvedAt: input.nowIso,
  };

  let entity: LibraryEntity;
  if (existing) {
    // Append run (append-only) + upsert pattern by id.
    const runs = [...existing.runs, runRecord];
    const patterns = upsertPattern(existing.patterns, pattern);
    // BLOCK G — tolerate pre-ledger entity.json records (field added in Wave-17).
    const deepReadLedger = existing.deepReadLedger ?? [];
    entity = { ...existing, runs, patterns, deepReadLedger, updatedAt: input.nowIso };
  } else {
    entity = {
      name: input.entityName,
      entityType: input.entityType,
      slug,
      runs: [runRecord],
      patterns: [pattern],
      deepReadLedger: [],
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
  }

  writeFileSync(entityJsonPath(slug, home), JSON.stringify(entity, null, 2) + "\n", "utf8");
  writeFileSync(patternPath(slug, pattern.patternId, home), JSON.stringify(pattern, null, 2) + "\n", "utf8");

  // Append-only journal entry.
  const journalEntry =
    `## ${input.nowIso} — ${input.findingId} (${input.signal})\n` +
    `- run: ${input.runId}\n` +
    (input.operatorInvocation ? `- invocation: ${input.operatorInvocation.replace(/\n/g, " ")}\n` : "") +
    `- pattern: \`${input.regex}\`${input.regexFlags ? ` /${input.regexFlags}` : ""}\n\n`;
  appendFileSync(journalPath(slug, home), journalEntry, "utf8");

  // Regenerate deterministic INDEX.md.
  regenerateIndex(home);

  // UNIFIED VERDICT LEDGER — additive mirror of the APPROVED polarity. Fires ONLY when
  // the caller supplies verdict context (entityFingerprint). Writes verdict-ledger.json
  // ONLY — the approve→pattern promote above is byte-unchanged. No journal touch (the
  // verdict ledger is the audit trail; journal.md stays byte-identical to pre-mirror).
  if (input.entityFingerprint !== undefined) {
    recordVerdict(
      {
        entityName: input.entityName,
        verdict: "approved",
        findingId: input.findingId,
        what: input.what ?? "",
        why: input.why ?? "",
        where: input.where ?? "",
        whatHappened: input.whatHappened,
        severityAtDismissal: input.severity ?? "info",
        entityFingerprint: input.entityFingerprint,
        operatorInvocation: input.operatorInvocation,
        runId: input.runId,
        nowIso: input.nowIso,
      },
      home
    );
  }

  return { written: true, reason: "Approved finding written to library.", entitySlug: slug };
}

function upsertPattern(patterns: LibraryPattern[], next: LibraryPattern): LibraryPattern[] {
  const idx = patterns.findIndex((p) => p.patternId === next.patternId);
  if (idx === -1) return [...patterns, next];
  const copy = [...patterns];
  copy[idx] = next;
  return copy;
}

/**
 * Regenerate INDEX.md from the on-disk entity records. DETERMINISTIC: entities are
 * sorted by slug; each row lists run-count + pattern-count. Pure given disk state.
 */
export function regenerateIndex(home?: string): void {
  ensureDir(libraryRoot(home));
  const root = byEntityRoot(home);
  const slugs = existsSync(root)
    ? readdirSync(root).filter((e) => {
        try {
          return statSync(entityDir(e, home)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  slugs.sort(); // deterministic ordering.

  const lines: string[] = [
    "# mutagent-diagnostics — class-memory library",
    "",
    "> Per-host, gitignored. Approved findings only (R2.3). Patterns are matched FIRST in Tier-0.",
    "",
    "| Entity | Type | Runs | Patterns |",
    "|--------|------|------|----------|",
  ];
  for (const slug of slugs) {
    const e = loadEntity(slug, home);
    if (!e) continue;
    lines.push(`| ${e.name} | ${e.entityType} | ${e.runs.length} | ${e.patterns.length} |`);
  }
  lines.push("");
  writeFileSync(indexPath(home), lines.join("\n"), "utf8");
}

/** True when library priors exist for the entity (drives R2.1 refusal downgrade). */
export function hasPriors(entityName: string, home?: string): boolean {
  const e = loadEntity(entitySlug(entityName), home);
  return !!e && e.patterns.length > 0;
}

/**
 * Build the priorSignalsRef string for an entity (consumed by R2.1's gate + R2.2's
 * SKIP). Returns the journal-relative ref when priors exist, else undefined.
 */
export function priorSignalsRef(entityName: string, home?: string): string | undefined {
  const slug = entitySlug(entityName);
  return hasPriors(entityName, home) ? `by-entity/${slug}/journal.md` : undefined;
}

// ── BLOCK G — cross-run deep-read LEDGER ─────────────────────────────────────
//
// The ledger records, per (entity, trace), that the deep-read analyzer already
// digested that trace. It lives in its OWN file (deep-read-ledger.json) — NOT inside
// entity.json — because deep-read digests are produced by the analyzer, not gated by
// the operator-approved write gate (R2.3) that governs patterns. Persistence is
// append-only + deduped by traceId; the clock is INJECTED (entry.ts) for byte-stable
// tests. foldValidDigests() applies the validity filter ONLY — it does NOT promote;
// Block C re-applies the evidence floor to the folded digests (clean boundary, R2).

/** Load an entity's deep-read ledger from its own file, or [] when absent/corrupt. */
export function loadLedger(entityName: string, home?: string): DeepReadLedgerEntry[] {
  const slug = entitySlug(entityName);
  const p = deepReadLedgerPath(slug, home);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as DeepReadLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist an entity's deep-read ledger deterministically (stable JSON + trailing newline). */
function writeLedger(slug: string, entries: DeepReadLedgerEntry[], home?: string): void {
  ensureDir(entityDir(slug, home));
  writeFileSync(deepReadLedgerPath(slug, home), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * BLOCK G — true when the entity's ledger already holds a digest for `traceId`.
 * Existence check only — does NOT consider validity (a stale-but-present entry still
 * counts as ledgered). Callers that need validity use foldValidDigests().
 */
export function isLedgered(entityName: string, traceId: string, home?: string): boolean {
  return loadLedger(entityName, home).some((e) => e.traceId === traceId);
}

/**
 * BLOCK G — append deep-read digests to an entity's ledger, deduped by traceId. A new
 * entry whose traceId already exists REPLACES the prior entry (latest digest wins —
 * a re-read with a newer analyzerVersion/fingerprint/ts supersedes the stale one).
 * Append-only across distinct traceIds; existing-trace digests are upserted in place.
 * Returns the persisted ledger.
 */
export function recordLedger(
  entityName: string,
  entries: DeepReadLedgerEntry[],
  home?: string
): DeepReadLedgerEntry[] {
  const slug = entitySlug(entityName);
  const merged = loadLedger(entityName, home);
  for (const next of entries) {
    const idx = merged.findIndex((e) => e.traceId === next.traceId);
    if (idx === -1) merged.push(next);
    else merged[idx] = next; // dedupe by traceId — latest digest wins.
  }
  writeLedger(slug, merged, home);
  return merged;
}

export interface FoldValidOptions {
  /** Current analyzer version — entries stamped with a different version are invalid. */
  analyzerVersion: string;
  /** Current entity fingerprint — entries stamped with a different fingerprint are invalid. */
  entityFingerprint: string;
  /** INJECTED current time (ms epoch) for TTL checks — keeps the fold deterministic in tests. */
  nowMs: number;
  /** Max age before an entry is stale. Defaults to DEEP_READ_LEDGER_TTL_MS (~30d). */
  ttlMs?: number;
}

/**
 * BLOCK G — fold an entity's ledger down to the entries that are still VALID.
 *
 * An entry is INVALID (excluded → the trace re-admits for a fresh deep-read) when ANY:
 *   - entry.analyzerVersion  !== opts.analyzerVersion   (analyzer logic changed)
 *   - entry.entityFingerprint !== opts.entityFingerprint (entity changed under it)
 *   - opts.nowMs - Date.parse(entry.ts) > ttlMs          (digest aged out)
 *
 * An entry with an unparseable ts is treated as INVALID (fail-stale, never fail-fresh).
 *
 * BOUNDARY (R2): this returns version-stamped digests + validity filtering ONLY. It does
 * NOT decide promotion — Block C re-applies the evidence floor to these. Keep it clean.
 */
export function foldValidDigests(
  entityName: string,
  opts: FoldValidOptions,
  home?: string
): DeepReadLedgerEntry[] {
  const ttlMs = opts.ttlMs ?? DEEP_READ_LEDGER_TTL_MS;
  return loadLedger(entityName, home).filter((e) => {
    if (e.analyzerVersion !== opts.analyzerVersion) return false;
    if (e.entityFingerprint !== opts.entityFingerprint) return false;
    const tsMs = Date.parse(e.ts);
    if (Number.isNaN(tsMs)) return false; // fail-stale on a corrupt timestamp.
    if (opts.nowMs - tsMs > ttlMs) return false;
    return true;
  });
}

/**
 * BLOCK G — targeted poison removal: drop the ledger entry for `traceId` so the trace
 * re-admits for a fresh deep-read on the next run. Returns true when an entry was
 * removed, false when none matched. Persists only when a change occurred.
 */
export function invalidateEntry(entityName: string, traceId: string, home?: string): boolean {
  const slug = entitySlug(entityName);
  const ledger = loadLedger(entityName, home);
  const next = ledger.filter((e) => e.traceId !== traceId);
  if (next.length === ledger.length) return false;
  writeLedger(slug, next, home);
  return true;
}

// ── UNIFIED VERDICT LEDGER — finding-verdict MEMORY (both polarities) ─────────
//
// The verdict ledger records BOTH polarities per entity: findings the operator
// APPROVED (valid) and findings the operator DISMISSED (not-an-issue → suppress). It
// is the runtime finding-verdict memory and the audit trail for suppressions (there is
// NO visible "Suppressed" report section — the ledger IS the trail). Persisted in its
// OWN file (verdict-ledger.json) so the approved-only entity.json write gate stays clean
// and the approve→pattern promote is byte-unchanged. Deterministic: stable JSON, clock
// INJECTED (entry.ts). NEVER-EXPIRE: a dismissal has no TTL — foldValidDismissals()
// invalidates ONLY on an entity-fingerprint change (config-change), never by age.

/** The input to recordVerdict — one operator verdict on a finding (either polarity). */
export interface VerdictInput {
  entityName: string;
  verdict: VerdictPolarity;
  findingId: string;
  what: string;
  why: string;
  where: string;
  whatHappened?: string;
  /** Severity when the verdict was cast — the enrich §escalation guard baseline. */
  severityAtDismissal: VerdictSeverity;
  /** Entity fingerprint at verdict time — a change invalidates the verdict (config-change). */
  entityFingerprint: string;
  reason?: string;
  operatorInvocation?: string;
  runId: string;
  /** INJECTED ISO8601 timestamp — keeps writes deterministic in tests. */
  nowIso: string;
}

/** Load an entity's verdict ledger from its own file, or [] when absent/corrupt. */
export function loadVerdictLedger(entityName: string, home?: string): VerdictLedgerEntry[] {
  const slug = entitySlug(entityName);
  const p = verdictLedgerPath(slug, home);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as VerdictLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist an entity's verdict ledger deterministically (stable JSON + trailing newline). */
function writeVerdictLedger(slug: string, entries: VerdictLedgerEntry[], home?: string): void {
  ensureDir(entityDir(slug, home));
  writeFileSync(verdictLedgerPath(slug, home), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** Stable dedupe key for a verdict entry — one verdict per (polarity, run, finding). */
function verdictKey(e: Pick<VerdictLedgerEntry, "verdict" | "runId" | "findingId">): string {
  return `${e.verdict}:${e.runId}:${e.findingId}`;
}

/**
 * Record an operator verdict (approved OR dismissed) into the unified verdict ledger,
 * deduped by (polarity, runId, findingId) — re-persisting the same copy-back is
 * idempotent (latest wins). Append-only across distinct verdicts. Returns the persisted
 * ledger. Writes verdict-ledger.json ONLY (no journal touch — approve stays byte-clean).
 */
export function recordVerdict(input: VerdictInput, home?: string): VerdictLedgerEntry[] {
  const slug = entitySlug(input.entityName);
  const merged = loadVerdictLedger(input.entityName, home);
  const entry: VerdictLedgerEntry = {
    verdict: input.verdict,
    findingId: input.findingId,
    entitySlug: slug,
    what: input.what,
    why: input.why,
    where: input.where,
    ...(input.whatHappened !== undefined ? { whatHappened: input.whatHappened } : {}),
    severityAtDismissal: input.severityAtDismissal,
    entityFingerprint: input.entityFingerprint,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.operatorInvocation !== undefined ? { operatorInvocation: input.operatorInvocation } : {}),
    runId: input.runId,
    ts: input.nowIso,
  };
  const key = verdictKey(entry);
  const idx = merged.findIndex((e) => verdictKey(e) === key);
  if (idx === -1) merged.push(entry);
  else merged[idx] = entry; // idempotent re-persist — latest wins.
  writeVerdictLedger(slug, merged, home);
  return merged;
}

/** Load only the DISMISSED verdicts for an entity (the suppression source). */
export function loadDismissedVerdicts(entityName: string, home?: string): VerdictLedgerEntry[] {
  return loadVerdictLedger(entityName, home).filter((e) => e.verdict === "dismissed");
}

export interface FoldDismissalsOptions {
  /** Current entity fingerprint — entries stamped with a different fingerprint are void. */
  entityFingerprint: string;
}

/**
 * Fold an entity's DISMISSED verdicts down to the entries that are still VALID.
 *
 * NEVER-EXPIRE (operator decision): a dismissal has NO TTL. The ONLY invalidation is an
 * entity-fingerprint change — when the agent's prompt/config changed under the dismissal
 * (`entry.entityFingerprint !== opts.entityFingerprint`), the old "not-an-issue" verdict
 * is void and the finding re-admits. This reuses the foldValidDigests fingerprint
 * discipline WITHOUT the age branch (no time-based expiry, ever).
 *
 * The OTHER un-hide path — severity-escalation — is NOT here: it depends on the CURRENT
 * finding's severity, which the store does not see. It lives in the enrich partition
 * (enrich/dismissal-match.ts partitionByDismissal), which runs BEFORE the semantic match.
 */
export function foldValidDismissals(
  entityName: string,
  opts: FoldDismissalsOptions,
  home?: string
): VerdictLedgerEntry[] {
  return loadDismissedVerdicts(entityName, home).filter(
    (e) => e.entityFingerprint === opts.entityFingerprint
  );
}

/**
 * Targeted un-dismiss: drop the DISMISSED verdict(s) for `findingId` so a matching
 * finding re-admits on the next run. Approved verdicts for the same findingId are left
 * intact. Returns true when ≥1 entry was removed. Persists only when a change occurred.
 */
export function invalidateVerdict(entityName: string, findingId: string, home?: string): boolean {
  const slug = entitySlug(entityName);
  const ledger = loadVerdictLedger(entityName, home);
  const next = ledger.filter((e) => !(e.verdict === "dismissed" && e.findingId === findingId));
  if (next.length === ledger.length) return false;
  writeVerdictLedger(slug, next, home);
  return true;
}

// ── CLI entrypoint — persist a verdict from the copy-back (Step 11.5) ─────────
//
// The orchestrator parses the pasted `## Invalid findings` block and, per dismissed
// finding, calls this to land the verdict in the unified ledger. Injects the run-context
// provenance (runId · ts · operatorInvocation · entityFingerprint) the report cannot know.
//
// Usage: scripts/cli/run.sh scripts/library/store.ts
//   --config-root <path>   host project root (where .mutagent/diagnostics/ lives; default cwd)
//   --verdict <json>       a full VerdictInput JSON (entityName + verdict + triple + provenance)
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configRoot = get("--config-root") ?? process.cwd();
  const verdictJson = get("--verdict");
  if (!verdictJson) {
    process.stderr.write("Usage: store.ts --config-root <path> --verdict <VerdictInput json>\n");
    process.exit(1);
  }
  let input: VerdictInput;
  try {
    input = JSON.parse(verdictJson) as VerdictInput;
  } catch (e) {
    process.stderr.write(`Invalid --verdict JSON: ${e}\n`);
    process.exit(1);
  }
  const ledger = recordVerdict(input, configRoot);
  process.stdout.write(JSON.stringify({ entity: input.entityName, count: ledger.length }, null, 2) + "\n");
  process.exit(0);
}
