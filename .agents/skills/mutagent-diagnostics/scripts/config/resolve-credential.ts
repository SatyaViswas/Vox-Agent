/**
 * scripts/config/resolve-credential.ts
 * The shared secret resolver (operator decision 2026-06-29). PORTED IN — standalone
 * copy (no cross-skill import; mirrors the orchestrator's canonical impl).
 *
 * A `credential_ref` in `.mutagent/config.yaml` is NEVER a raw secret — it names
 * where the value lives. This turns the ref into the value by a fixed PRECEDENCE:
 *
 *   1. process.env[name]   — the running environment wins (CI / shell export).
 *   2. local `.env`        — projectRoot/.env (the conventional dev secret file).
 *   3. `.mutagentrc`       — projectRoot/.mutagentrc (the credential/provider store;
 *                            the fallback when no `.env` is around — it STAYS).
 *
 * Raw secret VALUES never enter config.yaml; the config holds only the ref. Pure
 * core with INJECTED deps (env map + file reader) → deterministic tests.
 * Type A — Pure Script.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

export type CredentialRef = string | { env: string; path?: string };
export type CredentialSource = "env" | ".env" | ".mutagentrc" | "ref-path";

export type ResolveCredentialResult =
  | { found: true; value: string; source: CredentialSource; from: string }
  | { found: false; name: string; tried: string[] };

export interface ResolveCredentialDeps {
  env: Record<string, string | undefined>;
  /** File contents, or null if unreadable/absent. Never throws. */
  readFile: (p: string) => string | null; // eslint-disable-line no-unused-vars
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/** Parse a dotenv-style file (`.env` / `.mutagentrc`). Pure — string in, map out. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    const quoted =
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2);
    if (quoted) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function normalizeRef(ref: CredentialRef): { name: string; refPath?: string } {
  if (typeof ref === "string") return { name: ref };
  return { name: ref.env, refPath: ref.path };
}

/**
 * Resolve a credential ref to its secret by precedence (env → .env → .mutagentrc),
 * with an optional ref-pinned file tried FIRST among files. Pure: I/O injected.
 */
export function resolveCredential(
  ref: CredentialRef,
  projectRoot: string,
  deps: ResolveCredentialDeps,
): ResolveCredentialResult {
  const { name, refPath } = normalizeRef(ref);
  const tried: string[] = [];

  const envVal = deps.env[name];
  if (envVal !== undefined && envVal !== "") {
    return { found: true, value: envVal, source: "env", from: `process.env.${name}` };
  }
  tried.push(`process.env.${name}`);

  const fileTiers: { label: CredentialSource; file: string }[] = [];
  if (refPath) fileTiers.push({ label: "ref-path", file: resolve(projectRoot, refPath) });
  fileTiers.push({ label: ".env", file: resolve(projectRoot, ".env") });
  fileTiers.push({ label: ".mutagentrc", file: resolve(projectRoot, ".mutagentrc") });

  for (const tier of fileTiers) {
    tried.push(tier.file);
    const content = deps.readFile(tier.file);
    if (content === null) continue;
    const val = parseDotenv(content)[name];
    if (val !== undefined && val !== "") {
      return { found: true, value: val, source: tier.label, from: tier.file };
    }
  }

  return { found: false, name, tried };
}

/** Real-fs reader: contents or null (never throws). */
export function readFileOrNull(p: string): string | null {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Thin wrapper binding the REAL process.env + fs. */
export function resolveCredentialLive(
  ref: CredentialRef,
  projectRoot: string,
): ResolveCredentialResult {
  return resolveCredential(ref, projectRoot, {
    env: process.env,
    readFile: readFileOrNull,
  });
}
