// ---------------------------------------------------------------------------
// dogfood/resolve-subagents — DOG-2: resolve the dispatched-subagent session
// JSONLs for a main Helix session, so `reconstruct-trajectory` (which already
// accepts `subagentPaths`) can ingest them (today it saw `subagents=0`).
//
// LINKAGE (see the DOG-2 ADR in monitoring-system-design.md). Verified against
// the local Claude-projects store: this Claude Code build persists NO
// `isSidechain:true` lines and NO `Task` tool_use in the parent transcript, so
// there is no in-file parent→child pointer to follow TODAY. We therefore resolve
// by a precedence chain, favouring what the dogfood target actually produces:
//
//   (1) per-session convention dir  <source_dir>/subagents/<sessionId>/*.jsonl
//   (2) flat convention dir         <source_dir>/subagents/*.jsonl
//   (3) sidechain siblings          <source_dir>/*.jsonl (≠ main) whose entries
//                                   carry `isSidechain:true` AND a `parentUuid`
//                                   that roots in the MAIN session's uuids
//                                   (forward-compatible for a Claude Code build
//                                   that DOES colocate sidechain files).
//
// (3) is best-effort + precise: a sibling is linked ONLY when a parentUuid
// actually matches a main-session uuid — never by mere co-location (no
// cross-session bleed). The whole resolver is gated by `include_subagents`
// (default true). PURITY: `selectSidechainSiblings` is pure; the file wrapper
// `resolveSubagentPaths` does the ONLY I/O (dir listing + a raw uuid scan).
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Raw linkage facts scanned from ONE session JSONL (cheap, adapter-free). */
export interface SessionLinkage {
  /** Absolute path of the scanned file. */
  path: string;
  /** Every `parentUuid` seen across the file's entries (non-null). */
  parentUuids: string[];
  /** True if ANY entry carried `isSidechain:true`. */
  isSidechain: boolean;
}

/**
 * PURE core: from the MAIN session's uuid set + pre-scanned sibling linkages,
 * select the sibling paths that are dispatched subagents of THIS session — a
 * sidechain file with a `parentUuid` rooting in `mainUuids`. Deterministic
 * (sorted, de-duplicated). Never links by co-location alone.
 */
export function selectSidechainSiblings(args: {
  mainUuids: Set<string>;
  siblings: SessionLinkage[];
}): string[] {
  const linked = new Set<string>();
  for (const sib of args.siblings) {
    if (!sib.isSidechain) continue;
    if (sib.parentUuids.some((p) => args.mainUuids.has(p))) linked.add(sib.path);
  }
  return [...linked].sort();
}

/** List `*.jsonl` files (basenames) in a dir; missing/unreadable dir ⇒ []. */
function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

/** Scan one JSONL file for its linkage facts (uuids we ignore here; parents + sidechain). */
function scanLinkage(path: string): SessionLinkage {
  const out: SessionLinkage = { path, parentUuids: [], isSidechain: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let ev: { parentUuid?: string | null; isSidechain?: boolean };
    try {
      ev = JSON.parse(trimmed) as typeof ev;
    } catch {
      continue;
    }
    if (typeof ev.parentUuid === "string" && ev.parentUuid.length > 0) out.parentUuids.push(ev.parentUuid);
    if (ev.isSidechain === true) out.isSidechain = true;
  }
  return out;
}

/** Collect the set of `uuid`s emitted by one JSONL file (for sidechain rooting). */
function collectUuids(path: string): Set<string> {
  const uuids = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return uuids;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const ev = JSON.parse(trimmed) as { uuid?: string };
      if (typeof ev.uuid === "string" && ev.uuid.length > 0) uuids.add(ev.uuid);
    } catch {
      /* tolerant — skip unparseable lines */
    }
  }
  return uuids;
}

/** Inputs for the file-wrapper resolver. */
export interface ResolveSubagentsInput {
  /** The dogfood target's Claude-projects session dir. */
  sourceDir: string;
  /** The main session id (the `<sessionId>.jsonl` in `sourceDir`). */
  sessionId: string;
  /** config.dogfood.include_subagents (default true). */
  includeSubagents?: boolean;
}

/**
 * Resolve the dispatched-subagent JSONL paths for a main session by the
 * precedence chain above. Best-effort + honest: returns [] (never throws) when
 * disabled or when nothing links. The ONLY I/O in this module.
 */
export function resolveSubagentPaths(input: ResolveSubagentsInput): string[] {
  if (input.includeSubagents === false) return [];
  const { sourceDir, sessionId } = input;
  const found: string[] = [];

  // (1) per-session convention dir
  const perSessionDir = join(sourceDir, "subagents", sessionId);
  const perSession = listJsonl(perSessionDir).map((f) => join(perSessionDir, f));
  found.push(...perSession);

  // (2) flat convention dir (only when the per-session dir yielded nothing)
  if (perSession.length === 0) {
    const flatDir = join(sourceDir, "subagents");
    found.push(...listJsonl(flatDir).map((f) => join(flatDir, f)));
  }

  // (3) sidechain siblings in the source dir (forward-compatible best-effort)
  const mainFile = join(sourceDir, `${sessionId}.jsonl`);
  const siblingNames = listJsonl(sourceDir).filter((f) => f !== `${sessionId}.jsonl`);
  if (siblingNames.length > 0) {
    const siblings = siblingNames.map((f) => scanLinkage(join(sourceDir, f)));
    // only pay for the main uuid scan if a sibling actually looks like a sidechain
    if (siblings.some((s) => s.isSidechain)) {
      const mainUuids = collectUuids(mainFile);
      found.push(...selectSidechainSiblings({ mainUuids, siblings }));
    }
  }

  // de-dupe (a path can never satisfy two branches, but stay defensive) + stable order
  return [...new Set(found)].sort();
}
