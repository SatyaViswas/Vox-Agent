# Local JSONL — Source Platform Reference

> For `.jsonl` / `.ndjson` trace files on the local filesystem.
> No CLI needed — pure file reads.
>
> The ensure-cli gate (PR-021 — `references/workflows/onboarding.md` Phase 2)
> reports `status: not-required` for this source: there is no platform CLI to
> install. Filtering is client-side via `grep`/`jq` (see below). Tooling docs:
> `jq` — https://jqlang.github.io/jq/manual/ (optional, for advanced filtering).

## Format

One JSON object per line. Flexible schema — unknown fields are ignored.

Minimal required fields for a trace:
```json
{"id": "tr_001", "messages": [...], "startTime": "2026-05-27T10:00:00Z"}
```

## Fetching traces (filter examples)

```bash
# All traces with errors:
grep '"hasError":true' traces.jsonl

# By agent ID:
grep '"agentId":"search-agent"' traces.jsonl

# By time window (using jq):
jq 'select(.startTime >= "2026-05-20")' traces.jsonl

# With feedback:
grep '"hasFeedback":true' traces.jsonl
```

## Filter/Search Support

See `references/filter-search-matrix.md`. All filtering is post-read client-side. Full grep/jq support on all dimensions. Semantic search not supported.

## Normalization (moved upstream — UniTF flip)

The skill no longer normalizes local NDJSON itself. `mutagent-cli trace fetch
--platform local-ndjson --export <traces.jsonl>` (in `@mutagent/tools`) reads the
raw file and emits a UniTF JSONL + `manifest.json`; the skill READS that handover
via the single platform-agnostic reader:

```bash
bun scripts/cli/run.sh scripts/normalize/read-unitf.ts \
  --in <traces.jsonl> --manifest <manifest.json> \
  --out-metadata /tmp/traces-metadata.json --out-entity /tmp/entity-context.json
```

Reader: `scripts/normalize/read-unitf.ts` (+ `unitf-adapter.ts`). The bad-line
tolerance (blank lines skipped; malformed lines counted-but-visible, F-S7) is
preserved by the reader. Run `mutagent-cli trace --help` for the fetch surface.
