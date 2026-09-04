/**
 * scripts/config/load.ts — the evaluator's config-loader (v0.2.0).
 * ---------------------------------------------------------------------------
 * Read + YAML-parse the UNIFIED local `.mutagent/config.yaml` and RESOLVE the
 * two things the evaluator needs to run:
 *
 *   source — bound BY ROLE. The evaluator is a source-CONSUMER, so it binds
 *            `global.sources`. A SINGLE entry auto-binds; MULTIPLE ⇒
 *            disambiguation deferred (Fork A) → returned as `multiple` (NOT a
 *            hard fail — DISCOVER needs a source, code/dataset runs don't).
 *   judge  — the pinned judge MODEL, resolved from `global.models.judge_model`
 *            ?? `global.models.default`. `judge_runtime` (renamed from
 *            `substrate` in v0.2.0) selects HOW judges run.
 *
 * These feed the CLI's config→flag precedence (an explicit `--model` /
 * `--traces` flag WINS; the config fills the gap). This module does NOT apply
 * that precedence — it exposes the resolved config values; the caller (cli/prep.ts)
 * merges them under flag precedence.
 *
 * LEGACY (Fork B — hard-cut): a pre-v0.2.0 config (wrong `config_version` OR a
 * legacy top-level key `shared`/`stages`/top-level `diagnostics`/`evaluator`) is
 * DETECTED, never parsed at runtime — the loader returns
 * `{ status: "migration-required", … }` so the caller routes to the migration
 * DIRECTIVE. No old-shape parse ever happens.
 *
 * Determinism (coding-rules): `loadEvaluatorConfig` reads an INJECTED path —
 * never resolved here. Path resolution (the LOCAL `.mutagent/`) happens only in
 * the thin CLI, so tests stay deterministic against committed fixtures. Pure:
 * one fs read + a YAML parse; no clock, no random, no network. Never throws.
 *
 * SECRETS: config holds only credential REF names (never values); resolution is
 * a separate use-time step (resolve-credential.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CONFIG_VERSION,
  LEGACY_CONFIG_VERSIONS,
  type GlobalSource,
  type GlobalTarget,
  type ContextLink,
  validateGlobal,
  validateLifecycleEvaluator,
} from "./schema.ts";

/** The unified config path under a project root: `<root>/.mutagent/config.yaml`. */
export function configPathFor(projectRoot: string): string {
  return resolve(projectRoot, ".mutagent", "config.yaml");
}

/** The v0.1.0 top-level keys that must NOT appear in a v0.2.0 config. */
const LEGACY_TOP_LEVEL_KEYS = [
  "shared",
  "stages",
  "diagnostics",
  "evaluator",
] as const;

/**
 * Detect a legacy (pre-v0.2.0) config WITHOUT parsing its old shape. Two signals,
 * either one fires: a wrong/absent `config_version`, or a legacy top-level key
 * (`shared`/`stages`/a top-level `diagnostics`/`evaluator` skill section). Pure;
 * tolerant of a non-object input (returns []). Mirrors the orchestrator's
 * detectLegacyConfig (parity port — no cross-import).
 */
export function detectLegacyConfig(obj: unknown): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const markers: string[] = [];

  const version = o.config_version;
  if (version !== CONFIG_VERSION) {
    if (
      typeof version === "string" &&
      (LEGACY_CONFIG_VERSIONS as readonly string[]).includes(version)
    ) {
      markers.push(
        `config_version: "${version}" (legacy — expected "${CONFIG_VERSION}")`,
      );
    } else if (version === undefined) {
      markers.push(`config_version: absent (expected "${CONFIG_VERSION}")`);
    }
    // A non-legacy, non-current version (e.g. a future "0.3.0") is NOT a legacy
    // marker — structural validation reports it instead.
  }

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (key in o) markers.push(`legacy top-level key '${key}'`);
  }
  return markers;
}

/**
 * How the evaluator's source was bound (or why it couldn't be). The SELECTION
 * contract (v0.2.2 — parity with orchestrator + diagnostics; F2 disambiguation UX):
 *   bound            — exactly one source resolved with NO ambiguity (single entry ·
 *                      `--source` hit). No prompt.
 *   confirm-default  — >1 source with exactly one `default:true` (F2). The default is
 *                      PRESELECTED (`source`) but the caller ISSUES A CONFIRM ASK before
 *                      using it (distinct from a silent bind — be explicit around ambiguity).
 *                      NON-fatal + bindable: `source` is usable as-is if the operator accepts
 *                      or the run is non-interactive (`--source` / CI). Carries the full
 *                      candidate list so the confirm can offer an override.
 *   none             — zero sources (DISCOVER needs a pick; code/dataset runs don't need a source).
 *   needs-selection  — >1 source, none `default:true`, no `--source` ⇒ the caller must PROMPT the
 *                      operator to pick with NO preselection (NON-fatal — the source EXISTS,
 *                      only the pick is missing).
 *   multiple-defaults— >1 source with `default:true` — an AMBIGUOUS config the operator must fix.
 *   unknown-name     — an explicit `--source <name>` that matched no catalog entry.
 *
 * confirm-default vs needs-selection: BOTH defer a run-time ASK, but confirm-default
 * carries a PRESELECTED default (a yes/no confirm) whereas needs-selection has none (an
 * open pick). Both are bindable-in-principle; the distinction drives the ASK shape.
 */
export type SourceBinding =
  | { kind: "bound"; source: GlobalSource }
  | { kind: "confirm-default"; source: GlobalSource; sources: GlobalSource[] }
  | { kind: "none" }
  | { kind: "needs-selection"; sources: GlobalSource[] }
  | { kind: "multiple-defaults"; sources: GlobalSource[] }
  | { kind: "unknown-name"; name: string };

/** How the judge model resolved (model-intent-sacred: never a silent swap). */
export type JudgeModelResolution =
  | { kind: "resolved"; model: string; from: "judge_model" | "default" }
  | { kind: "unresolved" };

export interface EvaluatorConfigResolved {
  /** the raw config_version literal read from the file. */
  configVersion: string;
  /** source bound BY ROLE from `global.sources` (single auto-binds). */
  source: SourceBinding;
  /** the pinned judge model from `global.models.{judge_model,default}`. */
  judgeModel: JudgeModelResolution;
  /** `lifecycle.evaluator.judge_runtime` (renamed from `substrate`), if set. */
  judgeRuntime: string | undefined;
  /** `global.context[]` — PROJECT-WIDE context links (every run loads these). */
  globalContext: ContextLink[];
  /** `lifecycle.evaluator.context[]` — the evaluator's stage-specific links. */
  evaluatorContext: ContextLink[];
  /** present targets (evaluator is judge-only — carried for completeness only). */
  targets: GlobalTarget[];
  /** PRD R-4 — the admin default render audience for the evaluation report. Client-by-default
   *  (leak-safe); an admin sets `internal` in config.yaml to show the §5 Self-Eval tab. */
  defaultAudience: "client" | "internal";
}

/** PRD R-4 — resolve the effective render audience: explicit flag → config → "client". */
export function resolveEvalAudience(
  explicit: "client" | "internal" | undefined,
  config?: { defaultAudience?: "client" | "internal" } | undefined,
): "client" | "internal" {
  return explicit ?? config?.defaultAudience ?? "client";
}

export type LoadEvaluatorConfigResult =
  | { status: "ok"; exists: true; config: EvaluatorConfigResolved }
  | { status: "absent"; exists: false }
  | { status: "migration-required"; exists: true; markers: string[]; error: string }
  | { status: "invalid"; exists: true; errors: string[] };

/**
 * Bind a source by role from `global.sources`. Precedence (SELECTION contract —
 * EXACT parity with orchestrator + diagnostics):
 *
 *   1. explicit `selectName` (`--source`) WINS — find by name; miss ⇒ `unknown-name`.
 *   2. 0 sources                  ⇒ `none`.
 *   3. 1 source                   ⇒ `bound` (auto-bind — no ambiguity, no prompt).
 *   4. >1 sources:
 *        exactly one `default:true` ⇒ `confirm-default` (F2 — preselected default; caller
 *                                     CONFIRMS before use, not a silent bind).
 *        >1 `default:true`          ⇒ `multiple-defaults` (ambiguous — operator fixes config).
 *        0  `default:true`          ⇒ `needs-selection` (caller PROMPTS the operator — open pick).
 *
 * Pure; no clock/random/network. NON-fatal on `confirm-default`/`needs-selection` —
 * the source exists; only the disambiguation confirm/pick is deferred to the run-start ASK.
 * `--source` (explicit) always short-circuits both, satisfying the non-interactive/CI escape.
 */
function bindSourceByRole(
  sources: GlobalSource[],
  selectName?: string,
): SourceBinding {
  // (1) Explicit override — `--source <name>` WINS over any default / auto-bind.
  if (selectName !== undefined && selectName !== "") {
    const hit = sources.find((s) => s.name === selectName);
    return hit !== undefined
      ? { kind: "bound", source: hit }
      : { kind: "unknown-name", name: selectName };
  }
  // (2) / (3) — zero or a single entry.
  if (sources.length === 0) return { kind: "none" };
  if (sources.length === 1) return { kind: "bound", source: sources[0] as GlobalSource };
  // (4) — multiple entries; disambiguate by `default:true`.
  const defaults = sources.filter((s) => s.default === true);
  // F2: a lone default is PRESELECTED but CONFIRMED (be explicit around ambiguity) —
  // it is NOT silently bound. The caller (parent session) issues a yes/no confirm ask.
  if (defaults.length === 1) {
    return { kind: "confirm-default", source: defaults[0] as GlobalSource, sources };
  }
  if (defaults.length > 1) return { kind: "multiple-defaults", sources };
  return { kind: "needs-selection", sources };
}

/**
 * Resolve the judge model (model-intent-sacred): `judge_model` wins, else
 * `default`, else unresolved. The CALLER refuses (or falls back to `--model`)
 * on `unresolved` — this pure resolver never invents a model.
 */
function resolveJudgeModel(models: {
  default?: string;
  judge_model?: string;
}): JudgeModelResolution {
  if (models.judge_model !== undefined && models.judge_model !== "") {
    return { kind: "resolved", model: models.judge_model, from: "judge_model" };
  }
  if (models.default !== undefined && models.default !== "") {
    return { kind: "resolved", model: models.default, from: "default" };
  }
  return { kind: "unresolved" };
}

/** Options for {@link loadEvaluatorConfig}. */
export interface LoadEvaluatorConfigOptions {
  /**
   * Run-time source override (`--source <name>`). WINS over `default:true` /
   * auto-bind; a miss ⇒ `{ kind: "unknown-name" }`. Absent ⇒ default precedence.
   */
  selectSourceName?: string;
}

/**
 * Load + resolve the evaluator's config from an INJECTED path. Guarded (mirrors
 * the orchestrator loadConfig): a missing file → `absent`; malformed YAML or a
 * failed structural check → `invalid`; a LEGACY config → `migration-required`
 * (detected BEFORE structural validation — never parse the old shape). Otherwise
 * `ok` with the resolved source + judge model + context links. Never throws.
 *
 * `opts.selectSourceName` (`--source`) threads the run-time source override into
 * `bindSourceByRole` (SELECTION contract) — it WINS over `default:true`.
 */
export function loadEvaluatorConfig(
  configPath: string,
  opts: LoadEvaluatorConfigOptions = {},
): LoadEvaluatorConfigResult {
  if (!existsSync(configPath)) {
    return { status: "absent", exists: false };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { status: "invalid", exists: true, errors: [`cannot read ${configPath}: ${String(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { status: "invalid", exists: true, errors: [`malformed YAML in ${configPath}: ${String(err)}`] };
  }

  // Legacy detection FIRST — never parse the old shape at runtime (Fork B).
  const legacyMarkers = detectLegacyConfig(parsed);
  if (legacyMarkers.length > 0) {
    return {
      status: "migration-required",
      exists: true,
      markers: legacyMarkers,
      error:
        `legacy config detected in ${configPath} — migration required ` +
        `(see references/config-migration.md): ${legacyMarkers.join("; ")}`,
    };
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const globalBlock = (root.global ?? {}) as Record<string, unknown>;
  const lifecycle = (root.lifecycle ?? {}) as Record<string, unknown>;
  const evaluatorSection = (lifecycle.evaluator ?? {}) as Record<string, unknown>;

  // Structural validation of the two blocks the evaluator reads.
  const gRes = validateGlobal(globalBlock);
  if (!gRes.ok) return { status: "invalid", exists: true, errors: gRes.errors.map((e) => `global${e}`) };
  const eRes = validateLifecycleEvaluator(evaluatorSection);
  if (!eRes.ok) {
    return { status: "invalid", exists: true, errors: eRes.errors.map((e) => `lifecycle.evaluator${e}`) };
  }

  const sources = (globalBlock.sources as GlobalSource[] | undefined) ?? [];
  const targets = (globalBlock.targets as GlobalTarget[] | undefined) ?? [];
  const models = (globalBlock.models as { default?: string; judge_model?: string } | undefined) ?? {};
  const globalContext = (globalBlock.context as ContextLink[] | undefined) ?? [];
  const evaluatorContext = (evaluatorSection.context as ContextLink[] | undefined) ?? [];
  const judgeRuntime =
    typeof evaluatorSection.judge_runtime === "string" && evaluatorSection.judge_runtime !== ""
      ? evaluatorSection.judge_runtime
      : undefined;
  // PRD R-4 — admin audience override. Precedence: lifecycle.evaluator.default_audience >
  // global.default_audience > "client". Only "internal" flips it; anything else stays client.
  const rawAudience =
    evaluatorSection.default_audience ?? globalBlock.default_audience;
  const defaultAudience: "client" | "internal" = rawAudience === "internal" ? "internal" : "client";

  return {
    status: "ok",
    exists: true,
    config: {
      configVersion: typeof root.config_version === "string" ? root.config_version : "",
      source: bindSourceByRole(sources, opts.selectSourceName),
      judgeModel: resolveJudgeModel(models),
      judgeRuntime,
      globalContext,
      evaluatorContext,
      targets,
      defaultAudience,
    },
  };
}

// ── CLI — thin wrapper (resolve the LOCAL config; print the resolution) ────────
// bun scripts/config/load.ts [project-root] [--source <name>]   (root defaults to cwd)
// Exit 0 = ok / absent; exit 1 = invalid / migration-required.

function runCli(argv: string[]): number {
  const sourceIdx = argv.indexOf("--source");
  const selectSourceName =
    sourceIdx >= 0 && sourceIdx + 1 < argv.length ? argv[sourceIdx + 1] : undefined;
  // First positional after the script path that isn't the --source value.
  const positional = argv[2] !== undefined && argv[2] !== "--source" ? argv[2] : undefined;
  const projectRoot = positional ?? process.cwd();
  const result = loadEvaluatorConfig(configPathFor(projectRoot), { selectSourceName });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.status === "invalid" || result.status === "migration-required" ? 1 : 0;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
