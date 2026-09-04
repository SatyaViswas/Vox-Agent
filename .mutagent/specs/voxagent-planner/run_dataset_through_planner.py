"""Phase 3 of the current ADL pass — executes each candidate eval case through the
REAL planner.generate_blueprint() (a live Gemini call, no mocking) and writes the
genuine input/output pairs as local JSONL traces, per docs.mutagent.io/helix/traces'
documented minimum bar: "the input, what the agent did, and the output." Registered
afterward as a `format: raw` local-jsonl source in .mutagent/config.yaml.
"""
import json
import sys
import time
import traceback
from datetime import datetime, timezone

sys.path.insert(0, "/Users/satyaviswas/Documents/Vox-Agent/backend")

from app.services.planner import generate_blueprint  # noqa: E402

CANDIDATES_PATH = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner/eval-dataset-candidates.json"
TRACES_PATH = "/Users/satyaviswas/Documents/Vox-Agent/.mutagent/specs/voxagent-planner/traces/planner-eval-traces.jsonl"


def main():
    with open(CANDIDATES_PATH) as f:
        candidates = json.load(f)

    traces = []
    for i, case in enumerate(candidates, 1):
        prompt = case["prompt_text"]
        print(f"[{i}/{len(candidates)}] {case['id']}: {prompt[:60]!r}...", flush=True)
        started = datetime.now(timezone.utc).isoformat()
        try:
            blueprint = generate_blueprint(prompt)
            output = blueprint.model_dump()
            status = "success"
            error = None
        except Exception as e:
            output = None
            status = "error"
            error = f"{type(e).__name__}: {e}"
            traceback.print_exc()

        trace = {
            "trace_id": case["id"],
            "timestamp": started,
            "input": {
                "prompt": prompt,
            },
            "metadata": {
                "scenario": case["scenario"],
                "target_app": case.get("target_app"),
                "complexity": case.get("complexity"),
                "phrasing_style": case.get("phrasing_style"),
                "edge_case": case.get("edge_case", False),
                "source": case.get("source", "synthetic"),
                "rationale": case.get("rationale"),
            },
            "output": {
                "status": status,
                "blueprint": output,
                "error": error,
            },
        }
        traces.append(trace)
        time.sleep(1.5)  # be polite to the API between calls

    import os
    os.makedirs(os.path.dirname(TRACES_PATH), exist_ok=True)
    with open(TRACES_PATH, "w") as f:
        for t in traces:
            f.write(json.dumps(t) + "\n")

    n_success = sum(1 for t in traces if t["output"]["status"] == "success")
    n_error = len(traces) - n_success
    print(f"\nDone. {n_success}/{len(traces)} succeeded, {n_error} raised an exception.")
    print(f"Wrote {len(traces)} traces to {TRACES_PATH}")


if __name__ == "__main__":
    main()
