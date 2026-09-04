"""Phase 4 aggregation — folds the tier-0 code-check verdicts and the 4 real
`evaluator` judge-dispatch batches into one scorecard.json matching the
documented mutagent-evaluator output shape (§3.1), plus a human-readable
scorecard.md summary with the GATE verdict.
"""
import json
import glob

BASE = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner"

with open(f"{BASE}/tier0-verdicts.json") as f:
    tier0 = json.load(f)

judge_verdicts = {}
for path in sorted(glob.glob(f"{BASE}/judge-batch-*.json")):
    with open(path) as f:
        batch = json.load(f)
    for item in batch:
        judge_verdicts[item["trace_id"]] = item["criteria"]

CRITERIA_IDS = [
    "no-guessed-required-param",
    "no-opaque-id-asked",
    "correct-route-classification",
    "schema-aligned-execution",
    "step-handoff-placeholder",
    "fan-out-shape",
    "sheet-header-safety",
    "event-trigger-modeling",
    "browser-context-sufficiency",
]

CODE_CHECK_CRITERIA = {
    "no-guessed-required-param", "schema-aligned-execution", "step-handoff-placeholder",
    "fan-out-shape", "sheet-header-safety", "event-trigger-modeling",
}
LLM_JUDGE_CRITERIA = {"no-opaque-id-asked", "correct-route-classification", "browser-context-sufficiency"}

trace_ids = list(tier0.keys())
scorecard = {"traceCount": len(trace_ids), "criteria": {}}

for crit in CRITERIA_IDS:
    per_trace = {}
    for tid in trace_ids:
        if crit in CODE_CHECK_CRITERIA:
            v = tier0[tid]["criteria"][crit]
            per_trace[tid] = {"verdict": v["verdict"], "method": "code-check", "note": v["note"]}
        else:
            v = judge_verdicts.get(tid, {}).get(crit)
            if v is None:
                per_trace[tid] = {"verdict": "missing", "method": "llm-judge", "note": "no judge verdict found"}
            else:
                result = v.get("result", "missing")
                verdict = {"pass": "pass", "fail": "fail", "uncertain": "indeterminate", "n/a": "n/a"}.get(result, result)
                per_trace[tid] = {
                    "verdict": verdict, "method": "llm-judge", "confidence": v.get("confidence"),
                    "critique": v.get("critique"), "refs": v.get("refs", []),
                    "assumptions": v.get("assumptions", []), "blockedBy": v.get("blockedBy"),
                }

    applicable = {tid: v for tid, v in per_trace.items() if v["verdict"] not in ("n/a",)}
    n_pass = sum(1 for v in applicable.values() if v["verdict"] == "pass")
    n_fail = sum(1 for v in applicable.values() if v["verdict"] == "fail")
    n_indet = sum(1 for v in applicable.values() if v["verdict"] == "indeterminate")
    n_applicable = len(applicable)
    pass_rate = (n_pass / n_applicable) if n_applicable else None

    scorecard["criteria"][crit] = {
        "class": "code-check" if crit in CODE_CHECK_CRITERIA else "llm-judge",
        "perTrace": per_trace,
        "applicableCount": n_applicable,
        "naCount": len(per_trace) - n_applicable,
        "pass": n_pass, "fail": n_fail, "indeterminate": n_indet,
        "passRate": round(pass_rate, 3) if pass_rate is not None else None,
    }

# Run-level GATE: fail if any criterion has a fail; incomplete if any indeterminate (and no fails); else pass
any_fail = any(c["fail"] > 0 for c in scorecard["criteria"].values())
any_indet = any(c["indeterminate"] > 0 for c in scorecard["criteria"].values())
gate = "fail" if any_fail else ("incomplete" if any_indet else "pass")
scorecard["runVerdict"] = gate

with open(f"{BASE}/scorecard.json", "w") as f:
    json.dump(scorecard, f, indent=2)

# Human-readable summary
lines = []
lines.append("# Phase 4 Baseline Scorecard — voxagent-planner")
lines.append("")
lines.append(f"**24 real traces** (Phase 3) scored against **9 criteria** from `agentspec.yaml`.")
lines.append(f"**Run-level GATE: `{gate}`**")
lines.append("")
lines.append("| Criterion | Class | Applicable | Pass | Fail | Indeterminate | Pass rate |")
lines.append("|---|---|---|---|---|---|---|")
for crit in CRITERIA_IDS:
    c = scorecard["criteria"][crit]
    pr = f"{c['passRate']*100:.0f}%" if c["passRate"] is not None else "n/a (0 applicable)"
    lines.append(f"| {crit} | {c['class']} | {c['applicableCount']} | {c['pass']} | {c['fail']} | {c['indeterminate']} | {pr} |")

lines.append("")
lines.append("## Failures (all criteria)")
for crit in CRITERIA_IDS:
    c = scorecard["criteria"][crit]
    fails = [(tid, v) for tid, v in c["perTrace"].items() if v["verdict"] == "fail"]
    for tid, v in fails:
        note = v.get("note") or v.get("critique", "")[:200]
        lines.append(f"- **{crit}** / `{tid}`: {note}")

with open(f"{BASE}/scorecard.md", "w") as f:
    f.write("\n".join(lines))

print("\n".join(lines))
