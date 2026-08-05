/**
 * scripts/context/load-context.ts
 * PHASE 4 (context links) — load the run-start context bundle.
 *
 * At run START (parse-brief / Step 3a) the diagnostics skill loads TWO levels of
 * context links (each `{ path, what, why, when }`):
 *   1. `global.context[]`               — PROJECT-WIDE (every skill, every run).
 *   2. `lifecycle.diagnostics.context[]` — the diagnostics stage's own links
 *                                          (the triage runbook).
 * The two levels are CONCATENATED (global first, then stage) into one ordered
 * bundle the orchestrator injects into the run. Duplicate `path`s are de-duped
 * (global wins — a project-wide link is not repeated by a stage link to the same doc).
 *
 * This reads the v0.2.0 config the same way load.ts does (from the unified
 * `.mutagent/config.yaml`), so a legacy shape is HARD-CUT here too (migrationRequired).
 *
 * Type A — Pure Script (YAML read via load path; base dir INJECTABLE; no clock/net).
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { configPathFor, detectLegacyShape } from "../config/load.ts";
import type { ContextLink } from "../config/schema.ts";

export interface LoadedContext {
  /** Ordered, de-duped bundle: global.context[] then lifecycle.diagnostics.context[]. */
  links: ContextLink[];
  /** The subset from `global.context[]` (before de-dupe with stage). */
  globalLinks: ContextLink[];
  /** The subset from `lifecycle.diagnostics.context[]`. */
  stageLinks: ContextLink[];
  /** HARD-CUT: legacy shape detected — no context loaded (route to migration). */
  migrationRequired: boolean;
}

function asLinkArray(v: unknown): ContextLink[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is ContextLink =>
      x !== null &&
      typeof x === "object" &&
      typeof (x as ContextLink).path === "string" &&
      typeof (x as ContextLink).what === "string" &&
      typeof (x as ContextLink).why === "string" &&
      typeof (x as ContextLink).when === "string",
  );
}

/**
 * Load the run-start context bundle for the diagnostics stage from the unified
 * config at `<root>/.mutagent/config.yaml`. Never throws — a missing/malformed file
 * yields an empty bundle; a legacy shape yields `migrationRequired: true` + empty.
 */
export function loadContext(projectRoot: string): LoadedContext {
  const empty: LoadedContext = {
    links: [],
    globalLinks: [],
    stageLinks: [],
    migrationRequired: false,
  };

  const configPath = configPathFor(projectRoot);
  if (!existsSync(configPath)) return empty;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return empty;
  }

  if (detectLegacyShape(parsed).length > 0) {
    return { ...empty, migrationRequired: true };
  }

  const root =
    parsed !== null && typeof parsed === "object"
      ? (parsed as {
          global?: { context?: unknown };
          lifecycle?: { diagnostics?: { context?: unknown } };
        })
      : {};

  const globalLinks = asLinkArray(root.global?.context);
  const stageLinks = asLinkArray(root.lifecycle?.diagnostics?.context);

  // Concatenate global-first; de-dupe by path (global wins).
  const seen = new Set<string>();
  const links: ContextLink[] = [];
  for (const link of [...globalLinks, ...stageLinks]) {
    if (seen.has(link.path)) continue;
    seen.add(link.path);
    links.push(link);
  }

  return { links, globalLinks, stageLinks, migrationRequired: false };
}

// CLI usage: bun scripts/context/load-context.ts [project-root]
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const result = loadContext(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.migrationRequired ? 1 : 0);
}
