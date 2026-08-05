# BUILD Report — {{spec_id}}

| Field | Value |
|---|---|
| Spec | `{{spec_path}}` |
| Spec version | `{{spec_version}}` |
| Kind | `{{kind}}` |
| Decision log | `{{decisions_ref}}` |
| Selected target | `{{target_id}}` — `{{target_type}}` / `{{target_name}}` |
| Artifact | `{{artifact_format}}` → `{{artifact_path}}` |
| Code implementation | `{{implementation}}` (code targets only) |
| Target root | `{{target_root}}` |
| Verdict | `{{verdict}}` |

<!-- =========================================================================
     PLAN — frozen BEFORE any target write. Engineer drafts; architect checks
     read-only. Status must be READY before BUILD RESULT is written. A file
     list is NOT a plan: every task carries a goal, exact artifacts, a justified
     component choice with a doc source, and a check with an expected result.
     ========================================================================= -->
## PLAN · frozen before target writes

**Status:** `{{plan_status}}`  <!-- READY | BLOCKED — <reason / operator question> -->
**Inputs:** spec + selected target + fresh docs + repository snapshot
**Source digest:** `{{source_digest}}`
**Goal:** {{build_goal}}  <!-- user-observable target outcome -->

| Task | Verifiable outcome | Exact artifacts | Components + why / doc source | Check → expected result |
|---|---|---|---|---|
| T1 | {{t1_outcome}} | {{t1_artifacts}} | {{t1_components}} | {{t1_check}} |

**Build checks:** lint · typecheck · build · tests · coverage · target smoke
**EVALUATE later (not run at BUILD):** {{evaluate_deferred}}  <!-- behavioral criteria + dataset scenarios -->

## Pinned docs crawled (fresh, by purpose)

{{pinned_docs}}

## Planned hierarchy

```text
{{planned_tree}}
```

<!-- =========================================================================
     BUILD RESULT — appended AFTER execution of the READY plan. Records actual
     evidence and every deviation from PLAN. Silence about loss is a FAILURE.
     ========================================================================= -->
## BUILD RESULT · completed after execution

### Files changed

{{files_changed}}

### TDD gates

{{tdd_results}}

### Spec implementation coverage

{{coverage_table}}

### Fidelity + loss (silence about loss is a failure)

| Requirement | Where implemented | Check → observed | Disposition |
|---|---|---|---|
| {{req}} | {{impl_site}} | {{observed}} | honored / approximated / **unsupported** / weakened / omitted (+ reason, operator-approved exception) |

### Plan-to-actual delta

{{plan_delta}}

### Verifier findings

{{verifier_findings}}

## EVALUATE handoff bundle

{{evaluate_handoff}}
