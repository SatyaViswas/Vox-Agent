import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// resolve-credential — the ONE shared secret resolver (operator decision
// 2026-06-29).
//
// A `credential_ref` in `.mutagent/config.yaml` is NEVER a raw secret value — it
// names where the value lives. This resolver turns that ref into the actual
// secret by a fixed PRECEDENCE:
//
//   1. process.env[name]      — the running environment wins (CI, shell export).
//   2. local `.env`           — projectRoot/.env (the conventional dev secret file).
//   3. `.mutagentrc`          — projectRoot/.mutagentrc (the credential/provider
//                               store; the fallback when no `.env` is around).
//
// `.mutagentrc` STAYS — it is the gitignored provider-secret store. Raw secret
// VALUES never enter config.yaml; the config holds only the `credential_ref`.
//
// A ref may be a bare ENV-VAR NAME (string) or an object that also pins an
// explicit file to read first: `{ env: "LANGFUSE_SECRET_KEY", path: ".env.ci" }`.
//
// Design invariants (mirror config-schema.ts / handover-contract.ts):
//   - Pure core with INJECTED deps (env map + file reader) → deterministic tests,
//     never touches the real environment or disk in the pure path.
//   - A thin CLI wrapper binds the real process.env + fs.
//   - Never throws on a missing file; a not-found ref returns { found:false }.
// ---------------------------------------------------------------------------

/** A credential reference: a bare env-var NAME, or a name + an explicit file to try first. */
export type CredentialRef = string | { env: string; path?: string };

/** Where a resolved secret came from (transparency — surfaced, never the value). */
export type CredentialSource = "env" | ".env" | ".mutagentrc" | "ref-path";

export type ResolveCredentialResult =
  | { found: true; value: string; source: CredentialSource; from: string }
  | { found: false; name: string; tried: string[] };

export interface ResolveCredentialDeps {
  /** Injected environment map (defaults to process.env in the thin wrapper). */
  env: Record<string, string | undefined>;
  /** Injected file reader → file contents, or null if unreadable/absent. Never throws. */
  readFile: (p: string) => string | null;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * Parse a dotenv-style file (`.env` / `.mutagentrc`). One `KEY=VALUE` per line;
 * `#` comments + blank lines ignored; surrounding single/double quotes stripped;
 * `export ` prefix tolerated. Pure — string in, map out. Last assignment wins.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // Strip a trailing inline comment only when the value is unquoted.
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

/** Normalize a CredentialRef to `{ name, refPath }`. */
function normalizeRef(ref: CredentialRef): { name: string; refPath?: string } {
  if (typeof ref === "string") return { name: ref };
  return { name: ref.env, refPath: ref.path };
}

/**
 * Resolve a credential ref to its secret value by precedence (env → .env →
 * .mutagentrc), with an optional ref-pinned file tried FIRST. Pure: all I/O is
 * injected via `deps`. Returns the value + its source for transparency, or
 * { found:false } with the list of places tried.
 *
 * @param ref         bare env-var name, or { env, path }.
 * @param projectRoot the install/init dir (where `.env` + `.mutagentrc` live).
 * @param deps        injected env map + file reader.
 */
export function resolveCredential(
  ref: CredentialRef,
  projectRoot: string,
  deps: ResolveCredentialDeps,
): ResolveCredentialResult {
  const { name, refPath } = normalizeRef(ref);
  const tried: string[] = [];

  // 0. process.env always wins (CI / shell export).
  const envVal = deps.env[name];
  if (envVal !== undefined && envVal !== "") {
    return { found: true, value: envVal, source: "env", from: `process.env.${name}` };
  }
  tried.push(`process.env.${name}`);

  // 1. A ref-pinned explicit file (highest file priority when given).
  const fileTiers: { label: CredentialSource; file: string }[] = [];
  if (refPath) {
    fileTiers.push({ label: "ref-path", file: path.resolve(projectRoot, refPath) });
  }
  // 2./3. conventional files, in precedence order.
  fileTiers.push({ label: ".env", file: path.resolve(projectRoot, ".env") });
  fileTiers.push({ label: ".mutagentrc", file: path.resolve(projectRoot, ".mutagentrc") });

  for (const tier of fileTiers) {
    tried.push(tier.file);
    const content = deps.readFile(tier.file);
    if (content === null) continue;
    const parsed = parseDotenv(content);
    const val = parsed[name];
    if (val !== undefined && val !== "") {
      return { found: true, value: val, source: tier.label, from: tier.file };
    }
  }

  return { found: false, name, tried };
}

/** Real-fs file reader for the thin wrapper: contents or null (never throws). */
export function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Thin wrapper binding the REAL process.env + fs. App code calls this; tests call
 * the pure `resolveCredential` with injected deps.
 */
export function resolveCredentialLive(
  ref: CredentialRef,
  projectRoot: string,
): ResolveCredentialResult {
  return resolveCredential(ref, projectRoot, {
    env: process.env,
    readFile: readFileOrNull,
  });
}

// ---------------------------------------------------------------------------
// CLI — resolve a ref and report ONLY its source (never the secret value):
//   bun run scripts/resolve-credential.ts <ENV_VAR_NAME> [projectRoot]
// Exit 0 = found (prints source); exit 1 = not found (prints places tried).
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  const name = argv[2];
  const root = argv[3] ?? process.cwd();
  if (!name) {
    process.stderr.write("usage: resolve-credential.ts <ENV_VAR_NAME> [projectRoot]\n");
    return 1;
  }
  const res = resolveCredentialLive(name, root);
  if (res.found) {
    console.info(`[resolve-credential] FOUND ${name} via ${res.source} (${res.from}). Value NOT printed.`);
    return 0;
  }
  process.stderr.write(
    `[resolve-credential] NOT FOUND ${name}. Tried:\n  ${res.tried.join("\n  ")}\n`,
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
