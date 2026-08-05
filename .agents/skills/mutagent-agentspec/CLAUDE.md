# mutagent-agentspec — skill nav map (lean)

> Lean per-skill navigation. The substantive surface is `SKILL.md`. This file points.

`mutagent-agentspec` is the **ADL ① SPEC** stage: a guided requirements interview that emits a
portable, validated `agentspec.yaml`. The spec is the **Definition** (the interface — *what* the
agent IS); `mutagent-builder` later implements it via `*build`. The parent session IS the domain
orchestrator — it runs the interview itself and does **NOT** dispatch a coordinator sub-agent.

## Where everything lives

| You want… | Read |
|---|---|
| The skill surface (frontmatter · §0 setup · §0.1 star-commands · triggers · architecture) | `SKILL.md` |
| The `*spec` interview FSM (+ BUILD/EVALUATE handoffs) | `references/workflows/orchestrator-protocol.md` |
| Operative design principles (PR-NNN, operator-locked) | `references/principles.md` |
| Machine-readable requirements hub (REQ-NNN) | `references/requirements.yaml` |
| Pinned framework docs carried into BUILD | `references/frameworks/doc-pins.md` |
| The `agentspec.yaml` schema (TypeBox, versioned `agentspec.mutagent.io/v0.3.0`) | `scripts/contract/agentspec.schema.ts` |
| The SEMANTIC gate (kind leakage · graphs · member cycles · bounded loops · ref resolution) | `scripts/validate/semantic-validator.ts` |
| The schema gate (CLI: structural + semantic + FS decision-sidecar) | `scripts/validate/validate-spec.ts` |
| The normative 0.3.0 field catalog + implementation resolutions | `references/agentspec-0.3-field-catalog.md` |
| The worked, validated example spec (init scaffold) | `assets/templates/agentspec.yaml.tpl` |
| The four canonical commented examples (one per kind) | `assets/examples/{agent,skill,multiagent,workflow}-*/agentspec.yaml` |
| The valid/invalid fixture set | `assets/examples/` (valid) · `assets/fixtures/invalid/` (one violation each) |
| The four-kind interview-ordering fixtures | `assets/fixtures/interview/{agent,skill,multiagent,workflow}-interview.md` |
| The constitution pointer + in-repo PRD link | `.meta/design-principles.md` |

## Standalone

This SPEC skill dispatches no build sub-agents. The `*build` handoff to `mutagent-builder` and the
`*eval` handoff to an evaluator are designed composition boundaries mentioned at the doc/protocol
level only — never a code import.
