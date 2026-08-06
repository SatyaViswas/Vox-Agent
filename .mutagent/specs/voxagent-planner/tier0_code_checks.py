"""Phase 4, Tier-0 pre-pass — deterministic code-check criteria decided WITHOUT
any judge call, per mutagent-evaluator's "code before judge" principle
(check_method: deterministic). Covers 5 of the spec's 6 code-check criteria;
`schema-aligned-execution` is explicitly marked out-of-scope for this trace
source (see note below) rather than faked.

Criteria NOT handled here (routed to real `evaluator` judge dispatches):
no-opaque-id-asked, correct-route-classification, browser-context-sufficiency
(all type: llm-judge in agentspec.yaml).
"""
import json

TRACES_PATH = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner/traces/planner-eval-traces.jsonl"
OUT_PATH = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner/tier0-verdicts.json"

AMBIGUOUS_SCENARIO = "ambiguous-recipient-or-target"
CLARIFICATION_EXPECTED = {"ambiguous-recipient-or-target"}
CLARIFICATION_FORBIDDEN = {"well-specified-happy-path"}


def check_no_guessed_required_param(bp, scenario):
    needs_clar = bp.get("needs_clarification", False)
    missing = bp.get("missing_parameters", []) or []
    steps = bp.get("steps", []) or []

    # Clause 2 of agentspec.yaml:164 — applies to EVERY scenario: a parameter
    # declared missing must not also carry an invented literal in the step body.
    contradicted = [
        mp.get("parameter_key")
        for mp in missing
        for s in steps
        if s.get("step_number") == mp.get("step_number")
        and mp.get("parameter_key") in (s.get("parameters") or {})
    ]
    if contradicted:
        return "fail", (
            f"parameter(s) {contradicted} are listed in missing_parameters AND carry an "
            f"invented literal in the same step's parameters (criterion clause 2)"
        )

    if scenario in CLARIFICATION_EXPECTED:
        if needs_clar and missing:
            return "pass", f"scenario requires clarification; needs_clarification=True with {len(missing)} missing_parameters entr(ies)"
        return "fail", f"scenario requires clarification but needs_clarification={needs_clar}, missing_parameters={missing}"

    if scenario in CLARIFICATION_FORBIDDEN:
        if not needs_clar:
            return "pass", "control scenario is fully specified and did not over-trigger clarification"
        return "fail", f"control scenario is fully specified but needs_clarification=True unexpectedly (missing_parameters={missing})"

    return "n/a", (
        "this scenario's expectedBehavior (agentspec.yaml) asserts a structural property, not "
        "clarification-completeness; clause-1 over-trigger is only decidable for "
        "well-specified-happy-path. Clause 2 (no invented value) was checked and passed."
    )


def check_step_handoff_placeholder(bp, scenario):
    if scenario != "multi-step-handoff":
        return "n/a", "criterion only checked for multi-step-handoff scenario"
    steps = bp.get("steps", [])
    if len(steps) < 2:
        return "fail", f"expected >=2 steps for a handoff scenario, got {len(steps)}"
    found_placeholder = False
    literal_suspect = False
    for step in steps[1:]:
        for k, v in (step.get("parameters") or {}).items():
            if isinstance(v, str) and ("step_" in v and "_result" in v) and ("{" in v):
                found_placeholder = True
    if found_placeholder:
        return "pass", "a downstream step references an earlier step's output via the {step_N_result} placeholder convention"
    return "fail", "no downstream step uses the {step_N_result} placeholder — likely fabricated a literal instead"


def check_fan_out_shape(bp, scenario):
    if scenario != "fan-out-batch":
        return "n/a", "criterion only checked for fan-out-batch scenario"
    steps = bp.get("steps", [])
    if len(steps) != 2:
        return "fail", f"expected exactly 2 steps (ai_generate + for_each consumer), got {len(steps)}"
    s1, s2 = steps[0], steps[1]
    if s1.get("route") != "ai_generate":
        return "fail", f"step 1 route should be ai_generate, got {s1.get('route')}"
    if not s2.get("for_each"):
        return "fail", "step 2 has no for_each set"
    params2 = json.dumps(s2.get("parameters") or {})
    if "item" not in params2:
        return "fail", "step 2 parameters do not reference {{item}}"
    return "pass", "canonical two-step ai_generate + for_each/{{item}} pattern present"


# Rule 6 exists to prevent ONE pathology: a POSITIONAL row append where the tool
# infers column identity from the first row and silently eats it. That pathology
# cannot occur when (a) the action is not a row append at all (e.g. creating a
# standalone Notion page), or (b) the payload is KEY-ADDRESSED and already names
# its own columns (e.g. Notion `properties: {"Status": ...}`). Gate on the write
# SHAPE, not on the app name.
POSITIONAL_ROW_VERBS = (
    "ADD_ROW", "APPEND_ROW", "INSERT_ROW", "CREATE_ROW",
    "ADD_RECORD", "CREATE_RECORD", "BATCH_UPDATE",
)


def _is_positional_row_write(step):
    action = (step.get("action") or "").upper()
    if not any(verb in action for verb in POSITIONAL_ROW_VERBS):
        return False  # not a row append (page/doc creation, reads, searches)
    params = step.get("parameters") or {}
    properties = params.get("properties")
    if isinstance(properties, dict) and properties:
        return False  # key-addressed: column names already carried as keys
    return True


def check_sheet_header_safety(bp, scenario):
    steps = bp.get("steps", [])
    sheet_apps = {"google sheets", "airtable", "notion"}
    relevant_steps = [
        s for s in steps
        if (s.get("app") or "").strip().lower() in sheet_apps
        and _is_positional_row_write(s)
    ]
    if not relevant_steps:
        return "n/a", "no step performs a positional structured row write"
    missing = [s["step_number"] for s in relevant_steps if "headers" not in (s.get("parameters") or {})]
    if missing:
        return "fail", f"step(s) {missing} append positional row(s) without a headers parameter"
    return "pass", f"all {len(relevant_steps)} positional row-write step(s) include a headers parameter"


def check_event_trigger_modeling(bp, scenario):
    trigger = bp.get("trigger") or {}
    trigger_type = trigger.get("type")
    if scenario == "reactive-trigger":
        if trigger_type == "webhook" and trigger.get("event_app"):
            return "pass", f"trigger.type=webhook with event_app={trigger.get('event_app')!r} set"
        return "fail", f"reactive request but trigger.type={trigger_type!r}, event_app={trigger.get('event_app')!r}"
    else:
        if trigger_type != "webhook":
            return "pass", f"non-reactive request correctly did not set trigger.type=webhook (got {trigger_type!r})"
        return "fail", f"non-reactive request incorrectly set trigger.type=webhook"


def check_schema_aligned_execution(bp, scenario):
    return "n/a", ("out of scope for this trace source — this criterion is explicitly jointly owned by the "
                    "planner and composio_engine.py's RUNTIME schema-alignment layer (per the criterion's own "
                    "description in agentspec.yaml). Our Phase 3 traces capture only the PLANNING stage "
                    "(generate_blueprint output), not actual execution against Composio, so this criterion "
                    "cannot be measured from this trace source. Flagged honestly rather than faked; would "
                    "require execution-level traces (e.g. from real orchestrator.py runs) to evaluate.")


CHECKS = {
    "no-guessed-required-param": check_no_guessed_required_param,
    "step-handoff-placeholder": check_step_handoff_placeholder,
    "fan-out-shape": check_fan_out_shape,
    "sheet-header-safety": check_sheet_header_safety,
    "event-trigger-modeling": check_event_trigger_modeling,
    "schema-aligned-execution": check_schema_aligned_execution,
}


def main():
    with open(TRACES_PATH) as f:
        traces = [json.loads(l) for l in f]

    results = {}
    for t in traces:
        trace_id = t["trace_id"]
        scenario = t["metadata"]["scenario"]
        bp = t["output"]["blueprint"]
        per_criterion = {}
        for crit_id, fn in CHECKS.items():
            verdict, note = fn(bp, scenario)
            per_criterion[crit_id] = {"verdict": verdict, "note": note, "method": "code-check (tier-0)"}
        results[trace_id] = {"scenario": scenario, "criteria": per_criterion}

    with open(OUT_PATH, "w") as f:
        json.dump(results, f, indent=2)

    # Summary
    from collections import Counter
    for crit_id in CHECKS:
        counts = Counter(results[tid]["criteria"][crit_id]["verdict"] for tid in results)
        print(f"{crit_id}: {dict(counts)}")

    print(f"\nWrote tier-0 verdicts for {len(results)} traces to {OUT_PATH}")


if __name__ == "__main__":
    main()
