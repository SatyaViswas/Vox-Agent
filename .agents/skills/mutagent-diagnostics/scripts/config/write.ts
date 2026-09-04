/**
 * scripts/config/write.ts
 * DX-6: CODE-ENFORCED write-path for the unified diagnostics config.
 *
 * WHY this exists: onboarding used to be agent-followed markdown ("if confirmed, write
 * config.yaml") with NOTHING validating WHERE it wrote. In one dogfood run the session
 * agent hand-authored a LEGACY-shaped file at the dead legacy path
 * `.mutagent-diagnostics/config.yaml` — a path that no code reads. This module makes the
 * write a code path with two guards, so an agent can never author a legacy file at a
 * legacy path again:
 *   1. DESTINATION guard — the config is ALWAYS written to the one canonical unified
 *      location `<root>/.mutagent/config.yaml` (configPathFor). Any attempt to write to a
 *      `.mutagent-diagnostics/` path is refused loudly.
 *   2. SHAPE guard — the body must be the v0.2.0 unified shape; a legacy-shaped body
 *      (detectLegacyShape) is refused before a single byte is written.
 *
 * Type A — Pure-ish Script (deterministic; the ONLY I/O is the guarded config write).
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { CONFIG_VERSION, configPathFor, detectLegacyShape } from "./load.ts";

/** The dead legacy config directory name — NEVER a valid write destination (DX-6). */
export const LEGACY_CONFIG_DIRNAME = ".mutagent-diagnostics";

/** The ONE canonical unified config location, relative to a project root. */
export const UNIFIED_CONFIG_RELPATH = ".mutagent/config.yaml";

/** Thrown when a caller tries to write the config anywhere but the canonical path. */
export class ConfigWritePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWritePathError";
  }
}

/**
 * DX-6 config-location awareness: the ONE place a caller (onboarding, the orchestrator,
 * any skill) should resolve to learn where the unified config lives. Returns the absolute
 * canonical path — callers pass this around instead of re-deriving or guessing it.
 */
export function unifiedConfigLocation(projectRoot: string): string {
  return configPathFor(projectRoot);
}

/**
 * DESTINATION guard. Throws unless `destPath` is EXACTLY the canonical unified config path
 * for `projectRoot`. Explicitly rejects any `.mutagent-diagnostics/` legacy path with an
 * actionable message. Use this to validate a destination a caller proposes.
 */
export function assertUnifiedConfigDest(destPath: string, projectRoot: string): void {
  const dest = resolve(destPath);
  if (dest.includes(`${LEGACY_CONFIG_DIRNAME}/`) || dest.endsWith(LEGACY_CONFIG_DIRNAME)) {
    throw new ConfigWritePathError(
      `Refusing to write config to the DEAD legacy path "${LEGACY_CONFIG_DIRNAME}". ` +
        `The unified config lives at ${UNIFIED_CONFIG_RELPATH} — write there instead.`,
    );
  }
  const canonical = configPathFor(projectRoot);
  if (dest !== canonical) {
    throw new ConfigWritePathError(
      `Refusing to write config to "${dest}". The ONLY valid destination is the canonical ` +
        `unified path "${canonical}" (${UNIFIED_CONFIG_RELPATH}).`,
    );
  }
}

/**
 * SHAPE guard. Throws when `configYaml` parses to a LEGACY (pre-v0.2.0) shape — a
 * non-frozen config_version or any legacy top-level key. A legacy body must never be
 * written; the operator migrates first (see references/workflows/onboarding.md).
 */
export function assertUnifiedConfigShape(configYaml: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(configYaml);
  } catch (err) {
    throw new ConfigWritePathError(`Config body is not valid YAML: ${String(err)}`);
  }
  const legacyMarkers = detectLegacyShape(parsed);
  if (legacyMarkers.length > 0) {
    throw new ConfigWritePathError(
      `Refusing to write a LEGACY-shaped config (expected config_version "${CONFIG_VERSION}"). ` +
        `Markers: ${legacyMarkers.join("; ")}. Migrate to the unified v0.2.0 shape first.`,
    );
  }
}

export interface WriteConfigResult {
  /** Absolute path the config was written to (always the canonical unified path). */
  path: string;
  /** True when an existing file was overwritten. */
  overwritten: boolean;
}

/**
 * DX-6: write the rendered config body to the CANONICAL unified path, enforcing both
 * guards. Creates the `.mutagent/` directory if needed. Refuses to overwrite an existing
 * config unless `overwrite` is set (so onboarding never clobbers a hand-tuned config).
 *
 * This is the ONLY sanctioned way to write the config — onboarding renders
 * `assets/templates/config.yaml.tpl` and hands the result here rather than free-writing a
 * path itself.
 */
export function writeUnifiedConfig(
  projectRoot: string,
  configYaml: string,
  opts: { overwrite?: boolean } = {},
): WriteConfigResult {
  const dest = configPathFor(projectRoot);
  // Belt-and-suspenders: the destination we compute is canonical by construction, but run
  // the destination guard so a future refactor that passes a different path still fails.
  assertUnifiedConfigDest(dest, projectRoot);
  assertUnifiedConfigShape(configYaml);

  const existed = existsSync(dest);
  if (existed && !opts.overwrite) {
    throw new ConfigWritePathError(
      `Config already exists at "${dest}". Pass overwrite:true to replace it (onboarding ` +
        `never clobbers an existing config by default).`,
    );
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, configYaml.endsWith("\n") ? configYaml : `${configYaml}\n`, "utf8");
  return { path: dest, overwritten: existed };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────────
//
// Usage: bun scripts/config/write.ts <projectRoot> <renderedConfig.yaml> [--overwrite]
// Reads the RENDERED config body from a file and writes it to the canonical unified path
// with both guards. Onboarding calls this instead of free-hand writing a path.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const positional = args.filter((a) => !a.startsWith("--"));
  const projectRoot = positional[0];
  const bodyFile = positional[1];
  if (!projectRoot || !bodyFile) {
    process.stderr.write(
      "Usage: bun scripts/config/write.ts <projectRoot> <renderedConfig.yaml> [--overwrite]\n" +
        "\n" +
        "Writes the rendered config body to <projectRoot>/.mutagent/config.yaml, enforcing the\n" +
        "canonical destination + v0.2.0 shape. Refuses a legacy path or a legacy-shaped body.\n",
    );
    process.exit(1);
  }
  (async () => {
    const { readFileSync } = await import("fs");
    try {
      const body = readFileSync(resolve(bodyFile), "utf8");
      const result = writeUnifiedConfig(projectRoot, body, { overwrite });
      process.stderr.write(
        `[config/write] ${result.overwritten ? "overwrote" : "wrote"} ${result.path}\n`,
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[config/write] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  })();
}
