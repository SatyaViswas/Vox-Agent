# Phase 5 Diagnosis Report — voxagent-planner

Three `diagnostics-analyzer` leaves independently root-caused every routed Phase 4 failure plus two out-of-band findings. All evidence is cited to real file:line locations; nothing below is asserted without a re-checkable reference in `diagnose-finding-{1,2,3}.json`.

## Global ranked remedy list (for Phase 6 `*optimize`)

| Rank | Remedy | Target | Cost | Correctness | Type |
|---|---|---|---|---|---|
| **1** | **R-B1** — Add Rule 7 (credentials are out-of-band, never a parameter) | `planner.py` system prompt | low | high | **real product defect — security-relevant** |
| 2 | R-B2 — Add `no-credential-parameter-request` criterion + `authenticated-browser-portal` scenario | `agentspec.yaml` | low | high | eval coverage (companion to #1) |
| 3 | Fix `no-guessed-required-param` tier-0 check (scenario-gate + implement clause 2) | eval harness (`tier0_code_checks.py`) | low | high | eval-instrument fix |
| 4 | Amend Rule 2 so a flagged missing parameter is never *also* invented as a literal | `planner.py` system prompt | low | medium | real product defect (minor) |
| 5 | Fix `sheet-header-safety` tier-0 check (gate on write-shape, not app name) | eval harness | low | high | eval-instrument fix (no planner defect) |
| 6 | R-A2 — Add `plausible-action-slug-and-params` proxy criterion | `agentspec.yaml` | low | medium | eval coverage |
| 7 | R-A3 — Mark `schema-aligned-execution` as `blocked-on-dataset` | `agentspec.yaml` | low | medium | reporting hygiene |
| 8 | R-A1 — Two-stage traces (join real execution outcomes) | Phase-3 methodology + `orchestrator.py` instrumentation | medium | high | future infrastructure |
| 9 | R-B3 — Redact credential-shaped keys at the execution boundary | `orchestrator.py` (defense-in-depth) | medium | medium | out of this spec's target — file separately |

**Ranks 1-5 are in-scope for this ADL pass's target (`planner.py` + the eval harness) and should drive Phase 6.** Ranks 6-9 are legitimate but lower-urgency (eval-infrastructure investment or explicitly out-of-target-scope) — noted for the record, not blocking the optimize loop.

---

## Finding 1 — `no-guessed-required-param` (4 "failures": fan-01, bpt-02, srw-02, bpt-03)

**Verdict: split cluster, no single root cause.**

- **fan-01 / srw-02 (Airtable `table_name`)**: NOT an over-triggering defect — the dataset seed only named the *base*, and a base holds multiple tables, so asking is correct. **But** both blueprints simultaneously **invent a literal value** for the exact field they flag as missing (`table_name: "Blog Posts"` — a value that appears nowhere in the prompt) — a real violation of Rule 2's own "do NOT invent" clause, and of the criterion's unimplemented second clause. `WHAT=hallucination · WHY=prompt-underspec · WHERE=system-prompt`.
- **bpt-02 / bpt-03 (credentials)**: genuine planner defect — see Finding 3/Gap B below, which subsumes this. `WHAT=wrong-output · WHY=prompt-underspec · WHERE=system-prompt`.
- **The tier-0 check itself is also wrong**: it inferred "should this need clarification" from the *scenario label* rather than the prompt content, so 2 of these 4 "failures" are eval-instrument noise, not planner behavior. Full replacement code in `diagnose-finding-1.json`.

## Finding 2 — `sheet-header-safety` (2 "failures": ctfm-01, msh-03)

**Verdict: pure eval-instrument false positive. No planner defect.**

Both blueprints are correct. The tier-0 check gated on *app name* (any Notion step needs `headers`), but `msh-03` creates a standalone Notion **page** (no rows, no columns — Rule 6 never applies) and `ctfm-01` uses `NOTION_CREATE_DATABASE_PAGE`, which is **key-addressed** (`properties: {...}`) rather than **positional** — Rule 6's stated harm (a positional row-add tool silently treating the first row as headers) cannot occur on a key-addressed write. The analyzer verified the proposed fix against all 15 relevant traces: only the 2 false positives flip, zero true positives lost.

## Finding 3, Gap A — `schema-aligned-execution` (0/24 applicable)

**Verdict: not a planner defect — structurally unscorable from this trace source.** All 24 Phase-3 traces capture only `planner.generate_blueprint()`'s output; the criterion's pass condition (a `needs_input` pause from `composio_engine.py`'s live schema alignment) is produced by code that never ran during capture. Even an `execution_logs` replay can't rescue this today — `_log_entry()` doesn't record parameters, only status. Fixing this requires two-stage trace capture (R-A1), which is future infrastructure investment, not a Phase 6 fix.

## Finding 3, Gap B — the credential-handling defect (bpt-02, bpt-03)

**Verdict: the single most important finding of this ADL pass.** Both authenticated `browser-portal-task` traces ask the user for raw `username`/`password`/`credentials` as blueprint parameters. VoxAgent's real architecture resolves browser-session credentials from the App Vault (`vault.get_app_credentials(user_id, app_name)`, Fernet-encrypted) — **no code path anywhere reads a step parameter as an authentication input.** Worse: if a user answers the bogus clarification, the password is string-joined verbatim into the Gemini browser-task prompt (`orchestrator.py:301-305`) and echoed into the live telemetry stream / `execution_logs` (`orchestrator.py:855`) — **a plaintext-credential leak path**, while still never authenticating anything. All 9 scored criteria passed these traces because none of them inspects *what* a `missing_parameters` entry asks for. `planner.py`'s system prompt has zero mention of credentials, login, or the vault; Rule 2's only forbidden-ask carve-out is opaque IDs. `bpt-03`'s own clarification text ("...or ensure they are saved in your secure vault") shows the model has latent knowledge of the vault and just needs an explicit rule.

**Remedy (R-B1)** is a fully-drafted Rule 7 insertion for `planner.py`'s `get_system_prompt()` (exact before/after diff in `diagnose-finding-3.json`), plus a companion eval criterion (R-B2) so this can never silently regress again, plus an optional defense-in-depth redaction at the orchestrator layer (R-B3, explicitly out of this spec's target — filed for the record, not for this optimize pass).

---

*Full evidence, why-chains, and exact apply instructions for every remedy: `diagnose-finding-1.json`, `diagnose-finding-2.json`, `diagnose-finding-3.json`.*
