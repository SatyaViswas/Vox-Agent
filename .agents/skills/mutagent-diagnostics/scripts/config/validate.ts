/**
 * scripts/config/validate.ts
 * Schema validation for the v0.2.0 diagnostics config using TypeBox.
 *
 * v0.2.0: validation now spans TWO surfaces —
 *   1. the `lifecycle.diagnostics` SECTION (opaque skill knobs — ask_tool, apply,
 *      context, self_diagnostics, …) against `DiagnosticsConfigSchema`;
 *   2. the RESOLVED source/target catalog entries (bound BY ROLE in load.ts)
 *      against `GlobalSourceSchema` / `GlobalTargetSchema`.
 * `source` / `target` are no longer inline in the diagnostics section, so the
 * required-field check moved to the resolved entries.
 * Type A — Pure Script (deterministic validation, typed errors)
 */

import { Value } from "@sinclair/typebox/value";
import {
  DiagnosticsConfigSchema,
  GlobalSourceSchema,
  GlobalTargetSchema,
} from "./schema.ts";
import type {
  DiagnosticsConfig,
  GlobalSource,
  GlobalTarget,
} from "./schema.ts";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  missingFields: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/** What validateResolved needs — the section + the role-resolved catalog entries. */
export interface ResolvedConfigInput {
  config: DiagnosticsConfig | null;
  source: GlobalSource | null;
  target: GlobalTarget | null;
}

function collectErrors(
  schema: Parameters<typeof Value.Check>[0],
  raw: unknown,
  prefix: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Value.Check(schema, raw)) {
    for (const error of Value.Errors(schema, raw)) {
      errors.push({
        path: `${prefix}${error.path}`,
        message: error.message,
        value: error.value,
      });
    }
  }
  return errors;
}

/**
 * Validate a parsed `lifecycle.diagnostics` section against the TypeBox schema.
 * (Kept for callers that only have the section — the resolved source/target are
 * validated separately via `validateResolved`.)
 */
export function validateConfig(raw: unknown): ValidationResult {
  const errors = collectErrors(DiagnosticsConfigSchema, raw, "");

  const missingFields: string[] = [];
  const config = raw as Partial<DiagnosticsConfig>;
  if (!config?.ask_tool?.runtime) missingFields.push("ask_tool.runtime");

  return {
    valid: errors.length === 0 && missingFields.length === 0,
    errors,
    missingFields,
  };
}

/**
 * v0.2.0 — validate the RESOLVED config: the diagnostics section PLUS the
 * role-bound source + target catalog entries. A missing (null) source/target is a
 * missingField (onboarding-completeness concern), NOT a schema error; a PRESENT
 * entry with a bad shape IS a schema error.
 */
export function validateResolved(input: ResolvedConfigInput): ValidationResult {
  const errors: ValidationError[] = [];
  const missingFields: string[] = [];

  // Section (opaque skill knobs).
  errors.push(...collectErrors(DiagnosticsConfigSchema, input.config, "diagnostics"));
  if (!input.config?.ask_tool?.runtime) missingFields.push("ask_tool.runtime");

  // Resolved source (bound by role from global.sources).
  if (input.source === null) {
    missingFields.push("global.sources[] (source-consumer role)");
  } else {
    errors.push(...collectErrors(GlobalSourceSchema, input.source, "global.source"));
  }

  // Resolved target (bound by role from global.targets).
  if (input.target === null) {
    missingFields.push("global.targets[] (target-writer role)");
  } else {
    errors.push(...collectErrors(GlobalTargetSchema, input.target, "global.target"));
  }

  return {
    valid: errors.length === 0 && missingFields.length === 0,
    errors,
    missingFields,
  };
}

// CLI usage: bun scripts/config/validate.ts [config-json-string]
if (import.meta.main) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write("Usage: bun scripts/config/validate.ts '<json>'\n");
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(input);
    const result = validateConfig(parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.valid ? 0 : 1);
  } catch (err) {
    process.stderr.write(`JSON parse error: ${err}\n`);
    process.exit(1);
  }
}
