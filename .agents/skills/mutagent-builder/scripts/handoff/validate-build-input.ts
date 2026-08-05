#!/usr/bin/env bun
/** Lightweight input preflight for `mutagent-builder` BUILD dispatch. */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

interface Args { spec?: string; target?: string; json: boolean }
interface Result { ok: boolean; specPath: string | null; targetRoot: string | null; reason: string; specId: string | null; kind: string | null; targetCount: number }
const KINDS = ["Agent", "Skill", "MultiAgent", "Workflow"];

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spec") args.spec = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: scripts/cli/run.sh scripts/handoff/validate-build-input.ts --spec <agentspec.yaml> --target <target-root> [--json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function check(args: Args): Result {
  if (!args.spec) return { ok: false, specPath: null, targetRoot: args.target ?? null, reason: "spec: --spec is required", specId: null, kind: null, targetCount: 0 };
  if (!args.target) return { ok: false, specPath: args.spec, targetRoot: null, reason: "target: --target is required", specId: null, kind: null, targetCount: 0 };
  const specPath = path.resolve(args.spec);
  const targetRoot = path.resolve(args.target);
  try {
    if (!fs.statSync(specPath).isFile()) throw new Error("not a file");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, specPath, targetRoot, reason: `spec: unreadable spec: ${message}`, specId: null, kind: null, targetCount: 0 };
  }
  try {
    if (!fs.statSync(targetRoot).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, specPath, targetRoot, reason: `target: unreadable target root: ${message}`, specId: null, kind: null, targetCount: 0 };
  }
  let parsed: any;
  try {
    parsed = parseYaml(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, specPath, targetRoot, reason: `spec: YAML parse failed: ${message}`, specId: null, kind: null, targetCount: 0 };
  }
  // AgentSpec 0.3.0 envelope: metadata.id + kind (strict discriminator) + spec.targets[].
  const specId = parsed?.metadata?.id ?? null;
  const kind = parsed?.kind ?? null;
  const targets = Array.isArray(parsed?.spec?.targets) ? parsed.spec.targets : [];
  const targetCount = targets.length;
  if (!specId) return { ok: false, specPath, targetRoot, reason: "metadata.id: missing", specId, kind, targetCount };
  if (!kind || !KINDS.includes(kind)) return { ok: false, specPath, targetRoot, reason: `kind: must be one of ${KINDS.join(" | ")}`, specId, kind, targetCount };
  if (targetCount < 1) return { ok: false, specPath, targetRoot, reason: "spec.targets: at least one target is required to build", specId, kind, targetCount };
  return { ok: true, specPath, targetRoot, reason: "build inputs ready", specId, kind, targetCount };
}

export function runCli(argv: string[]): number {
  let args: Args;
  try { args = parseArgs(argv); }
  catch (error) {
    const result: Result = { ok: false, specPath: null, targetRoot: null, reason: `args: ${error instanceof Error ? error.message : String(error)}`, specId: null, kind: null, targetCount: 0 };
    console.error(JSON.stringify(result, null, 2));
    return 1;
  }
  const result = check(args);
  const output = args.json ? JSON.stringify(result, null, 2) : `[validate-build-input] ${result.ok ? "PASS" : "FAIL"}: ${result.reason}`;
  if (result.ok) console.log(output); else console.error(output);
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(runCli(process.argv.slice(2)));
