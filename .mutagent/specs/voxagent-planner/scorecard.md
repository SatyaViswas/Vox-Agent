# Phase 4 Baseline Scorecard — voxagent-planner

**24 real traces** (Phase 3) scored against **9 criteria** from `agentspec.yaml`.
**Run-level GATE: `fail`**

| Criterion | Class | Applicable | Pass | Fail | Indeterminate | Pass rate |
|---|---|---|---|---|---|---|
| no-guessed-required-param | code-check | 24 | 20 | 4 | 0 | 83% |
| no-opaque-id-asked | llm-judge | 7 | 7 | 0 | 0 | 100% |
| correct-route-classification | llm-judge | 24 | 24 | 0 | 0 | 100% |
| schema-aligned-execution | code-check | 0 | 0 | 0 | 0 | n/a (0 applicable) |
| step-handoff-placeholder | code-check | 3 | 3 | 0 | 0 | 100% |
| fan-out-shape | code-check | 3 | 3 | 0 | 0 | 100% |
| sheet-header-safety | code-check | 8 | 6 | 2 | 0 | 75% |
| event-trigger-modeling | code-check | 24 | 24 | 0 | 0 | 100% |
| browser-context-sufficiency | llm-judge | 3 | 3 | 0 | 0 | 100% |

## Failures (all criteria)
- **no-guessed-required-param** / `fan-01`: scenario is fully specified but needs_clarification=True unexpectedly (missing_parameters=[{'step_number': 2, 'parameter_key': 'table_name', 'label': 'Table Name', 'description': 'The name of the table in your Airtable base to add the records to.', 'suggested_type': 'string'}])
- **no-guessed-required-param** / `bpt-02`: scenario is fully specified but needs_clarification=True unexpectedly (missing_parameters=[{'step_number': 1, 'parameter_key': 'username', 'label': 'Username', 'description': 'The username for the college portal.', 'suggested_type': 'string'}, {'step_number': 1, 'parameter_key': 'password', 'label': 'Password', 'description': 'The password for the college portal.', 'suggested_type': 'string'}])
- **no-guessed-required-param** / `srw-02`: scenario is fully specified but needs_clarification=True unexpectedly (missing_parameters=[{'step_number': 1, 'parameter_key': 'table_name', 'label': 'Table Name', 'description': 'The name of the table inside the Airtable base to add the record to.', 'suggested_type': 'string'}])
- **no-guessed-required-param** / `bpt-03`: scenario is fully specified but needs_clarification=True unexpectedly (missing_parameters=[{'step_number': 1, 'parameter_key': 'credentials', 'label': 'Library Portal Credentials', 'description': 'Username and password for the library portal.', 'suggested_type': 'string'}])
- **sheet-header-safety** / `ctfm-01`: step(s) [1] write to a spreadsheet/table app without a headers parameter
- **sheet-header-safety** / `msh-03`: step(s) [3] write to a spreadsheet/table app without a headers parameter