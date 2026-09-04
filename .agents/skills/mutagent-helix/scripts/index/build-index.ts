/**
 * scripts/index/build-index.ts
 * F4 — the `.mutagent/index.md` spec ↔ implementation REGISTRY writer (build core).
 * Type A — Pure core (data → model) + a thin INJECTED-I/O regenerate wrapper.
 *
 * WHAT this is: one deterministic writer that regenerates a single `.mutagent/index.md`
 * linking each registered AgentSpec to everything that realizes it — HIGH-LEVEL ONLY:
 * spec identity · stage · verdict · build target + LINKS to implementation code and
 * context docs, stamped with `spec_version` + an injected `updated` date.
 *
 * ANTI-DRIFT (LOAD-BEARING): the index carries identity + stage/verdict + version/date +
 * LINKS ONLY. It NEVER restates eval criteria / scenarios / dataset detail — that lives in
 * the evaluator's living-suite; duplicating it here is a drift + maintenance burden. The
 * index only points; it never copies.
 *
 * DETERMINISM (mirrors mutagent-diagnostics `store.ts` regenerateIndex):
 *   - entries sorted by spec_id · code/context links sorted by path · deduped
 *   - the ONLY non-determinism (the `updated` date) is INJECTED by the caller (nowIso)
 *   - pure `buildIndexModel` (no I/O, no clock) + pure `renderIndex` (render-index.ts)
 *   - `regenerateIndex` takes an INJECTED IndexIo seam → byte-stable tests with no disk
 *
 * The rendered markdown IS the machine surface — no sidecar JSON. See render-index.ts for
 * the exact layout and references/index-registry.md for the update-point convention.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  MUTAGENT_DIR,
  STAGE_DIRS,
  mutagentDir,
  stageDir,
  resolveConfigRoot,
} from "../resolve-paths.ts";
import { renderIndex } from "./render-index.ts";

// ── Model ────────────────────────────────────────────────────────────────────

/** A link to an implementation file that realizes an agent (from a target `code_refs[]`). */
export interface IndexCodeLink {
  /** Project-root-relative path (config determinism: never absolute). */
  path: string;
  /** WHY this file matters (verbatim from the config `code_refs[].why`). */
  why: string;
}

/** A link to a context / product doc (from `global.context[]`). */
export interface IndexContextLink {
  /** Project-root-relative path. */
  path: string;
  what: string;
  why: string;
  when: string;
}

/** One agent's HIGH-LEVEL registry entry. Links only — no eval detail. */
export interface IndexEntry {
  /** Display name — `definition.identity.name`, falling back to the spec_id. */
  name: string;
  /** The stable identity anchor `meta.spec_id` (also the sort key). */
  specId: string;
  /** `meta.spec_version`. */
  specVersion: string;
  /**
   * Where in the ADL loop the spec sits. Read from the internal `status.adl_stage` stamp
   * (agentspec ORCH-07 / R7); when the card carries no stamp, DERIVED from artifact presence
   * (spec→build report→eval suite); `"unknown"` when neither is available.
   */
  stage: string;
  /** `status.last_verdict` (stage-qualified, e.g. "evaluate:PASS"), or null when none yet. */
  lastVerdict: string | null;
  /** `.mutagent/`-relative link to the spec file: `specs/<id>/agentspec.yaml`. */
  specPath: string;
  /** `build.{target_framework, runtime}`, or null when the spec has no build block. */
  build: { targetFramework: string; runtime: string } | null;
  /** Implementation links (config `global.targets[].code_refs`), sorted + deduped by path. */
  codeRefs: IndexCodeLink[];
  /** Context / product doc links (`global.context[]`), sorted by path. */
  contextLinks: IndexContextLink[];
}

/** The whole index — an injected `updated` date + spec_id-sorted entries. */
export interface IndexModel {
  /** Injected `updated` date, formatted YYYY-MM-DD. */
  updated: string;
  entries: IndexEntry[];
}

/** A parsed spec keyed by its on-disk directory id (the spec_id dir under `.mutagent/specs`). */
export interface LoadedSpec {
  /** The on-disk directory name (canonically the spec_id). Drives the spec link path. */
  id: string;
  /** The parsed agentspec.yaml (unknown — defensively narrowed here). */
  spec: unknown;
  /**
   * Loop position DERIVED from artifact presence (spec→build report→eval suite), used ONLY as the
   * fallback when the card carries no `status.adl_stage`. Computed by the IO layer in
   * `regenerateIndex` (pure `deriveLoopPosition`); `null`/absent when not derivable.
   */
  derivedStage?: string | null;
}

/** Which realized artifacts exist for a subject — the deterministic loop-position derivation inputs. */
export interface ArtifactPresence {
  /** The agentspec.yaml itself exists (always true once a spec row is loaded). */
  hasSpec: boolean;
  /** A build report artifact exists under `.mutagent/<specId>/`. */
  hasBuildReport: boolean;
  /** An eval suite artifact exists for the subject (`.mutagent/evaluator/**`). */
  hasEvalSuite: boolean;
}

/**
 * Derive the ADL loop position from artifact presence — the FURTHEST-along stage whose artifact
 * exists (eval suite → "evaluate", else build report → "build", else spec → "spec"). Pure +
 * deterministic; the fallback for a card with no `status.adl_stage`. `null` when nothing exists.
 */
export function deriveLoopPosition(p: ArtifactPresence): string | null {
  if (p.hasEvalSuite) return "evaluate";
  if (p.hasBuildReport) return "build";
  if (p.hasSpec) return "spec";
  return null;
}

export interface BuildIndexInput {
  specs: LoadedSpec[];
  /** The parsed `.mutagent/config.yaml` (unknown — the code_refs + context source). */
  config: unknown;
  /** INJECTED ISO8601 timestamp — the `updated` stamp is `nowIso.slice(0,10)`. */
  nowIso: string;
}

// ── Defensive narrowing helpers (no cross-package schema import — standalone rule) ──

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ── Config extraction (code_refs + context — the realized-impl + doc links) ─────

/**
 * Pull every target's `code_refs` from `global.targets[]`, flatten, dedupe by path
 * (first `why` wins), and sort by path. These are the realized implementation links
 * shared across the install (per PR-013 the spec never enumerates its own impls, so the
 * config's targets are the impl-link source of truth).
 */
export function extractCodeRefs(config: unknown): IndexCodeLink[] {
  const global = asRecord(asRecord(config)?.global);
  const targets = asArray(global?.targets);
  const byPath = new Map<string, IndexCodeLink>();
  for (const t of targets) {
    const refs = asArray(asRecord(t)?.code_refs);
    for (const r of refs) {
      const rec = asRecord(r);
      const p = asString(rec?.path);
      if (!p) continue;
      if (!byPath.has(p)) {
        byPath.set(p, { path: p, why: asString(rec?.why) ?? "" });
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Pull `global.context[]` context links, sorted by path. */
export function extractContextLinks(config: unknown): IndexContextLink[] {
  const global = asRecord(asRecord(config)?.global);
  const context = asArray(global?.context);
  const links: IndexContextLink[] = [];
  for (const c of context) {
    const rec = asRecord(c);
    const p = asString(rec?.path);
    if (!p) continue;
    links.push({
      path: p,
      what: asString(rec?.what) ?? "",
      why: asString(rec?.why) ?? "",
      when: asString(rec?.when) ?? "",
    });
  }
  return links.sort((a, b) => a.path.localeCompare(b.path));
}

// ── Spec extraction ────────────────────────────────────────────────────────────

/**
 * Narrow one parsed agentspec into an IndexEntry. Reads HIGH-LEVEL fields only —
 * meta identity + loop_state + build — plus the shared config-sourced code/context links.
 * Tolerant of missing fields (fall back to the dir id / sensible placeholders) so a
 * partially-written spec still lands a row rather than crashing the whole regen.
 */
export function buildEntry(
  loaded: LoadedSpec,
  codeRefs: IndexCodeLink[],
  contextLinks: IndexContextLink[],
): IndexEntry {
  const spec = asRecord(loaded.spec);
  const meta = asRecord(spec?.meta);
  const status = asRecord(spec?.status); // internal 0.3.0 loop-state stamp (ORCH-07 / R7)
  const definition = asRecord(spec?.definition);
  const identity = asRecord(definition?.identity);
  const build = asRecord(spec?.build);

  const specId = asString(meta?.spec_id) ?? loaded.id;
  const targetFramework = asString(build?.target_framework);

  return {
    name: asString(identity?.name) ?? specId,
    specId,
    specVersion: asString(meta?.spec_version) ?? "unknown",
    // Loop position: the card's own `status.adl_stage` wins; else the artifact-derived fallback; else unknown.
    stage: asString(status?.adl_stage) ?? loaded.derivedStage ?? "unknown",
    lastVerdict: asString(status?.last_verdict),
    // Link path uses the on-disk dir id (disk truth), not the parsed spec_id.
    specPath: `${STAGE_DIRS.specs}/${loaded.id}/agentspec.yaml`,
    build: targetFramework
      ? { targetFramework, runtime: asString(build?.runtime) ?? "—" }
      : null,
    codeRefs,
    contextLinks,
  };
}

/**
 * Build the whole index model from parsed specs + config + an injected clock. PURE:
 * no I/O, no `Date.now()`. Entries are sorted by spec_id for deterministic output.
 */
export function buildIndexModel(input: BuildIndexInput): IndexModel {
  const codeRefs = extractCodeRefs(input.config);
  const contextLinks = extractContextLinks(input.config);
  const entries = input.specs
    .map((s) => buildEntry(s, codeRefs, contextLinks))
    .sort((a, b) => a.specId.localeCompare(b.specId));
  return { updated: input.nowIso.slice(0, 10), entries };
}

// ── Injected I/O seam (byte-stable tests with no disk) ──────────────────────────

/**
 * The file-system seam `regenerateIndex` depends on. The live binding uses `node:fs`;
 * tests inject an in-memory fake so a full regenerate round-trips WITHOUT touching disk.
 */
export interface IndexIo {
  /** List the spec directories directly under `<root>/.mutagent/specs` (dir names only). */
  listSpecDirs(specsRoot: string): string[];
  /** Read `<specsRoot>/<specId>/agentspec.yaml`, or null when absent. */
  readSpec(specsRoot: string, specId: string): string | null;
  /** Read `<root>/.mutagent/config.yaml`, or null when absent. */
  readConfig(configFile: string): string | null;
  /** Write the regenerated `<root>/.mutagent/index.md`. */
  writeIndex(indexFile: string, content: string): void;
  /** Does a build report exist under `<root>/.mutagent/<specId>/`? (artifact-derivation fallback) */
  hasBuildReport?(root: string, specId: string): boolean;
  /** Does an eval suite exist for the subject under `<root>/.mutagent/evaluator/**`? */
  hasEvalSuite?(root: string, specId: string): boolean;
}

/** Live IndexIo — binds real `node:fs`. */
export const liveIo: IndexIo = {
  listSpecDirs(specsRoot: string): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(specsRoot);
    } catch {
      return [];
    }
    return names.filter((n) => {
      try {
        return fs.statSync(path.join(specsRoot, n)).isDirectory();
      } catch {
        return false;
      }
    });
  },
  readSpec(specsRoot: string, specId: string): string | null {
    const p = path.join(specsRoot, specId, "agentspec.yaml");
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  readConfig(configFile: string): string | null {
    try {
      return fs.readFileSync(configFile, "utf8");
    } catch {
      return null;
    }
  },
  writeIndex(indexFile: string, content: string): void {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, content, "utf8");
  },
  hasBuildReport(root: string, specId: string): boolean {
    const dir = path.join(mutagentDir(root), specId);
    try {
      return fs
        .readdirSync(dir)
        .some((n) => /(?:^|[-.])(?:build-)?(?:report|verdict)\.(?:md|json|html)$/i.test(n));
    } catch {
      return false;
    }
  },
  hasEvalSuite(root: string, specId: string): boolean {
    const living = path.join(mutagentDir(root), "evaluator", "living-suite");
    try {
      if (fs.readdirSync(living).length > 0) return true;
    } catch {
      /* no living-suite */
    }
    try {
      return fs.statSync(path.join(mutagentDir(root), "evaluator", specId)).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface RegenerateResult {
  /** Absolute path to the written `.mutagent/index.md`. */
  indexFile: string;
  /** The exact bytes written (returned for round-trip assertions). */
  content: string;
}

/**
 * Regenerate `<root>/.mutagent/index.md` from every `agentspec.yaml` under
 * `<root>/.mutagent/specs/*` + the install config. DETERMINISTIC given (disk state, nowIso):
 * re-running with the same inputs writes byte-identical output. The clock is INJECTED; the
 * fs is INJECTED (defaults to `liveIo`). A spec whose YAML fails to parse is SKIPPED (its
 * row is dropped rather than crashing the whole regen — fail-soft per-entry).
 */
export function regenerateIndex(
  root: string,
  nowIso: string,
  io: IndexIo = liveIo,
): RegenerateResult {
  const specsRoot = stageDir(root, STAGE_DIRS.specs);
  const configFile = path.join(mutagentDir(root), "config.yaml");
  const indexFile = path.join(mutagentDir(root), "index.md");

  const specs: LoadedSpec[] = [];
  for (const id of io.listSpecDirs(specsRoot)) {
    const raw = io.readSpec(specsRoot, id);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue; // fail-soft: a malformed spec drops its row, never the whole index.
    }
    // Loop-position fallback (used only when the card carries no status.adl_stage) — derived
    // deterministically from artifact presence via the injected IO probes.
    const derivedStage = deriveLoopPosition({
      hasSpec: true,
      hasBuildReport: io.hasBuildReport?.(root, id) ?? false,
      hasEvalSuite: io.hasEvalSuite?.(root, id) ?? false,
    });
    specs.push({ id, spec: parsed, derivedStage });
  }

  const configRaw = io.readConfig(configFile);
  let config: unknown = null;
  if (configRaw !== null) {
    try {
      config = parseYaml(configRaw);
    } catch {
      config = null; // no config links rather than a crash.
    }
  }

  const model = buildIndexModel({ specs, config, nowIso });
  const content = renderIndex(model);
  io.writeIndex(indexFile, content);
  return { indexFile, content };
}

// ── CLI — regenerate the index for the resolved (or supplied) install root ──────
//
//   bun run scripts/index/build-index.ts [root] [--now <ISO8601>]
//
// `root` defaults to the resolved `.mutagent/` install root. `--now` overrides the
// clock (deterministic scripting / reproducing a stamp); default is the wall clock.

function runCli(argv: string[]): number {
  const args = argv.slice(2);
  const nowFlagIdx = args.indexOf("--now");
  const nowIso =
    nowFlagIdx >= 0 && args[nowFlagIdx + 1]
      ? (args[nowFlagIdx + 1] as string)
      : new Date().toISOString();
  const positional = args.find((a, i) => !a.startsWith("--") && i !== nowFlagIdx + 1);
  const root = positional ? path.resolve(positional) : resolveConfigRoot();

  const { indexFile } = regenerateIndex(root, nowIso);
  console.info(`[build-index] wrote ${indexFile} (root: ${path.join(root, MUTAGENT_DIR)})`);
  return 0;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
