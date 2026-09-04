/**
 * scripts/config/resolve-spec-dir.ts
 * The `*spec` OUTPUT-DIR resolver — decides WHERE the interview writes `agentspec.yaml`.
 * Type A — Pure Script (a pure resolver + a thin guarded CLI).
 *
 * Resolution precedence (first non-empty wins):
 *   1. flag      — an explicit `--spec-dir <path>` / caller override (highest authority)
 *   2. config    — `lifecycle.agentspec.spec_dir` in `<root>/.mutagent/config.yaml`
 *   3. default   — `.mutagent/specs` (the canonical tree; specs/<spec_id>/agentspec.yaml)
 *
 * ZERO-CONFIG is a first-class case: `*spec` MUST run with no `.mutagent/config.yaml` at all.
 * A missing config file, a config without a `lifecycle.agentspec` block, or a block without
 * `spec_dir` ALL fall through to the default. Only a genuinely present, non-empty string in the
 * config overrides the default.
 *
 * MINIMAL BY DESIGN (do not over-build): this reads ONLY `parsed.lifecycle.agentspec?.spec_dir`.
 * It is NOT a full config schema port — agentspec stays standalone and never cross-imports the
 * orchestrator's config-schema (the standalone + symbiosis invariant). The one field the orchestrator
 * TYPES for this skill (`lifecycle.agentspec.spec_dir`, an optional string) is the only thing read.
 *
 * CONFIG FIELD — `lifecycle.agentspec.spec_dir` (optional string):
 *   CONSUMER: THIS resolver (`resolveSpecOutputDir` → `readSpecDirFromConfig`), invoked by the
 *             agentspec `*spec` interview to pick its write root. No other skill reads it.
 *   PURPOSE:  precedence tier 2 — overrides the default `.mutagent/specs` tree so an operator can
 *             relocate where `agentspec.yaml` lands (e.g. a monorepo-shared specs dir). A relative
 *             value anchors at the config root; an absolute value is honored as-is; absent/blank ⇒
 *             the default (zero-config stays first-class). Never a secret — a plain path string.
 *
 * The config ROOT is the nearest ancestor of `startDir` that already contains a `.mutagent/`
 * directory (mirrors the orchestrator's resolve-paths.ts `findConfigRoot`); when none exists the
 * start dir is used (first-run friendly — that is where `init` will create `.mutagent/`). The
 * default `spec_dir` is resolved RELATIVE to that root; a relative config value is likewise anchored
 * at the root, an absolute config value is honored as-is.
 *
 * Usage: scripts/cli/run.sh scripts/config/resolve-spec-dir.ts [--spec-dir <path>] [startDir]
 *   Prints the resolved absolute output directory + the source that won (flag|config|default).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/** The single local root dir name. Never `~/.mutagent`. (mirrors resolve-paths.ts) */
export const MUTAGENT_DIR = ".mutagent" as const;

/** The default `spec_dir` when config is absent/optional — relative to the config root. */
export const DEFAULT_SPEC_DIR = path.join(MUTAGENT_DIR, "specs");

/** Which input won the resolution — surfaced so the CLI + callers can report precedence. */
export type SpecDirSource = "flag" | "config" | "default";

export interface ResolvedSpecDir {
  /** The resolved output directory, absolute. `*spec` writes `<dir>/<spec_id>/agentspec.yaml`. */
  dir: string;
  /** Which precedence tier supplied the value. */
  source: SpecDirSource;
  /** The install/config root the default (and any relative value) was anchored at. */
  root: string;
}

/** Minimal injectable fs surface — keeps the resolver pure + deterministically testable. */
export interface ResolveFs {
  /** True iff `p` exists and is a directory (used to find the `.mutagent/` root). */
  dirExists: (p: string) => boolean;
  /** True iff `p` exists and is a readable file (the config file). */
  fileExists: (p: string) => boolean;
  /** Read a UTF-8 file (only called when `fileExists` is true). */
  readText: (p: string) => string;
}

/** Live fs binding — real `node:fs`, for the CLI + production callers. */
export const liveFs: ResolveFs = {
  dirExists: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  fileExists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText: (p) => fs.readFileSync(p, "utf-8"),
};

/**
 * Walk UP from `startDir` to the nearest ancestor that already contains a `.mutagent/` directory;
 * return that ancestor (the install/init root). If none is found, return the resolved `startDir`
 * (first run — `init` creates `.mutagent/` there). Pure: directory existence is injected.
 * Mirrors the orchestrator resolve-paths.ts `findConfigRoot` (NOT imported — standalone invariant).
 */
export function findConfigRoot(startDir: string, dirExists: (p: string) => boolean): string {
  let dir = path.resolve(startDir);
  // Bounded by the filesystem root — path.dirname("/") === "/" terminates the loop.
  for (;;) {
    if (dirExists(path.join(dir, MUTAGENT_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Read ONLY `lifecycle.agentspec.spec_dir` out of a config YAML string. Returns the trimmed string
 * when present + non-empty, else `undefined`. NEVER throws: a YAML parse error, a non-object shape,
 * a missing `lifecycle`/`agentspec` block, or a non-string / blank `spec_dir` all yield `undefined`
 * (→ the caller falls back to the default). This is the whole "config loader" — minimal by design.
 */
export function readSpecDirFromConfig(configText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(configText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const lifecycle = (parsed as Record<string, unknown>).lifecycle;
  if (lifecycle === null || typeof lifecycle !== "object") return undefined;
  const agentspec = (lifecycle as Record<string, unknown>).agentspec;
  if (agentspec === null || typeof agentspec !== "object") return undefined;
  const specDir = (agentspec as Record<string, unknown>).spec_dir;
  if (typeof specDir !== "string") return undefined;
  const trimmed = specDir.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Anchor a spec-dir value at the config root: absolute values pass through, relative anchor at root. */
function anchor(root: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

export interface ResolveSpecOutputDirOptions {
  /** Where resolution starts (find the `.mutagent/` root from here). Defaults to process.cwd(). */
  startDir?: string;
  /** An explicit override (precedence tier 1) — e.g. from a `--spec-dir` flag. */
  flag?: string;
  /** Injected fs surface — defaults to the live `node:fs` binding. */
  fsImpl?: ResolveFs;
}

/**
 * Resolve the `*spec` output directory. Precedence: flag > config > default (`.mutagent/specs`).
 * Pure w.r.t. the injected `fsImpl`; the default binding hits real `node:fs`.
 */
export function resolveSpecOutputDir(options: ResolveSpecOutputDirOptions = {}): ResolvedSpecDir {
  const startDir = options.startDir ?? process.cwd();
  const fsImpl = options.fsImpl ?? liveFs;

  const root = findConfigRoot(startDir, fsImpl.dirExists);

  // Tier 1 — an explicit flag/override always wins.
  const flag = options.flag?.trim();
  if (flag !== undefined && flag.length > 0) {
    return { dir: anchor(root, flag), source: "flag", root };
  }

  // Tier 2 — the config value, iff a config file exists AND carries a non-empty spec_dir.
  const configFile = path.join(root, MUTAGENT_DIR, "config.yaml");
  if (fsImpl.fileExists(configFile)) {
    const fromConfig = readSpecDirFromConfig(fsImpl.readText(configFile));
    if (fromConfig !== undefined) {
      return { dir: anchor(root, fromConfig), source: "config", root };
    }
  }

  // Tier 3 — the default. Zero-config path lands here.
  return { dir: anchor(root, DEFAULT_SPEC_DIR), source: "default", root };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function runCli(argv: string[]): number {
  const args = argv.slice(2);
  const flagIdx = args.indexOf("--spec-dir");
  const flag = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
  // The first non-flag positional (skipping the flag itself + its value) is the startDir override.
  const flagValueIdx = flagIdx >= 0 ? flagIdx + 1 : -1;
  const positional = args.find(
    (a, i) => !a.startsWith("--") && i !== flagIdx && i !== flagValueIdx,
  );

  const resolved = resolveSpecOutputDir({ startDir: positional, flag });
  console.info(`[resolve-spec-dir] dir:    ${resolved.dir}`);
  console.info(`[resolve-spec-dir] source: ${resolved.source}`);
  console.info(`[resolve-spec-dir] root:   ${resolved.root}`);
  return 0;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
