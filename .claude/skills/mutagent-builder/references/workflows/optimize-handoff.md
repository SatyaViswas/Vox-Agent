# mutagent-builder — OPTIMIZE Handoff

Evaluator remains judge-only. Diagnostics remains RCA/apply-dispatch for non-agentspec targets. When a
remedy is agentspec-backed and requires code/spec/implementation change, the implementation leg returns
to BUILD.

## EDD request path

1. Evaluator emits `AddChangeRequest` / `EddChangeRequest` with grounded failing cases, remedy target
   (`agentspec` or `impl`), and proposed remedy hypothesis.
2. `ai-engineer` validates and reproduces the grounded defect.
3. If `remedyTarget: agentspec`, `ai-engineer` amends the Definition, validates it, reruns BUILD, TDD,
   and coverage. Set `rebuilt: true` in `ChangeRequestResponse`.
4. If `remedyTarget: impl`, `ai-engineer` amends implementation only, then reruns TDD and coverage.
5. `ai-architect` verifies and returns `PROCEED | STEER | ABORT`.
6. Evaluator reruns after `ChangeRequestResponse`; BUILD does not self-certify eval success.

## Diagnostics apply branch

If diagnostics has an approved remedy packet for an agentspec-backed subject and the remedy requires a
code/spec/implementation change, diagnostics emits the packet to `mutagent-builder`; `ai-engineer`
implements/amends; `ai-architect` verifies; evaluator reruns. Diagnostics apply workers continue to own
legacy local markdown targets, remote REST targets, report-only, and non-agentspec adapter cases.
