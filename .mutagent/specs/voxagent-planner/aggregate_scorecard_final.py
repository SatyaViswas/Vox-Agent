"""Phase 7 - final 3-way scorecard: original Phase 4 baseline (as first
reported, with the known tier0-instrument bugs), corrected-baseline (same
planner behavior/traces, harness bugs fixed - isolates the harness-fix
effect), and post-optimize (new traces from the fixed planner, harness
fixed - isolates the real product-fix effect). All three share the same
CRITERIA_IDS/CODE_CHECK/LLM_JUDGE partition as Phase 4's aggregate_scorecard.py.
"""
import json
import glob

BASE = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner"

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


def build_scorecard(tier0_path, judge_batch_glob, trace_ids):
    with open(tier0_path) as f:
        tier0 = json.load(f)

    judge_verdicts = {}
    for path in sorted(glob.glob(judge_batch_glob)):
        with open(path) as f:
            batch = json.load(f)
        for item in batch:
            judge_verdicts[item["trace_id"]] = item["criteria"]

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
                    per_trace[tid] = {"verdict": verdict, "method": "llm-judge", "confidence": v.get("confidence")}

        applicable = {tid: v for tid, v in per_trace.items() if v["verdict"] not in ("n/a",)}
        n_pass = sum(1 for v in applicable.values() if v["verdict"] == "pass")
        n_fail = sum(1 for v in applicable.values() if v["verdict"] == "fail")
        n_indet = sum(1 for v in applicable.values() if v["verdict"] == "indeterminate")
        n_applicable = len(applicable)
        pass_rate = (n_pass / n_applicable) if n_applicable else None

        scorecard["criteria"][crit] = {
            "class": "code-check" if crit in CODE_CHECK_CRITERIA else "llm-judge",
            "applicableCount": n_applicable, "naCount": len(per_trace) - n_applicable,
            "pass": n_pass, "fail": n_fail, "indeterminate": n_indet,
            "passRate": round(pass_rate, 3) if pass_rate is not None else None,
        }

    any_fail = any(c["fail"] > 0 for c in scorecard["criteria"].values())
    any_indet = any(c["indeterminate"] > 0 for c in scorecard["criteria"].values())
    scorecard["runVerdict"] = "fail" if any_fail else ("incomplete" if any_indet else "pass")
    return scorecard


trace_ids = [f"{p}-{n:02d}" for p in ["amb", "ctfm", "msh", "fan", "rct", "bpt", "hpp", "srw"] for n in (1, 2, 3)]

corrected_baseline = build_scorecard(f"{BASE}/tier0-verdicts-baseline-corrected.json", f"{BASE}/judge-batch-[1-4].json", trace_ids)
post_optimize = build_scorecard(f"{BASE}/tier0-verdicts-post.json", f"{BASE}/judge-batch-post-[1-4].json", trace_ids)

with open(f"{BASE}/scorecard-corrected-baseline.json", "w") as f:
    json.dump(corrected_baseline, f, indent=2)
with open(f"{BASE}/scorecard-post-optimize.json", "w") as f:
    json.dump(post_optimize, f, indent=2)

lines = []
lines.append("# Phase 7 Final Scorecard — voxagent-planner")
lines.append("")
lines.append("Two comparable runs, same 24-trace dataset, same (corrected) tier-0 harness + fresh LLM judging on both sides:")
lines.append(f"- **Corrected baseline** — original Phase 3 traces (pre-fix planner), run-level GATE: `{corrected_baseline['runVerdict']}`")
lines.append(f"- **Post-optimize** — fresh traces from the current planner (commits 69d238f, 71fb7b1, 28320b1), run-level GATE: `{post_optimize['runVerdict']}`")
lines.append("")
lines.append("| Criterion | Class | Baseline (applicable/pass/fail) | Post-optimize (applicable/pass/fail) | Baseline pass% | Post pass% |")
lines.append("|---|---|---|---|---|---|")
for crit in CRITERIA_IDS:
    b, p = corrected_baseline["criteria"][crit], post_optimize["criteria"][crit]
    bpr = f"{b['passRate']*100:.0f}%" if b["passRate"] is not None else "n/a"
    ppr = f"{p['passRate']*100:.0f}%" if p["passRate"] is not None else "n/a"
    lines.append(f"| {crit} | {b['class']} | {b['applicableCount']}/{b['pass']}/{b['fail']} | {p['applicableCount']}/{p['pass']}/{p['fail']} | {bpr} | {ppr} |")

with open(f"{BASE}/scorecard-final.md", "w") as f:
    f.write("\n".join(lines))

print("\n".join(lines))
