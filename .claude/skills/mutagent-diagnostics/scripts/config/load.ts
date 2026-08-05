/**
 * scripts/config/load.ts
 * Load + parse the diagnostics config from the UNIFIED local `.mutagent/config.yaml`
 * (v0.2.0). Single source of truth (operator decision 2026-06-29).
 *
 * v0.2.0 config-shape break (plan PHASE 1 · Fork B HARD-CUT):
 *   - The diagnostics section moved from `parsed.diagnostics` → `parsed.lifecycle.diagnostics`.
 *   - `source` / `target` no longer live in that section — they are RESOLVED from
 *     the `global.sources[]` / `global.targets[]` catalog BY ROLE:
 *       source-consumer  → binds `global.sources` (one ⇒ auto; >1 ⇒ ambiguous)
 *       target-writer     → binds `global.targets` (one ⇒ auto; >1 ⇒ ambiguous)
 *     Ambiguity is NOT a hard fail — it is surfaced (`sourceAmbiguous`/`targetAmbiguous`)
 *     so the caller (onboarding) can disambiguate (Fork A: disambiguation deferred).
 *   - A LEGACY (pre-v0.2.0) config shape (`shared` / `stages` / a top-level
 *     `diagnostics` / a wrong `config_version`) yields `migrationRequired: true` and
 *     NO config — the old shape is NEVER parsed at runtime (Fork B).
 *
 * Secrets are NOT embedded — config holds only `credential_ref` (an env-var name or
 * `{env,path}`), resolved at use-time via resolve-credential.ts (env → .env → .mutagentrc).
 * Type A — Pure Script (deterministic YAML parse + sub-key extract; no clock/random/net).
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type {
  DiagnosticsConfig,
  GlobalSource,
  GlobalTarget,
} from "./schema.ts";

/** The FROZEN contract version this loader accepts (matches the orchestrator + evaluator). */
export const CONFIG_VERSION = "0.3.0" as const;

/** Versions accepted as LEGACY but parseable (no migration-required) — 0.2.0 configs
 *  keep working; pre-0.2.0 shapes hard-cut to migration-required. */
export const LEGACY_CONFIG_VERSIONS = ["0.1.0", "0.2.0"] as const;

/** Legacy top-level keys that must NOT appear in a v0.2.0 config. */
const LEGACY_TOP_LEVEL_KEYS = [
  "shared",
  "stages",
  "diagnostics",
  "evaluator",
] as const;

/**
 * SELECTION outcome tag for a role-bound catalog (source OR target). The precedence
 * that produces each tag is documented on `selectByRole` — it matches the orchestrator +
 * evaluator selection contract EXACTLY:
 *
 *   - "none"              — 0 entries in the catalog.
 *   - "bound"             — auto-bound with NO prompt: exactly one entry in the catalog,
 *                           OR an explicit `--source`/`--target` name match. The binding
 *                           is unambiguous — the run proceeds silently.
 *   - "resolved-default"  — F2 CONFIRM signal: >1 entry AND exactly one `default:true`.
 *                           The default is PRESELECTED (populated in `bound`), but the run
 *                           flow SHOULD confirm it ("use default `<X>`?") before proceeding
 *                           — distinct from `needs-selection` (pick-which). NON-FATAL for
 *                           gating (a source/target exists). `candidates` lists all names
 *                           so the operator may override the preselected default.
 *                           PARITY: mirrors the orchestrator's `resolved-default`.
 *   - "needs-selection"   — >1 entry, 0 `default:true`, no explicit name — the run flow
 *                           must PROMPT the operator to pick one (candidates listed).
 *   - "multiple-defaults" — >1 entry carries `default:true` — a CONFIG ERROR.
 *   - "unknown-name"      — an explicit `--source`/`--target` name matched no entry — an ERROR.
 */
export type SelectionStatus =
  | "none"
  | "bound"
  | "resolved-default"
  | "needs-selection"
  | "multiple-defaults"
  | "unknown-name";

export interface SelectionOutcome<T> {
  status: SelectionStatus;
  /**
   * The resolved entry — populated on `status: "bound"` (auto-bind) AND on
   * `status: "resolved-default"` (the PRESELECTED default, subject to a confirm).
   * Null on every other status.
   */
  bound: T | null;
  /**
   * Candidate `name`s for the operator to choose from. Populated on `resolved-default`
   * (all entries — the preselected default is in `bound`, the rest are override
   * options for the confirm ASK), `needs-selection` (all entries), `multiple-defaults`
   * (the offending default-flagged names), and `unknown-name` (the available names, so
   * the error can list valid choices).
   */
  candidates: string[];
  /** The explicit `--source`/`--target` name that failed to match (unknown-name only). */
  requestedName?: string;
}

/** Per-role selection override (from `--source <name>` / `--target <name>`). */
export interface RoleSelectors {
  /** Explicit source name from `--source` — bypasses default/prompt when it matches. */
  sourceName?: string;
  /** Explicit target name from `--target` — bypasses default/prompt when it matches. */
  targetName?: string;
}

export interface LoadResult {
  /** The `lifecycle.diagnostics` section (opaque skill knobs), or null when absent. */
  config: DiagnosticsConfig | null;
  /** The source resolved BY ROLE from `global.sources` (single/default/name), or null. */
  source: GlobalSource | null;
  /** The target resolved BY ROLE from `global.targets` (single/default/name), or null. */
  target: GlobalTarget | null;
  /**
   * DEPRECATED-shape compat: true when the source could NOT be auto-bound and >1 entry
   * exists (i.e. `needs-selection` OR `multiple-defaults`). Kept so pre-selection callers
   * keep working; prefer `sourceSelection.status` for the precise reason.
   */
  sourceAmbiguous: boolean;
  /** Same compat flag for the target catalog — see `sourceAmbiguous`. */
  targetAmbiguous: boolean;
  /** RICH source selection outcome (status + candidates) — see `SelectionOutcome`. */
  sourceSelection: SelectionOutcome<GlobalSource>;
  /** RICH target selection outcome (status + candidates) — see `SelectionOutcome`. */
  targetSelection: SelectionOutcome<GlobalTarget>;
  /** True when the config FILE exists (regardless of whether it has a diagnostics section). */
  exists: boolean;
  /**
   * HARD-CUT signal (Fork B): the file is a LEGACY (pre-v0.2.0) shape and was NOT
   * parsed. The caller routes this to `migration-required` (see references/config-migration.md).
   */
  migrationRequired: boolean;
  /** Legacy markers found (empty unless migrationRequired). */
  legacyMarkers: string[];
  error: string | null;
}

/** The unified config path under a project root: `<root>/.mutagent/config.yaml`. */
export function configPathFor(projectRoot: string): string {
  return resolve(projectRoot, ".mutagent", "config.yaml");
}

/**
 * Detect a LEGACY (pre-v0.2.0) config WITHOUT parsing its old shape. Two signals,
 * either fires: a non-frozen `config_version`, or any legacy top-level key
 * (`shared` / `stages` / top-level `diagnostics` / `evaluator`). Pure; tolerant of a
 * non-object input (returns []). Mirrors the orchestrator's `detectLegacyConfig`.
 */
export function detectLegacyShape(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  const markers: string[] = [];

  const version = o.config_version;
  if (version !== CONFIG_VERSION) {
    if (version === undefined) {
      markers.push(`config_version: absent (expected "${CONFIG_VERSION}")`);
    } else if (typeof version === "string" && (LEGACY_CONFIG_VERSIONS as readonly string[]).includes(version)) {
      // 0.1.0/0.2.0 are LEGACY but PARSEABLE — accepted without migration-required.
      // No marker: a legacy-but-parseable config is not a hard-cut.
    } else {
      markers.push(
        `config_version: ${JSON.stringify(version)} (legacy — expected "${CONFIG_VERSION}")`,
      );
    }
  }

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (key in o) markers.push(`legacy top-level key '${key}'`);
  }

  return markers;
}

/** Structural shape the selector needs off a catalog entry (source or target). */
interface Selectable {
  name: string;
  default?: boolean;
}

/**
 * Select ONE catalog entry BY ROLE per the SELECTION contract (parity with the
 * orchestrator + evaluator). Precedence, highest-first:
 *
 *   1. explicit `selectName` (from `--source`/`--target`) ⇒ find by name;
 *      not found ⇒ `unknown-name` (surface an error, list valid names).
 *   2. 0 entries              ⇒ `none`.
 *   3. exactly 1 entry        ⇒ `bound` (auto-bind, no prompt).
 *   4. >1 entries:
 *        - exactly one `default:true` ⇒ `resolved-default` (F2 CONFIRM: preselect the
 *          default in `bound`, but the run flow confirms it — "use default `<X>`?").
 *        - >1 `default:true`          ⇒ `multiple-defaults` (config error).
 *        - 0  `default:true`          ⇒ `needs-selection` (prompt; return names).
 *
 * F2 note: `resolved-default` is DISTINCT from `bound` — a single/explicit binding is
 * unambiguous (no prompt), whereas a default-among-many is preselected-but-confirmed.
 * Both keep a usable entry in `bound`, so both remain NON-FATAL for the onboarding gate.
 *
 * Pure + deterministic. Never throws — every branch is a typed outcome.
 */
function selectByRole<T extends Selectable>(
  catalog: T[] | undefined,
  selectName?: string,
): SelectionOutcome<T> {
  const entries = Array.isArray(catalog) ? catalog : [];
  const names = entries.map((e) => e.name);

  // 1. Explicit name override wins outright (default flags + count are irrelevant).
  if (selectName !== undefined) {
    const hit = entries.find((e) => e.name === selectName);
    if (hit) return { status: "bound", bound: hit, candidates: names };
    return {
      status: "unknown-name",
      bound: null,
      candidates: names,
      requestedName: selectName,
    };
  }

  // 2. Empty catalog.
  if (entries.length === 0) return { status: "none", bound: null, candidates: [] };

  // 3. Single entry auto-binds.
  if (entries.length === 1) {
    return { status: "bound", bound: entries[0]!, candidates: names };
  }

  // 4. Multiple entries — disambiguate via `default`.
  const defaults = entries.filter((e) => e.default === true);
  if (defaults.length === 1) {
    // F2: preselect the default, but SIGNAL a confirm (distinct from a silent bind).
    // `candidates` carries every name so the confirm ASK can offer an override.
    return { status: "resolved-default", bound: defaults[0]!, candidates: names };
  }
  if (defaults.length > 1) {
    return {
      status: "multiple-defaults",
      bound: null,
      candidates: defaults.map((e) => e.name),
    };
  }
  return { status: "needs-selection", bound: null, candidates: names };
}

/** A "no catalog present" selection outcome (used by emptyResult defaults). */
function noneOutcome<T>(): SelectionOutcome<T> {
  return { status: "none", bound: null, candidates: [] };
}

function emptyResult(overrides: Partial<LoadResult>): LoadResult {
  return {
    config: null,
    source: null,
    target: null,
    sourceAmbiguous: false,
    targetAmbiguous: false,
    sourceSelection: noneOutcome<GlobalSource>(),
    targetSelection: noneOutcome<GlobalTarget>(),
    exists: false,
    migrationRequired: false,
    legacyMarkers: [],
    error: null,
    ...overrides,
  };
}

/**
 * Load the diagnostics config from `<root>/.mutagent/config.yaml` (v0.2.0):
 *   - reads the section at `parsed.lifecycle.diagnostics`;
 *   - resolves the source/target BY ROLE from `global.sources` / `global.targets`;
 *   - HARD-CUTS on a legacy shape (`migrationRequired: true`, no parse).
 *
 * `exists` reflects the unified FILE; a v0.2.0 file present but with no
 * `lifecycle.diagnostics` section yields { config:null, exists:true }.
 *
 * SELECTION: pass `selectors` to force a specific catalog entry by name (from the
 * `--source`/`--target` CLI overrides). A name that matches nothing yields the rich
 * `unknown-name` outcome (surfaced in `sourceSelection`/`targetSelection`); a
 * multi-entry catalog with no default + no name yields `needs-selection` (the run
 * flow prompts the operator). See `selectByRole`.
 */
export function loadConfig(
  projectRoot: string,
  selectors: RoleSelectors = {},
): LoadResult {
  const configPath = configPathFor(projectRoot);

  if (!existsSync(configPath)) {
    return emptyResult({ exists: false });
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = parseYaml(raw);
  } catch (err) {
    return emptyResult({
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // HARD-CUT (Fork B): legacy detection FIRST — never parse the old shape.
  const legacyMarkers = detectLegacyShape(parsed);
  if (legacyMarkers.length > 0) {
    return emptyResult({
      exists: true,
      migrationRequired: true,
      legacyMarkers,
    });
  }

  const root =
    parsed !== null && typeof parsed === "object"
      ? (parsed as {
          lifecycle?: { diagnostics?: DiagnosticsConfig };
          global?: { sources?: GlobalSource[]; targets?: GlobalTarget[] };
        })
      : {};

  const section = root.lifecycle?.diagnostics ?? null;
  const src = selectByRole(root.global?.sources, selectors.sourceName);
  const tgt = selectByRole(root.global?.targets, selectors.targetName);

  return {
    config: section,
    source: src.bound,
    target: tgt.bound,
    // Compat: "ambiguous" = a multi-entry catalog that did not auto-bind.
    sourceAmbiguous: isDeferredSelection(src.status),
    targetAmbiguous: isDeferredSelection(tgt.status),
    sourceSelection: src,
    targetSelection: tgt,
    exists: true,
    migrationRequired: false,
    legacyMarkers: [],
    error: null,
  };
}

/**
 * Compat helper: a selection with NO usable binding because the catalog holds >1 entry
 * and none could be picked (`needs-selection` OR `multiple-defaults`). Maps the rich
 * status back to the legacy boolean `*Ambiguous` fields.
 *
 * `resolved-default` is intentionally NOT deferred: a default IS preselected (in
 * `bound`), so legacy pre-selection callers keep receiving a usable source/target and
 * `*Ambiguous` stays false — the confirm is an ADDITIVE run-time signal read from
 * `sourceSelection.status`, not a blocking flag. `unknown-name` is a distinct
 * explicit-override error (not "ambiguous"), and `none`/`bound` are obviously not deferred.
 */
function isDeferredSelection(status: SelectionStatus): boolean {
  return status === "needs-selection" || status === "multiple-defaults";
}

/**
 * Parse `--source <name>` / `--target <name>` selection overrides out of an argv
 * slice (order-independent; supports both `--source name` and `--source=name`).
 * Exported for reuse by the run entry + tests. Pure — no process access.
 */
export function parseSelectors(argv: string[]): {
  selectors: RoleSelectors;
  positionals: string[];
} {
  const selectors: RoleSelectors = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineVal = eq === -1 ? undefined : arg.slice(eq + 1);

    if (flag === "--source" || flag === "--target") {
      const value = inlineVal ?? argv[++i];
      if (value !== undefined) {
        if (flag === "--source") selectors.sourceName = value;
        else selectors.targetName = value;
      }
      continue;
    }
    if (!arg.startsWith("--")) positionals.push(arg);
  }

  return { selectors, positionals };
}

// CLI usage: bun scripts/config/load.ts [project-root] [--source <name>] [--target <name>]
if (import.meta.main) {
  const { selectors, positionals } = parseSelectors(process.argv.slice(2));
  const projectRoot = positionals[0] ?? process.cwd();
  const result = loadConfig(projectRoot, selectors);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // A selection error (unknown --source/--target name or >1 default) is a hard exit;
  // `needs-selection` is NON-fatal here (the run flow prompts) — exit 0.
  const selectionError =
    result.sourceSelection.status === "unknown-name" ||
    result.sourceSelection.status === "multiple-defaults" ||
    result.targetSelection.status === "unknown-name" ||
    result.targetSelection.status === "multiple-defaults";
  process.exit(result.error || result.migrationRequired || selectionError ? 1 : 0);
}
