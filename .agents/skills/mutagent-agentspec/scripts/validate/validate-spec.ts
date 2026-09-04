/**
 * scripts/validate/validate-spec.ts
 * The *validate-spec gate — full round-trip validation of an agentspec.yaml file (AgentSpec 0.3.0).
 * Type A — Pure Script (a pure parse+validate function + a thin guarded CLI).
 *
 * Usage: scripts/cli/run.sh scripts/validate/validate-spec.ts <path-to-agentspec.yaml>
 *   exit 0 = the spec parses + validates against agentspec.mutagent.io/v0.3.0 → "[validate-spec] PASS"
 *   exit 1 = parse error OR structural/semantic violation (field-pathed errors on stdout)
 *
 * Two-layer gate: the STRUCTURAL TypeBox checker (`validateAgentSpec`) followed by the SEMANTIC
 * validator (`semanticValidate` — kind leakage, workflow graphs, member cycles, bounded loops,
 * reference resolution). Semantic runs only when structural passes (semantic assumes a shaped card).
 * When the input path is known, the colocated decision-sidecar file's EXISTENCE is also checked (N03).
 *
 * Mirrors the handover-contract.ts CLI: guarded file read, deterministic (the only input is the
 * file argument), `import.meta.main` entrypoint. Never throws on validation — only on a genuinely
 * unreadable file (surfaced as exit 1 with a message).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { validateAgentSpec } from "../contract/agentspec.schema.ts";
import type { ValidationResult } from "../contract/agentspec.schema.ts";
import { semanticValidate } from "./semantic-validator.ts";

export interface SpecValidationOutcome extends ValidationResult {
  /** True when the YAML failed to parse (distinct from a schema violation). */
  parseError: boolean;
}

/**
 * Parse a YAML spec STRING and validate it against the AgentSpec 0.3.0 contract (structural then
 * semantic). Pure: no I/O. A YAML parse failure is reported as { ok:false, parseError:true } rather
 * than thrown, so callers get a uniform outcome shape. Semantic checks run only when the structural
 * layer passes — the semantic validator assumes a roughly-shaped card.
 */
export function validateSpecYaml(yamlText: string): SpecValidationOutcome {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    return {
      ok: false,
      parseError: true,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const structural = validateAgentSpec(parsed);
  if (!structural.ok) return { ...structural, parseError: false };
  const semantic = semanticValidate(parsed);
  return { ...semantic, parseError: false };
}

/**
 * Read a spec file from disk and validate it. Throws ONLY when the file cannot be read; a parse or
 * schema failure is returned as a non-ok outcome. When the spec declares a `spec.decisionsRef`, the
 * referenced sibling file's EXISTENCE is checked here (the FS-aware half of N03; the path-form half
 * lives in the pure semantic validator).
 */
export function validateSpecFile(filePath: string): SpecValidationOutcome {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, "utf-8");
  const outcome = validateSpecYaml(text);

  // FS-aware N03: a declared decision sidecar must actually exist beside the spec.
  let decisionsRef: string | undefined;
  try {
    const parsed = parseYaml(text) as { spec?: { decisionsRef?: unknown } };
    if (typeof parsed?.spec?.decisionsRef === "string") decisionsRef = parsed.spec.decisionsRef;
  } catch {
    /* parse error already surfaced by validateSpecYaml */
  }
  if (outcome.ok && decisionsRef !== undefined) {
    const sidecar = path.resolve(path.dirname(resolved), decisionsRef);
    if (!fs.existsSync(sidecar)) {
      return {
        ok: false,
        parseError: false,
        errors: [
          `/spec/decisionsRef: referenced decision log '${decisionsRef}' does not exist beside the spec (N03)`,
        ],
      };
    }
  }
  return outcome;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function runCli(argv: string[]): number {
  const inputPath = argv.slice(2).find((a) => !a.startsWith("--"));
  if (inputPath === undefined) {
    process.stderr.write(
      "Usage: scripts/cli/run.sh scripts/validate/validate-spec.ts <agentspec.yaml>\n" +
        "Validates a spec against the frozen agentspec.mutagent.io/v0.3.0 contract (structural + semantic).\n" +
        "Exit 0 = valid; exit 1 = parse error or structural/semantic violation.\n",
    );
    return 1;
  }

  let outcome: SpecValidationOutcome;
  try {
    outcome = validateSpecFile(inputPath);
  } catch (err) {
    process.stderr.write(`Error reading ${inputPath}: ${String(err)}\n`);
    return 1;
  }

  if (outcome.ok) {
    console.info(`[validate-spec] PASS — ${inputPath} is a valid agentspec.mutagent.io/v0.3.0.`);
    return 0;
  }
  for (const e of outcome.errors) console.info(e);
  process.stderr.write(
    `[validate-spec] FAIL — ${outcome.errors.length} error(s) in ${inputPath}.\n`,
  );
  return 1;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
