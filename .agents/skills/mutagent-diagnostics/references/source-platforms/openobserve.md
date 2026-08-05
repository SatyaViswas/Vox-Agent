# OpenObserve — Source Platform Reference

> **POST-FLIP (UniTF):** the diagnostics skill does not fetch or normalize
> OpenObserve traces itself. Fetch + normalize live in `@mutagent/tools` and run
> UPSTREAM via `mutagent-cli trace fetch --platform openobserve …`, which emits a
> UniTF JSONL + `manifest.json`. The skill READS that handover via
> `scripts/normalize/read-unitf.ts` (Step 3.7). This doc is reference material for
> **shaping the upstream CLI query** (auth, endpoints, quirks). Run
> `mutagent-cli trace --help` for the fetch surface.
>
> Transport = **REST** (HTTP Basic auth). OpenObserve stores OpenTelemetry spans,
> so the adapter maps OpenObserve span rows → the shared OTel span shape and reuses
> the otel normalizer (`sourcePlatform: "openobserve"`). Upstream contract:
> `mutagent-tools/references/adapter-research/openobserve.md` (cited sources O1–O8).

## Access patterns

OpenObserve exposes two complementary trace endpoints; the adapter uses SQL search:

| Endpoint | Use |
|---|---|
| `GET /api/{org}/{stream}/traces/latest` | list recent trace summaries by window (root span only) |
| `POST /api/{org}/_search` | full SQL over spans — the adapter's primary path (window-scoped `SELECT * FROM "{stream}"`) |

The adapter runs a single window-scoped `_search`, pages by `from`/`size`, and
groups the returned span rows by `trace_id` into full `UnifiedTrace`s — no per-trace
N+1 request storm.

## Auth

HTTP Basic auth: `Authorization: Basic base64(email:password)`. Set env vars (read
at runtime, never hardcoded — the CLI passes only env-var NAME refs, not raw secrets):

```
OPENOBSERVE_URL=http://localhost:5080          # self-hosted; cloud: https://api.openobserve.ai
OPENOBSERVE_ORG=default                          # org id path segment (default "default")
OPENOBSERVE_STREAM=default                       # trace stream name (default "default")
# EITHER email + password (→ Basic base64(email:password)):
OPENOBSERVE_EMAIL=you@example.com
OPENOBSERVE_PASSWORD=...
# OR a single pre-issued token (cloud). If it starts with "Basic "/"Bearer " it is
# sent verbatim; otherwise it is sent as `Basic <token>`:
OPENOBSERVE_AUTH=...
```

`--endpoint-ref` / `--credential-ref` override the URL / auth env-var NAMES.

## CLI Operation Manual

```bash
# Size the window (cheap)
mutagent-cli trace count --platform openobserve --since 24h

# Fetch + normalize → UniTF JSONL + sibling manifest
mutagent-cli trace fetch --platform openobserve --since 24h \
  --export .mutagent/traces/oo1/traces.jsonl

# Pin a single trace
mutagent-cli trace fetch --platform openobserve --trace <trace_id> --since 7d
```

Window bounds are required by `_search`; when `--since/--until` are omitted the
adapter defaults to a 24h lookback ending at `now` so the required bounds hold.

## Filter/Search Support

| Filter | Support | How |
|---|---|---|
| Time window | ✅ | `start_time`/`end_time` (µs) — partition-pruned in `_search` |
| Single trace | ✅ | `WHERE trace_id = '…'` |
| Agent / service / keyword / scope | ⚠️ core-side | applied by the CLI's canonical filter pass over normalized UniTF |
| Error / feedback | ⚠️ derived | `span_status = "ERROR"` → UniTF `status: "error"`; derived client-side downstream |

## Quirks (grounded in the research doc's Open Questions)

- **Timestamp unit** (OO-G2): `_search` uses microseconds; some fields are nanoseconds.
  The adapter auto-detects by magnitude (µs vs ns vs ms vs s) — no unit assumption.
- **Root span sentinel** (OO-G1): `parent_span_id` may be `null`, `""`, or omitted —
  all three map to a root span.
- **GenAI attribute duality** (OO-G5/G6): GenAI fields appear both inside `attributes`
  (canonical dotted keys) and as promoted top-level columns. The adapter prefers the
  canonical `attributes` value; Mastra aliases (`ai_usage_*` / `ai_model_name`) fill the
  OTel semconv keys only when the canonical field is absent (priority: OTel > Mastra).
- **Stream name** (OO-G4): never hardcoded — `OPENOBSERVE_STREAM` (default `"default"`).
- **Cloud auth** (OO-G7): a cloud-issued token is supported via `OPENOBSERVE_AUTH`
  (Bearer/Basic pass-through). An MCP transport is a future task (UT-3), not built.

## Normalization (moved upstream — UniTF flip)

OpenObserve span rows → UniTF normalization lives in the `@mutagent/tools`
openobserve adapter and runs UPSTREAM via `mutagent-cli trace fetch --platform
openobserve --export <traces.jsonl>`. The skill READS the resulting UniTF JSONL
(+ manifest) via the single platform-agnostic reader:

```bash
bun scripts/cli/run.sh scripts/normalize/read-unitf.ts \
  --in <traces.jsonl> --manifest <manifest.json> \
  --out-metadata /tmp/traces-metadata.json --out-entity /tmp/entity-context.json
```

Reader: `scripts/normalize/read-unitf.ts` (+ `unitf-adapter.ts`). Run
`mutagent-cli trace --help` for the fetch surface.
