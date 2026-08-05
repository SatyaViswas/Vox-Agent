<!-- @mutagent/helix boot -->
# Helix — MutagenT ADL conductor

This project has the Helix orchestrator installed. To boot it, read and adopt the agent
definition at `.agents/skills/mutagent-helix/orchestrator.md` (run its activation-instructions: persona → system index →
ADL dashboard), then await a `*command`.

Trigger: `*mutagent` · `/mutagent-helix` · `boot`.

DASHBOARD RENDERING — HARD RULE (Codex): on `*mutagent`/`boot`/`*help`/`*status`, output the
orchestrator's `help-display-template` VERBATIM inside a fenced `text` code block. Preserve its
EXACT shape — the boxed MUTAGENT header (box-drawing chars), every panel (lifecycle · system index ·
setup/onboarding · state), and the command roster. Replace ONLY the `{placeholder}` tokens with
live values; change NOTHING else. Do NOT summarize, shorten, paraphrase, drop panels, or convert it
to Markdown headings/tables/bullets unless the operator explicitly asks for a condensed view.
<!-- @mutagent/helix boot -->
