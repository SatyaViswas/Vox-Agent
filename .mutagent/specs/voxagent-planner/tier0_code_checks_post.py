"""Phase 7 post-optimize re-run of the SAME tier-0 checks used for the Phase 4
baseline (tier0_code_checks.py), against the post-optimize traces. Imported,
not copy-pasted, so both runs use byte-identical check logic -- the only
variable is the planner output itself. Known tier0-check limitations
(documented in diagnose-finding-1.json / diagnose-finding-2.json, e.g.
scenario-gating no-guessed-required-param instead of inspecting prompt
content) are UNCHANGED here deliberately, so this is a like-for-like
comparison against the Phase 4 baseline methodology.
"""
import importlib.util
import json

BASE = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner"
TRACES_PATH = f"{BASE}/traces/planner-eval-traces-post-optimize.jsonl"
OUT_PATH = f"{BASE}/tier0-verdicts-post.json"

spec = importlib.util.spec_from_file_location("tier0_code_checks", f"{BASE}/tier0_code_checks.py")
tier0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tier0)


def main():
    with open(TRACES_PATH) as f:
        traces = [json.loads(l) for l in f]

    results = {}
    for t in traces:
        trace_id = t["trace_id"]
        scenario = t["metadata"]["scenario"]
        bp = t["output"]["blueprint"]
        per_criterion = {}
        for crit_id, fn in tier0.CHECKS.items():
            verdict, note = fn(bp, scenario) if bp is not None else ("fail", f"planner errored: {t['output'].get('error')}")
            per_criterion[crit_id] = {"verdict": verdict, "note": note, "method": "code-check (tier-0)"}
        results[trace_id] = {"scenario": scenario, "criteria": per_criterion}

    with open(OUT_PATH, "w") as f:
        json.dump(results, f, indent=2)

    from collections import Counter
    for crit_id in tier0.CHECKS:
        counts = Counter(results[tid]["criteria"][crit_id]["verdict"] for tid in results)
        print(f"{crit_id}: {dict(counts)}")

    print(f"\nWrote tier-0 verdicts for {len(results)} traces to {OUT_PATH}")


if __name__ == "__main__":
    main()
