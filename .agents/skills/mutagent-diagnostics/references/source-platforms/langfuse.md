# Langfuse — Source Platform Reference

> **POST-FLIP (UniTF):** the diagnostics skill no longer fetches or normalizes
> Langfuse traces itself. Fetch + normalize now live in `@mutagent/tools` and run
> UPSTREAM via `mutagent-cli trace fetch --platform langfuse …`, which emits a
> UniTF JSONL + `manifest.json`. The skill READS that handover via
> `scripts/normalize/read-unitf.ts` (Step 3.7). This doc is now reference material
> for **shaping the upstream CLI query** (filter coverage, quirks, CLI-vs-REST).
> Run `mutagent-cli trace --help` for the fetch surface.

> CLI-first per PR-001 and OQ-1 (REST fallback only when the CLI cannot express
> the operation — see CLI vs REST below).
> **Official CLI docs: https://langfuse.com/docs/api-and-data-platform/features/cli**
> Upstream docs: https://langfuse.com/docs
> Public API reference: https://api.reference.langfuse.com

## Why a CLI (and why clients will have one)

Langfuse CLIs are the **primary way sources and targets interact with + update
trace data** in a Langfuse deployment; the **REST API is the fallback** for
operations the CLI cannot express. Clients running diagnostics will most often
have either the `langfuse` CLI installed or Langfuse-as-platform reachable, so
the skill's fetch layer is CLI-first (`langfuse traces list --json`) and degrades
to the documented REST endpoints when the CLI is absent or a filter is
CLI-unsupported. The skill must stay compatible with both surfaces.

## Install

> Official CLI docs: https://langfuse.com/docs/api-and-data-platform/features/cli
>
> During onboarding the skill checks whether the `langfuse` CLI is on PATH
> (`scripts/setup/detect.ts --cli langfuse`). If it is MISSING, onboarding shows
> this docs link + the install command below and **asks for explicit approval
> before installing** (approve-to-install gate, PR-021 — see
> `references/workflows/onboarding.md` Phase 2). It NEVER auto-installs; on decline
> the skill continues via the REST fallback documented under "CLI vs REST" below.

```bash
pip install langfuse   # Python SDK + CLI
# OR
npm install -g langfuse
```

## Auth

Set in `.mutagentrc` (or the environment — the skill reads them at runtime,
never hardcoded):
```
LANGFUSE_SECRET_KEY=sk-...
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_HOST=https://cloud.langfuse.com  # or self-hosted URL (local dev: http://localhost:3033)
```

## CLI Operation Manual

### List traces (with filters)

```bash
langfuse traces list \
  --from "7daysAgo" \
  --to "now" \
  --agent-id "search-agent" \
  --has-feedback \
  --score-below 3 \
  --has-error \
  --limit 100 \
  --json
```

> POST-FLIP: the arg-builder + REST pager that used to live in the skill
> (`scripts/fetch/langfuse.ts`) were REMOVED. The upstream `mutagent-cli trace
> fetch --platform langfuse` (in `@mutagent/tools`) now owns these flags and the
> CLI-vs-REST fallback; the flags above document the query surface it accepts.

### Fetch single trace (with observations)

```bash
langfuse traces get --trace-id tr_abc123 --json
```

### List scores (for scale auto-discovery)

```bash
langfuse scores list --limit 100 --json
```

### Filter by skill tag

```bash
langfuse traces list --tag "skill:mutagent-diagnostics" --json
```

---

## Filter-Coverage Matrix — what we can ACTUALLY filter on

> **Operator priority (Wave-5.1).** Empirically verified 2026-06-01 against a
> live local Langfuse stack (docker-compose, `:3033`) using the public REST API
> `GET /api/public/traces`. The CLI flags above are sugar over these same REST
> filters; an operation is only as reliable as its underlying REST/field support.
>
> **KEY FINDING — Langfuse has NO native "agent ID".** There is no first-class
> agent identifier on a trace. The skill approximates an agent by:
> `trace.name` (the closest proxy — exact-match filterable), `tags`
> (e.g. `skill:<name>`, `host:<runtime>`), or `metadata.*` (NOT server-side
> filterable — must post-filter client-side). Plan diagnostics scoping around
> `name` + `tags`, not an agent-ID.

| Operation (filter on…) | Supported? | Via which field | REST param (`/api/public/traces`) | CLI flag | Notes |
|---|---|---|---|---|---|
| Agent identity | ⚠️ proxy only | `trace.name` (exact) **or** `tags` | `name=` / `tags=` | `--agent-id`* / `--tag` | No native agent-ID; `--agent-id` maps to a `name`/`tag` proxy. |
| Trace name | ✅ yes | `trace.name` | `name=` (EXACT match) | `--agent-id`* | `name=probe` → hit; `name=prob` → 0. No prefix/substring. |
| Tags | ✅ yes | `trace.tags[]` | `tags=` | `--tag` | Matches traces carrying the tag (`skill:mutagent-diagnostics` → 3). |
| Metadata | ❌ no (server) | `trace.metadata.*` | — (ignored) | — | `metadata=` is silently ignored — returns ALL. Post-filter client-side. |
| User ID | ✅ yes | `trace.userId` | `userId=` | — | Native column. `userId=` filters server-side (often null in our traces). |
| Session ID | ✅ yes | `trace.sessionId` | `sessionId=` | `--session-id` | Exact match (`sessionId=probe-…` → 1). |
| Time window | ✅ yes | `trace.timestamp` | `fromTimestamp=` / `toTimestamp=` | `--from` / `--to` | ISO8601 server-side; CLI also accepts relative (`7daysAgo`). |
| Environment | ✅ yes | `trace.environment` | `environment=` | — | Native column (`default`). |
| Release / Version | ✅ yes | `trace.release` / `.version` | `release=` / `version=` | — | Native columns. |
| Order | ✅ yes | any sortable column | `orderBy=timestamp.desc` | — | e.g. `timestamp.desc`. |
| **Score value / threshold** | ❌ NOT on traces-list | — | — (ignored on `/traces`) | `--score-below`† | `scoreValue=`/`minScore=` are IGNORED by `/api/public/traces`. Use `/api/public/scores` then join, OR client-side post-filter on the embedded `scores[]`. |
| **Error / level=ERROR** | ❌ NOT on traces-list | observation `.level` | — (ignored on `/traces`) | `--has-error`† | `level=`/`hasError=` are IGNORED by `/api/public/traces`. Use `GET /api/public/observations?level=ERROR` then join to traces, OR client-side post-filter. |
| **Has-feedback** | ⚠️ derived | embedded `scores[]` | — | `--has-feedback`† | No native traces-list param. Derived client-side: `trace.scores.length > 0` (this is what `normalizeLangfuseTrace` does). |

`*` `--agent-id` is a convenience flag in the skill's arg-builder; it has no
native Langfuse equivalent — it routes to a `name`/`tag` proxy filter.
`†` `--score-below` / `--has-error` / `--has-feedback` are CLI conveniences. They
are NOT supported as native `/api/public/traces` query params: the traces-list
endpoint silently ignores unknown params (returns the full set). Where the CLI
implements them it does so via the scores/observations endpoints or by
client-side post-filtering. The skill's tier0 census
(`scripts/tier0/langfuse.ts`) computes error/feedback/low-score rates
CLIENT-SIDE from the normalized `TraceMetadata`, so coverage does not depend on
server-side support for these three.

### Semantic search

- Semantic / free-text search across trace content: **NOT supported.**

---

## CLI vs REST — operational reality (Wave-5.1)

| Need | CLI (`langfuse …`) | REST fallback | Skill behavior |
|---|---|---|---|
| List traces in a window | `traces list --from … --json` | `GET /api/public/traces?fromTimestamp=…` | `mutagent-cli trace fetch --platform langfuse` (upstream; CLI-first, REST fallback when the `langfuse` CLI is absent). |
| Single trace + observations | `traces get --trace-id … --json` | `GET /api/public/traces/{id}` | upstream CLI fetch → UniTF; the skill reads the projected trace. |
| Error filtering | `--has-error` (CLI sugar) | `GET /api/public/observations?level=ERROR` | tier0 derives `hasError` client-side from observations. |
| Score / low-score filtering | `--score-below N` (CLI sugar) | `GET /api/public/scores` + join | tier0 derives low-score client-side from embedded `scores[]`. |
| Seeding test traces | — | `POST /api/public/ingestion` (async worker) | T2 integration seeds SYNTHETIC traces this way (NO client data). |

The fetch→normalize half of this chain (and its live REST-backed verification)
now lives in `@mutagent/tools`; the skill consumes the resulting UniTF. Any
operation the CLI cannot express (score/level/metadata server-side filtering)
falls back to REST or client-side post-filtering as noted above — handled
upstream by `mutagent-cli trace fetch`, not by the skill.

> Note: the internal `.claude/skills/langfuse-cli/` toolkit is a benchmark
> cross-verification tool for dev use — it is NOT this skill's source/target
> adapter. The source/target interaction surface is the public `langfuse` CLI
> (CLI-first) + the public REST API (fallback).

## Normalization (moved upstream)

Langfuse-record → UniTF normalization is owned by the `@mutagent/tools` langfuse
adapter and produced by `mutagent-cli trace fetch --platform langfuse --export
<traces.jsonl>`. Inside the skill there is a SINGLE platform-agnostic read path:

```bash
# Read the handed-over UniTF JSONL (+ manifest) → TraceMetadata[] + EntityContext:
bun scripts/cli/run.sh scripts/normalize/read-unitf.ts \
  --in <traces.jsonl> --manifest <manifest.json> \
  --out-metadata /tmp/traces-metadata.json --out-entity /tmp/entity-context.json
```

Reader: `scripts/normalize/read-unitf.ts` (+ `unitf-adapter.ts`). The per-platform
Langfuse normalizer + its live round-trip verification now live in
`@mutagent/tools`.
