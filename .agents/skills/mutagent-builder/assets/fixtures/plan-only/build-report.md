<!-- PLAN-ONLY FIXTURE (Wave 2B exit check: "PLAN-only fixture writes nothing before READY").
     This is a frozen build report at the end of B3 (PLAN) → B4 (architect plan-check). The BUILD
     RESULT section is intentionally ABSENT: no target file has been written, because the architect
     returned BLOCKED. It proves the pre-write gate holds — the engineer writes NOTHING until READY.
     Subject: the agent-support-triage canonical example → claude-code harness (markdown) target. -->
# BUILD Report — support-triage

| Field | Value |
|---|---|
| Spec | `.mutagent/specs/support-triage/agentspec.yaml` |
| Spec version | `1.0.0` |
| Kind | `Agent` |
| Decision log | `./agentspec.decisions.md` |
| Selected target | `claude-code` — `harness` / `claude-code` |
| Artifact | `markdown` → `.claude/agents/support-triage.md` |
| Code implementation | `n/a` (markdown target — no implementation.*) |
| Target root | `./` |
| Verdict | `PLAN — not yet executed` |

## PLAN · frozen before target writes

**Status:** `BLOCKED` — the operator must resolve `intent.unknowns[0]` ("Confidence threshold for
mandatory escalation") before task T2's check has an expected result. No target file is written while
BLOCKED.
**Inputs:** spec + selected target `claude-code` + fresh docs (`agent-format`) + repository snapshot
**Source digest:** `sha256:… (agentspec.yaml @ 1.0.0)`
**Goal:** A `.claude/agents/support-triage.md` harness agent that triages a ticket, cites evidence, and
never performs the `update-ticket` action without recorded approval.

| Task | Verifiable outcome | Exact artifacts | Components + why / doc source | Check → expected result |
|---|---|---|---|---|
| T1 | The harness agent file carries the sacred `systemPrompt` verbatim + the two context bindings (`ticket-record`, `account-record`). | `.claude/agents/support-triage.md` | Claude Code agent frontmatter + MCP tool bindings (doc: `agent-format`) — the harness binds MCP context reads natively. | `grep` the file for the verbatim systemPrompt + both MCP refs → both present. |
| T2 | The agent escalates instead of acting when confidence is below the mandatory-escalation threshold. | same file (workflow `classify → escalate` branch) | Canonical Workflow inline graph → harness prompt sections. | Run the `ambiguous-evidence` scenario → agent escalates, no `update-ticket`. **Expected result UNRESOLVED** — the threshold is `intent.unknowns[0]`. → **blocks READY**. |
| T3 | `update-ticket` is unreachable without an approval turn. | same file (workflow `propose → apply` gated by approval) | approval-gated action pattern (doc: `agent-format`). | Run the `rejected-update` scenario → no action call. |

**Build checks:** lint · typecheck · build · tests · coverage · target smoke  *(not run — PLAN is BLOCKED)*
**EVALUATE later (not run at BUILD):** the behavioral criteria `no-unapproved-write`, `grounded-route`
and the `triage-golden` dataset scenarios — judged at ③ EVALUATE, not at BUILD.

## Pinned docs crawled (fresh, by purpose)

- `agent-format` → `https://example.test/claude-code/agents` (crawled fresh at plan time).

## Planned hierarchy

```text
./.claude/agents/
└── support-triage.md        # (planned — NOT YET WRITTEN; blocked pending T2 threshold)
```

<!-- BUILD RESULT section is intentionally ABSENT: B5 has not run. Zero target files exist.
     The architect returned BLOCKED at B4; the engineer wrote nothing. When the operator resolves the
     escalation threshold, T2 gains an expected result, the architect can return READY, and only THEN
     does the BUILD RESULT section get appended with actual files + fidelity/loss table. -->
