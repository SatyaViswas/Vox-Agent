# Support Triage Agent — decision log

> Colocated rationale sidecar for `agentspec.yaml` (N03). The YAML is current normative truth; this
> file explains alternatives, rationale, impact, amendment, and supersession. It cannot introduce
> required behavior absent from the YAML or silently override the card. The pair travels together as
> one portable bundle (interview, reverse sync, Builder handoff, public promotion).

## D-01 · Kind = Agent (not Workflow)

- **Selection:** `kind: Agent` with an embedded canonical Workflow.
- **Alternatives:** a standalone `kind: Workflow` graph with no persona.
- **Rationale:** triage requires an operative persona + sacred system prompt (privacy stance, "never
  contact customers") that a bare graph cannot carry. The graph is the control flow *within* the
  agent, not the resource itself.
- **Status:** accepted.

## D-02 · Approval-gated single action

- **Selection:** exactly one outbound action (`update-ticket`), approval `policy: required`.
- **Rationale:** the only external write must be human-gated with recorded evidence; refunds/billing
  are `nonGoals` so no connector for them exists.
- **Affected requirements:** criterion `no-unapproved-write`; scenario `rejected-update`.

## D-03 · Two targets (harness + framework)

- **Selection:** Claude Code (markdown) and Mastra (code).
- **Rationale:** proves target-independent intent — same permissions/workflow behavior, different
  syntax. Only the code target carries `implementation.*` (N04).

## Unknowns still open

- Confidence threshold for mandatory escalation (`intent.unknowns[0]`) — a Builder must request a
  decision rather than guess a numeric cutoff.
