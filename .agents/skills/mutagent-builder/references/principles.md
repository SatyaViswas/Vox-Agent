# mutagent-builder — Principles

## PR-BUILD-001 — Spec is the source of truth

`agentspec.yaml` is the Definition. BUILD implements it; implementation must not silently redefine the
agent's persona, operative system prompt, jobs, tools, runtime, or eval criteria.

## PR-BUILD-002 — Script only deterministic checks

`*sync-spec` is a composite agent/code hybrid. The script checks freshness and names the drift state;
`ai-architect` reads implementation content and drafts the sync plan; `ai-engineer` performs gated writes.
Do not grow the script into a source-reading spec generator.

## PR-BUILD-003 — Pinned docs are crawled fresh

Framework and provider docs from `appendix.framework_docs` are crawled at build time. A dead pin is an
escalation, not permission to guess APIs.

## PR-BUILD-004 — TDD is necessary, not sufficient

A green test suite proves only the code that exists. BUILD is complete only when lint/typecheck/build/test
AND `scripts/verify/spec-impl-coverage.ts` pass.

## PR-BUILD-005 — Verifier is read-only

`ai-architect` reruns deterministic gates and issues `PROCEED | STEER | ABORT`. It never writes source.

## PR-BUILD-006 — OPTIMIZE returns here for agentspec-backed implementation work

Evaluator and diagnostics remain judges/RCA. Approved agentspec-backed remedies are implemented by
`ai-engineer` and verified by `ai-architect`, then EVALUATE reruns.
