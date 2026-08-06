#!/usr/bin/env python3
"""
verify_build_alignment.py — BUILD-time alignment harness for spec `voxagent-planner`.

T1 of the frozen PLAN in ../build-report.md. Re-runnable evidence for the 13 structural
/ fidelity checks that plan declares: T2-T12 (11 checks) + T17 + T18 = 13.

Bound conditions (B4 ruling (1)), honored here:
  * STATIC / AST-ONLY. This file never does `import app.*` (which would drag in
    `app.config.settings`, i.e. pydantic-settings + a .env) and never imports the
    backend at all. Every fact is derived from source text + `ast`.
  * NO NETWORK. No GEMINI_API_KEY, no Composio reachability, no HTTP of any kind.
  * NO PRODUCTION WRITE. Every target file is opened read-only.

Dependencies: Python 3 stdlib (`ast`, `re`, `difflib`, `hashlib`) + PyYAML. Deliberately
not pytest: `backend/requirements.txt` declares no test runner and adding one to a
shipping backend for a verify-only build would be unjustified (see T1's rationale).

Exit code: 0 iff all 13 checks PASS; non-zero otherwise.

Sub-assertions folded into check lines (so the denominator stays exactly 13):
  * T14's pre-reconcile guard  -> inside T10
  * T16's pre-reconcile guard  -> inside T6
  * D8's required-ness measurement (`needs_human_approval` is schema-REQUIRED, not
    optional/defaulted) -> inside T18, as binding evidence for the B7 fidelity row.
"""

from __future__ import annotations

import ast
import difflib
import hashlib
import os
import re
import sys

import yaml

# --------------------------------------------------------------------------------------
# Paths — resolved relative to this file, never hard-coded to one machine.
# --------------------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_DIR = os.path.dirname(HERE)                       # .mutagent/specs/voxagent-planner
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SPEC_DIR)))

SPEC_YAML = os.path.join(SPEC_DIR, "agentspec.yaml")
BACKEND = os.path.join(REPO_ROOT, "backend")
PLANNER = os.path.join(BACKEND, "app", "services", "planner.py")
BLUEPRINT = os.path.join(BACKEND, "app", "schemas", "blueprint.py")
COMPOSIO = os.path.join(BACKEND, "app", "services", "composio_engine.py")
ORCHESTRATOR = os.path.join(BACKEND, "app", "services", "orchestrator.py")
ROUTER = os.path.join(BACKEND, "app", "routers", "planner.py")
MAIN = os.path.join(BACKEND, "main.py")
VAULT = os.path.join(BACKEND, "app", "services", "vault.py")

# Freeze table from the PLAN (informational only — NOT one of the 13 gates).
FROZEN_DIGESTS = {
    SPEC_YAML: "c99a90a6c840",
    PLANNER: "c6fb46ea1864",
    COMPOSIO: "44ebd461f4a8",
    BLUEPRINT: "365ad85763e9",
    ROUTER: "efd1104d18e6",
    ORCHESTRATOR: "dc2fe655afa6",
}

SCHEMA_TAIL_PLACEHOLDER = "<<SCHEMA_TAIL>>"


# --------------------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------------------

def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def parse(path: str) -> ast.Module:
    return ast.parse(read(path), filename=path)


def sha12(path: str) -> str:
    return hashlib.sha256(read(path).encode("utf-8")).hexdigest()[:12]


def rel(path: str) -> str:
    return os.path.relpath(path, REPO_ROOT)


def func_def(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"function `{name}` not found at module scope")


def class_def(tree: ast.Module, name: str) -> ast.ClassDef:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    raise AssertionError(f"class `{name}` not found at module scope")


def class_fields(tree: ast.Module, name: str) -> list[str]:
    """Ordered annotated field names of a Pydantic model class."""
    return [
        n.target.id
        for n in class_def(tree, name).body
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
    ]


def required_fields(tree: ast.Module, name: str) -> list[str]:
    """Annotated fields with NO default value (i.e. schema-`required`)."""
    return [
        n.target.id
        for n in class_def(tree, name).body
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is None
    ]


def calls_in(node: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(node) if isinstance(n, ast.Call)]


def call_name(call: ast.Call) -> str:
    try:
        return ast.unparse(call.func)
    except Exception:  # pragma: no cover - defensive
        return "<unparseable>"


def kwarg(call: ast.Call, key: str):
    for kw in call.keywords:
        if kw.arg == key:
            return kw.value
    return None


def enclosing_func(tree: ast.Module, target: ast.AST) -> str | None:
    """Name of the module-level function containing `target`, else None (module scope)."""
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(child is target for child in ast.walk(node)):
                return node.name
    return None


def backend_py_files() -> list[str]:
    """Every in-repo backend .py file, excluding the vendored venv and bytecode caches."""
    out = []
    for root, dirs, files in os.walk(BACKEND):
        dirs[:] = [d for d in dirs if d not in {"venv", ".venv", "__pycache__", "node_modules"}]
        for fname in files:
            if fname.endswith(".py"):
                out.append(os.path.join(root, fname))
    return sorted(out)


# --------------------------------------------------------------------------------------
# The rendered system prompt — the runtime string, not the source text.
#
# `get_system_prompt` returns an f-string, so `{{` in source is `{` at runtime. Python's
# parser already decodes doubled braces when building the JoinedStr, so concatenating the
# AST's Constant parts yields the exact text Gemini receives. `{schema_json}` (the only
# FormattedValue) is replaced by a placeholder: the live JSON Schema is generated, not
# authored, and is excluded from the fidelity comparison by agreement (T2).
# --------------------------------------------------------------------------------------

def render_system_prompt(planner_tree: ast.Module) -> str:
    fn = func_def(planner_tree, "get_system_prompt")
    joined = None
    for node in ast.walk(fn):
        if isinstance(node, ast.Return) and isinstance(node.value, ast.JoinedStr):
            joined = node.value
            break
    assert joined is not None, "get_system_prompt does not return an f-string (JoinedStr)"

    parts: list[str] = []
    formatted: list[str] = []
    for piece in joined.values:
        if isinstance(piece, ast.Constant):
            parts.append(str(piece.value))
        elif isinstance(piece, ast.FormattedValue):
            formatted.append(ast.unparse(piece.value))
            parts.append(SCHEMA_TAIL_PLACEHOLDER)
        else:  # pragma: no cover - defensive
            raise AssertionError(f"unexpected f-string part {type(piece).__name__}")

    assert formatted == ["schema_json"], (
        f"expected exactly one interpolation `schema_json`, got {formatted}"
    )
    return "".join(parts)


def prompt_body_lines(rendered: str) -> list[str]:
    """The 41 comparable lines: leading newline dropped, per-line trailing whitespace
    stripped, trailing blanks dropped, schema tail removed."""
    text = rendered[1:] if rendered.startswith("\n") else rendered
    lines = [ln.rstrip() for ln in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    assert lines and lines[-1] == SCHEMA_TAIL_PLACEHOLDER, (
        "rendered prompt does not end with the schema interpolation"
    )
    return lines[:-1]


def spec_prompt_body_lines(spec: dict) -> list[str]:
    text = spec["spec"]["agent"]["systemPrompt"]
    lines = [ln.rstrip() for ln in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    assert lines and lines[-1].startswith("<the live"), (
        "spec systemPrompt does not end with the excluded schema-tail note"
    )
    return lines[:-1]


# --------------------------------------------------------------------------------------
# Loaded once, shared by the checks.
# --------------------------------------------------------------------------------------

SPEC = yaml.safe_load(read(SPEC_YAML))
T_PLANNER = parse(PLANNER)
T_BLUEPRINT = parse(BLUEPRINT)
T_COMPOSIO = parse(COMPOSIO)
T_ROUTER = parse(ROUTER)
T_MAIN = parse(MAIN)
T_VAULT = parse(VAULT)
RENDERED = render_system_prompt(T_PLANNER)


# --------------------------------------------------------------------------------------
# T2 — spec.agent.systemPrompt is verbatim-faithful to the operative prompt (PR-014)
# --------------------------------------------------------------------------------------

def check_T2() -> str:
    spec_lines = spec_prompt_body_lines(SPEC)
    rendered_lines = prompt_body_lines(RENDERED)

    assert len(spec_lines) == 41, f"expected 41 spec prompt lines, got {len(spec_lines)}"
    assert len(rendered_lines) == 41, f"expected 41 rendered lines, got {len(rendered_lines)}"

    diff = list(difflib.unified_diff(
        spec_lines, rendered_lines, fromfile="spec.agent.systemPrompt",
        tofile="planner.get_system_prompt() [rendered]", lineterm="",
    ))
    assert not diff, "prompt drift:\n" + "\n".join(diff[:40])
    return ("41 non-schema lines compared, 0 diff hunks "
            "(normalizations disclosed: leading newline dropped, per-line trailing "
            "whitespace stripped; schema tail excluded)")


# --------------------------------------------------------------------------------------
# T3 — spec.context[0] is a LIVE call-time binding, not a stale copy
# --------------------------------------------------------------------------------------

def check_T3() -> str:
    sites = [c for c in calls_in(T_PLANNER) if call_name(c).endswith(".model_json_schema")]
    assert len(sites) == 1, f"expected exactly 1 model_json_schema() call, got {len(sites)}"
    where = enclosing_func(T_PLANNER, sites[0])
    assert where == "get_system_prompt", (
        f"model_json_schema() is called from `{where}`, not get_system_prompt (module-scope "
        "or elsewhere would make the schema a stale snapshot)"
    )

    module_assign_refs = []
    for node in T_PLANNER.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            if "WorkflowBlueprint" in ast.unparse(node):
                module_assign_refs.append(ast.unparse(node))
    assert not module_assign_refs, (
        "WorkflowBlueprint is bound at module level (stale-copy risk): " + "; ".join(module_assign_refs)
    )

    imported = any(
        isinstance(n, ast.ImportFrom) and any(a.name == "WorkflowBlueprint" for a in n.names)
        for n in T_PLANNER.body
    )
    assert imported, "WorkflowBlueprint is not imported in planner.py"
    return ("model_json_schema() called INSIDE get_system_prompt (per call); no module-level "
            "WorkflowBlueprint binding except the import")


# --------------------------------------------------------------------------------------
# T4 — allowedOperations: ["schema.read"] is not exceeded
# --------------------------------------------------------------------------------------

def check_T4() -> str:
    attrs = {
        n.attr for n in ast.walk(T_PLANNER)
        if isinstance(n, ast.Attribute)
        and isinstance(n.value, ast.Name) and n.value.id == "WorkflowBlueprint"
    }
    assert attrs, "no attribute is reached on WorkflowBlueprint at all — check is vacuous"
    allowed = {"model_json_schema", "model_validate"}
    assert attrs <= allowed, f"operations on WorkflowBlueprint exceed the binding: {sorted(attrs - allowed)}"

    declared = SPEC["spec"]["context"][0]["access"]["allowedOperations"]
    assert declared == ["schema.read"], f"spec.context[0].allowedOperations changed: {declared}"
    return (f"attrs reached on WorkflowBlueprint = {sorted(attrs)} subset of "
            "{model_json_schema, model_validate} (model_validate = inbound parse, not a source op)")


# --------------------------------------------------------------------------------------
# T5 — spec.actions: [] holds; the planner is read/reason-only
# --------------------------------------------------------------------------------------

FORBIDDEN_IMPORTS = {"supabase", "httpx", "requests", "aiohttp", "sqlalchemy", "subprocess", "pathlib"}


def check_T5() -> str:
    assert SPEC["spec"]["actions"] == [], "spec.actions is no longer empty"

    roots: set[str] = set()
    for node in T_PLANNER.body:
        if isinstance(node, ast.Import):
            roots.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".")[0])
    overlap = roots & FORBIDDEN_IMPORTS
    assert not overlap, f"side-effecting imports present: {sorted(overlap)}"

    side_effects = []
    for c in calls_in(T_PLANNER):
        name = call_name(c)
        if name == "open" or name == "os.remove" or name.endswith(".execute"):
            side_effects.append(name)
    assert not side_effects, f"side-effecting calls present: {side_effects}"
    return (f"module imports {sorted(roots)} disjoint from {sorted(FORBIDDEN_IMPORTS)}; "
            "0 open()/os.remove/.execute() calls")


# --------------------------------------------------------------------------------------
# T6 — triggers[0] (studio-plan-request) resolves to a real, reachable entry point
#      (+ T16 pre-reconcile guard: generate_blueprint's params == ["prompt"])
# --------------------------------------------------------------------------------------

def check_T6() -> str:
    mounted = False
    for c in calls_in(T_MAIN):
        if call_name(c).endswith("include_router") and c.args:
            if ast.unparse(c.args[0]) == "planner.router":
                prefix = kwarg(c, "prefix")
                if isinstance(prefix, ast.Constant) and prefix.value == "/api/v1":
                    mounted = True
    assert mounted, "main.py does not include planner.router with prefix='/api/v1'"

    handler = None
    for node in T_ROUTER.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                if (isinstance(dec, ast.Call) and call_name(dec).endswith(".post")
                        and dec.args and isinstance(dec.args[0], ast.Constant)
                        and dec.args[0].value == "/plan"):
                    handler = node
    assert handler is not None, "no @router.post('/plan') handler in routers/planner.py"
    assert any(call_name(c) == "generate_blueprint" for c in calls_in(handler)), (
        "the POST /plan handler does not dispatch into generate_blueprint"
    )

    fields = set(class_fields(T_BLUEPRINT, "PlanRequest"))
    assert fields == {"prompt", "user_id"}, f"PlanRequest fields = {sorted(fields)}"

    # T16 pre-reconcile guard (sub-assertion): user_id never reaches the planner.
    params = [a.arg for a in func_def(T_PLANNER, "generate_blueprint").args.args]
    assert params == ["prompt"], f"generate_blueprint params = {params} (expected ['prompt'])"
    return ("POST /api/v1/plan mounted -> generate_blueprint; PlanRequest{prompt,user_id}; "
            "[T16 guard] generate_blueprint(prompt) takes ['prompt'] only")


# --------------------------------------------------------------------------------------
# T7 — workflow.inline matches the real control flow (one node, terminal, temperature 0.1)
# --------------------------------------------------------------------------------------

def check_T7() -> str:
    fn = func_def(T_PLANNER, "generate_blueprint")
    model_calls = [c for c in calls_in(fn) if call_name(c) == "client.models.generate_content"]
    assert len(model_calls) == 1, f"expected 1 model call in generate_blueprint, got {len(model_calls)}"

    cfgs = [c for c in calls_in(fn) if call_name(c).endswith("GenerateContentConfig")]
    assert len(cfgs) == 1, f"expected 1 GenerateContentConfig, got {len(cfgs)}"
    temp = kwarg(cfgs[0], "temperature")
    assert isinstance(temp, ast.Constant) and temp.value == 0.1, (
        f"temperature = {ast.unparse(temp) if temp else None}, expected 0.1"
    )
    mime = kwarg(cfgs[0], "response_mime_type")
    assert isinstance(mime, ast.Constant) and mime.value == "application/json", (
        "response_mime_type is not 'application/json'"
    )

    loops = [n for n in ast.walk(fn) if isinstance(n, (ast.For, ast.While, ast.AsyncFor))]
    assert not loops, f"generate_blueprint contains {len(loops)} loop(s) — not a single terminal node"

    nodes = SPEC["spec"]["agent"]["workflow"]["inline"]["nodes"]
    assert len(nodes) == 1 and nodes[0]["terminal"] is True, "spec workflow is no longer a single terminal node"
    return "1 generate_content call, temperature=0.1, response_mime_type=application/json, 0 loops"


# --------------------------------------------------------------------------------------
# T8 — constraints[1] (route enum) is STRUCTURALLY enforced. Unordered SET equality (D2).
# --------------------------------------------------------------------------------------

def check_T8() -> str:
    ann = None
    for n in class_def(T_BLUEPRINT, "WorkflowStep").body:
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id == "route":
            ann = n.annotation
    assert ann is not None, "WorkflowStep.route not found"
    assert isinstance(ann, ast.Subscript) and ast.unparse(ann.value) == "Literal", (
        "WorkflowStep.route is not a Literal — the enum is no longer structurally enforced"
    )
    elts = ann.slice.elts if isinstance(ann.slice, ast.Tuple) else [ann.slice]
    code_routes = [e.value for e in elts]

    constraint = SPEC["spec"]["intent"]["constraints"][1]
    m = re.search(r"one of\s+(.+?)\.?$", constraint.strip())
    assert m, f"could not parse the route enum out of constraints[1]: {constraint!r}"
    spec_routes = [r.strip() for r in m.group(1).split("|")]

    assert set(code_routes) == set(spec_routes), (
        f"route enum mismatch — code {sorted(code_routes)} vs spec {sorted(spec_routes)}"
    )
    assert len(code_routes) == 5, f"expected 5 routes, got {len(code_routes)}"

    ordering = "identical order" if code_routes == spec_routes else (
        f"order differs (cosmetic — a Literal's member order has no runtime meaning): "
        f"code={code_routes} spec={spec_routes}"
    )
    return f"unordered SET equality over 5 members holds; {ordering}"


# --------------------------------------------------------------------------------------
# T9 — constraints[2]: output validates against the live schema on every call
# --------------------------------------------------------------------------------------

def check_T9() -> str:
    fn = func_def(T_PLANNER, "generate_blueprint")
    tries = [n for n in ast.walk(fn) if isinstance(n, ast.Try)]
    assert len(tries) == 1, f"expected exactly 1 try block in generate_blueprint, got {len(tries)}"
    node = tries[0]

    try_returns = [n for n in ast.walk(ast.Module(body=node.body, type_ignores=[]))
                   if isinstance(n, ast.Return)]
    assert try_returns, "the try block has no return — check would be vacuous"
    for r in try_returns:
        assert isinstance(r.value, ast.Call) and call_name(r.value) == "WorkflowBlueprint.model_validate", (
            f"unvalidated return in try block: {ast.unparse(r)}"
        )

    all_returns = [n for n in ast.walk(fn) if isinstance(n, ast.Return)]
    assert len(all_returns) == len(try_returns), (
        "a return exists outside the validating try block — an unvalidated value can escape"
    )

    handler_returns, handler_raises = [], []
    for h in node.handlers:
        for n in ast.walk(ast.Module(body=h.body, type_ignores=[])):
            if isinstance(n, ast.Return):
                handler_returns.append(ast.unparse(n))
            if isinstance(n, ast.Raise) and n.exc is not None:
                handler_raises.append(call_name(n.exc) if isinstance(n.exc, ast.Call) else ast.unparse(n.exc))
    assert not handler_returns, f"the except handler returns a value instead of raising: {handler_returns}"
    assert "ValueError" in handler_raises, f"the except handler does not raise ValueError: {handler_raises}"
    return (f"{len(try_returns)}/{len(all_returns)} returns are WorkflowBlueprint.model_validate(...); "
            "except re-raises ValueError, returns nothing")


# --------------------------------------------------------------------------------------
# T10 — all six spec.intent.sop entries trace to operative prompt sites + schema affordances
#       (+ T14 pre-reconcile guard: 'VoxAgent Vault Notes' == vault.VAULT_NOTES_APP_NAME)
# --------------------------------------------------------------------------------------

SOP_ANCHORS: dict[str, list[str]] = {
    "route-classification": [
        "Rules for route classification:",
        "'browser_agent'", "'composio_api'", "'http_webhook'", "'telegram_client'", "'ai_generate'",
    ],
    "disambiguation-gate": [
        "NEVER ask the user for an internal ID", "needs_clarification", "missing_parameters",
    ],
    "data-handoff": ["Rule 3 (Data Handoff Between Steps)", "{step_N_result}"],
    "reactive-trigger-modeling": [
        "Rule 4 (Event-Driven", "`trigger.type`", "event_app", "event_target",
    ],
    "fan-out-batching": ["for_each", "{{item}}"],
    "spreadsheet-header-safety": ["headers"],
}


def check_T10() -> str:
    spec_sop_ids = [s["id"] for s in SPEC["spec"]["intent"]["sop"]]
    assert set(spec_sop_ids) == set(SOP_ANCHORS), (
        f"spec SOP id set changed: {sorted(spec_sop_ids)} vs {sorted(SOP_ANCHORS)}"
    )

    missing = []
    for sop_id, anchors in SOP_ANCHORS.items():
        for anchor in anchors:
            if anchor not in RENDERED:
                missing.append(f"{sop_id} -> {anchor!r}")
    assert not missing, "SOP anchors absent from the rendered prompt: " + "; ".join(missing)

    # SOP-named fields must have somewhere to land in the schema.
    gate = next(s for s in SPEC["spec"]["intent"]["sop"] if s["id"] == "disambiguation-gate")
    m = re.search(r"\(([^)]*step_number[^)]*)\)", gate["description"])
    assert m, "disambiguation-gate's description no longer names its five fields"
    sop_fields = [f.strip() for f in m.group(1).split(",")]
    mp_fields = class_fields(T_BLUEPRINT, "MissingParameter")
    assert set(sop_fields) == set(mp_fields), (
        f"MissingParameter fields {mp_fields} != SOP-named fields {sop_fields}"
    )
    assert len(mp_fields) == 5, f"expected 5 MissingParameter fields, got {len(mp_fields)}"

    trig_required = required_fields(T_BLUEPRINT, "TriggerSpec")
    assert "details" in trig_required, "TriggerSpec.details is no longer required (reactive-trigger-modeling)"
    assert "for_each" in class_fields(T_BLUEPRINT, "WorkflowStep"), "WorkflowStep.for_each is gone (fan-out-batching)"

    # T14 pre-reconcile guard (sub-assertion): Rule 1's app name and vault.py must not drift.
    assert "VoxAgent Vault Notes" in RENDERED, "Rule 1's 'VoxAgent Vault Notes' is gone from the prompt"
    vault_const = None
    for node in T_VAULT.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "VAULT_NOTES_APP_NAME" for t in node.targets
        ):
            vault_const = node.value.value
    assert vault_const is not None, "vault.VAULT_NOTES_APP_NAME not found"
    assert "VoxAgent Vault Notes".strip().lower() == vault_const.strip().lower(), (
        f"Rule 1's app name and vault.VAULT_NOTES_APP_NAME ({vault_const!r}) have drifted"
    )
    return ("6/6 SOP ids anchored in the rendered prompt; MissingParameter fields == the SOP's five; "
            "[T14 guard] 'VoxAgent Vault Notes' == vault.VAULT_NOTES_APP_NAME (case-insensitive)")


# --------------------------------------------------------------------------------------
# T11 — the schema-alignment layer exists AND is on the hot path, in the load-bearing order
# --------------------------------------------------------------------------------------

def check_T11() -> str:
    for helper in ("_get_action_schema", "_resolve_schema_key", "_normalize_parameters_via_schema",
                   "_resolve_action_slug", "_auto_resolve_missing_ids"):
        func_def(T_COMPOSIO, helper)  # raises if absent

    fn = func_def(T_COMPOSIO, "execute_composio_action")
    wanted = ["_resolve_action_slug", "_normalize_parameters_via_schema", "_auto_resolve_missing_ids"]
    idx: dict[str, int] = {}
    for i, stmt in enumerate(fn.body):
        for c in calls_in(stmt):
            name = call_name(c)
            if name in wanted and name not in idx:
                idx[name] = i

    absent = [w for w in wanted if w not in idx]
    assert not absent, f"schema-alignment layer not reached from execute_composio_action: {absent}"
    order = [idx[w] for w in wanted]
    assert order == sorted(order) and len(set(order)) == 3, (
        f"call order is not strictly increasing: {dict(zip(wanted, order))} — names must be corrected "
        "BEFORE parameters are aligned against the corrected action's schema"
    )
    return ("all 5 layer functions defined; execute_composio_action reaches slug-resolve -> "
            f"param-normalize -> id-auto-resolve at statement indices {order} (strictly increasing)")


# --------------------------------------------------------------------------------------
# T12 — coverage-gate disposition for spec.capabilities.code: []
# --------------------------------------------------------------------------------------

def check_T12() -> str:
    caps = SPEC["spec"]["capabilities"]
    for bucket in ("code", "skills", "delegates"):
        assert caps[bucket] == [], f"spec.capabilities.{bucket} is no longer empty: {caps[bucket]}"
    return ("capabilities.code/skills/delegates all [] -> 0 required tool ids, 0 missing: "
            "coverage PASS (vacuous, declared)")


# --------------------------------------------------------------------------------------
# T17 — planner.py L100-178 is out-of-subject execution-time code; pin the subject boundary
# --------------------------------------------------------------------------------------

def check_T17() -> str:
    # (a) router surface reaches only generate_blueprint
    imported = set()
    for node in T_ROUTER.body:
        if isinstance(node, ast.ImportFrom) and node.module == "app.services.planner":
            imported.update(a.name for a in node.names)
    assert imported == {"generate_blueprint"}, (
        f"routers/planner.py imports {sorted(imported)} from app.services.planner, expected "
        "{generate_blueprint} only"
    )
    assert "generate_ai_content" not in read(ROUTER), (
        "routers/planner.py references generate_ai_content — the plan-time surface has grown "
        "into execution-time code"
    )

    # (b) sole importer / sole call site of generate_ai_content
    importers, call_sites = [], []
    for path in backend_py_files():
        if os.path.abspath(path) == os.path.abspath(PLANNER):
            continue
        try:
            tree = parse(path)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and any(a.name == "generate_ai_content" for a in node.names):
                importers.append(rel(path))
            if isinstance(node, ast.Call) and call_name(node) == "generate_ai_content":
                call_sites.append(rel(path))
    assert importers == [rel(ORCHESTRATOR)], f"importers of generate_ai_content = {importers}"
    assert call_sites == [rel(ORCHESTRATOR)], f"call sites of generate_ai_content = {call_sites}"

    # (c) call-graph isolation from generate_blueprint
    local_funcs = {
        n.name: n for n in T_PLANNER.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    reached, frontier = set(), ["generate_blueprint"]
    while frontier:
        cur = frontier.pop()
        if cur in reached or cur not in local_funcs:
            continue
        reached.add(cur)
        for c in calls_in(local_funcs[cur]):
            name = call_name(c)
            if name in local_funcs:
                frontier.append(name)
    for out_of_subject in ("generate_ai_content", "_strip_markdown_fences"):
        assert out_of_subject not in reached, (
            f"generate_blueprint's call graph reaches {out_of_subject} — the subject boundary is breached"
        )

    # (d) exactly 2 out-of-subject generate_content calls, both temperature 0.7
    out_calls = []
    for c in calls_in(T_PLANNER):
        if call_name(c).endswith("generate_content") and not call_name(c).endswith("GenerateContentConfig"):
            if enclosing_func(T_PLANNER, c) != "generate_blueprint":
                out_calls.append(c)
    assert len(out_calls) == 2, f"expected 2 out-of-subject generate_content calls, got {len(out_calls)}"
    temps = []
    for c in out_calls:
        cfg = kwarg(c, "config")
        assert isinstance(cfg, ast.Call) and call_name(cfg).endswith("GenerateContentConfig"), (
            "an out-of-subject model call has no GenerateContentConfig"
        )
        t = kwarg(cfg, "temperature")
        assert isinstance(t, ast.Constant), "an out-of-subject model call pins no temperature"
        temps.append(t.value)
    assert temps == [0.7, 0.7], f"out-of-subject temperatures = {temps}, expected [0.7, 0.7]"

    return (f"router imports {{generate_blueprint}} only; generate_ai_content has 1 importer + 1 call "
            f"site ({rel(ORCHESTRATOR)}); generate_blueprint's call graph = {sorted(reached)} "
            "(reaches neither generate_ai_content nor _strip_markdown_fences); 2 out-of-subject "
            "generate_content calls, both temperature=0.7")


# --------------------------------------------------------------------------------------
# T18 — every field spec.context[0] puts in front of the model: governed by rule R, or UNGUIDED
# --------------------------------------------------------------------------------------

EXPECTED_SLOTS: dict[str, list[str]] = {
    "WorkflowBlueprint": ["title", "trigger", "required_apps", "steps", "needs_human_approval",
                          "needs_clarification", "clarification_question", "missing_parameters",
                          "require_approval"],
    "WorkflowStep": ["step_number", "route", "app", "action", "parameters", "for_each",
                     "max_retries", "on_failure", "mutation_budget"],
    "TriggerSpec": ["type", "details", "cron", "event_app", "event_target"],
    "MissingParameter": ["step_number", "parameter_key", "label", "description", "suggested_type"],
}

# GOVERNED (20) — slot -> the operative prompt anchor that teaches it.
GOVERNED: dict[str, str] = {
    "WorkflowStep.route": "Rules for route classification:",
    "WorkflowStep.app": "`app` to the app's plain name",
    "WorkflowStep.action": "`action` to your best guess",
    "WorkflowStep.step_number": "step_number",
    "WorkflowStep.parameters": "parameters",
    "WorkflowStep.for_each": "for_each",
    "TriggerSpec.type": "`trigger.type`",
    "TriggerSpec.event_app": "event_app",
    "TriggerSpec.event_target": "event_target",
    "TriggerSpec.details": "`trigger.details`",
    "MissingParameter.step_number": "step_number",
    "MissingParameter.parameter_key": "parameter_key",
    "MissingParameter.label": "label",
    "MissingParameter.description": "description",
    "MissingParameter.suggested_type": "suggested_type",
    "WorkflowBlueprint.steps": "`steps` must contain ONLY",
    "WorkflowBlueprint.trigger": "`trigger.type`",
    "WorkflowBlueprint.needs_clarification": "needs_clarification",
    "WorkflowBlueprint.clarification_question": "clarification_question",
    "WorkflowBlueprint.missing_parameters": "missing_parameters",
}

# UNGUIDED, affordance-bearing (6) — must have ZERO occurrences in the rendered prompt.
UNGUIDED = [
    "WorkflowStep.max_retries", "WorkflowStep.on_failure", "WorkflowStep.mutation_budget",
    "WorkflowBlueprint.needs_human_approval", "WorkflowBlueprint.require_approval",
    "TriggerSpec.cron",
]
# UNGUIDED but schema-required and self-describing (2, benign).
BENIGN = ["WorkflowBlueprint.title", "WorkflowBlueprint.required_apps"]


def check_T18() -> str:
    # (a) the 28 slots, AST-enumerated, must match exactly
    actual = {model: class_fields(T_BLUEPRINT, model) for model in EXPECTED_SLOTS}
    for model, expected in EXPECTED_SLOTS.items():
        assert set(actual[model]) == set(expected), (
            f"{model} field set changed: {sorted(actual[model])} vs {sorted(expected)} — "
            "a schema change must be re-dispositioned, not silently widened"
        )
    total = sum(len(v) for v in actual.values())
    assert total == 28, f"expected 28 field slots, got {total}"

    accounted = set(GOVERNED) | set(UNGUIDED) | set(BENIGN)
    all_slots = {f"{m}.{f}" for m, fs in actual.items() for f in fs}
    assert accounted == all_slots, (
        f"disposition does not cover the schema exactly — unaccounted {sorted(all_slots - accounted)}, "
        f"stale {sorted(accounted - all_slots)}"
    )
    assert len(GOVERNED) == 20 and len(UNGUIDED) == 6 and len(BENIGN) == 2, (
        f"accounting broke: {len(GOVERNED)} governed + {len(UNGUIDED)} unguided + {len(BENIGN)} benign"
    )

    # (b) every GOVERNED slot's anchor is present in the rendered prompt
    absent = [slot for slot, anchor in GOVERNED.items() if anchor not in RENDERED]
    assert not absent, f"governed slots with no prompt anchor: {absent}"

    # (c) every UNGUIDED / BENIGN slot has ZERO occurrences in the rendered prompt
    nonzero = {
        slot: RENDERED.count(slot.split(".")[1])
        for slot in UNGUIDED + BENIGN
        if RENDERED.count(slot.split(".")[1]) != 0
    }
    assert not nonzero, f"a slot recorded as unguided DOES appear in the prompt: {nonzero}"

    sched, manual = RENDERED.count("schedule"), RENDERED.count("manual")
    assert sched == 1, f"'schedule' occurs {sched}x in the prompt, expected 1 (Rule 4 contrast clause only)"
    assert manual == 0, f"'manual' occurs {manual}x in the prompt, expected 0"

    # D8 (binding carry-forward) — needs_human_approval is UNGUIDED *and schema-REQUIRED*.
    wb_required = required_fields(T_BLUEPRINT, "WorkflowBlueprint")
    assert "needs_human_approval" in wb_required, (
        "needs_human_approval is no longer schema-required — the D8 disposition must be revised"
    )
    optional_unguided = [s for s in UNGUIDED if s.split(".")[1] not in
                         (required_fields(T_BLUEPRINT, s.split(".")[0]))]
    assert len(optional_unguided) == 5, (
        f"expected 5 optional/defaulted unguided fields, got {len(optional_unguided)}: {optional_unguided}"
    )

    return ("28/28 slots enumerated (WB 9 / WS 9 / TS 5 / MP 5) = 20 governed + 6 unguided + 2 benign; "
            "all 20 governed anchors present; all 8 unguided/benign at 0 occurrences; "
            "'schedule'=1 (Rule 4 contrast clause) / 'manual'=0; [D8] unguided splits 5 "
            "optional-or-defaulted + 1 schema-REQUIRED (needs_human_approval)")


# --------------------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------------------

CHECKS = [
    ("T2",  "spec.agent.systemPrompt is verbatim-faithful to the operative prompt (PR-014)", check_T2),
    ("T3",  "spec.context[0] is a live, call-time schema binding (not a stale copy)", check_T3),
    ("T4",  "spec.context[0].allowedOperations ['schema.read'] is not exceeded", check_T4),
    ("T5",  "spec.actions: [] holds — the planner is read/reason-only", check_T5),
    ("T6",  "triggers[0] studio-plan-request resolves to a real, reachable entry point", check_T6),
    ("T7",  "workflow.inline matches the real control flow (1 node, terminal, temp 0.1)", check_T7),
    ("T8",  "constraints[1] route enum is structurally enforced (unordered set equality)", check_T8),
    ("T9",  "constraints[2] output validates against the live schema on every call", check_T9),
    ("T10", "all six spec.intent.sop entries trace to prompt sites + schema affordances", check_T10),
    ("T11", "schema-aligned-execution's structural half is wired and on the hot path", check_T11),
    ("T12", "coverage-gate disposition for spec.capabilities.code: [] (vacuous, declared)", check_T12),
    ("T17", "planner.py L100-178 is out-of-subject execution-time code (boundary pinned)", check_T17),
    ("T18", "every context[0] schema slot is governed-by-rule or declared unguided", check_T18),
]


def main() -> int:
    print("verify_build_alignment.py — BUILD alignment harness for spec `voxagent-planner`")
    print(f"repo root : {REPO_ROOT}")
    print(f"spec      : {rel(SPEC_YAML)}")
    print("mode      : static/AST-only — no `import app.*`, no network, no GEMINI_API_KEY")
    print("")

    print("freeze digests (informational — not one of the 13 gates):")
    for path, expected in FROZEN_DIGESTS.items():
        got = sha12(path)
        mark = "match" if got == expected else f"DRIFT (frozen {expected})"
        print(f"  {got}  {rel(path)}  [{mark}]")
    print("")

    passed, failed = 0, []
    for tid, title, fn in CHECKS:
        try:
            detail = fn()
            passed += 1
            print(f"PASS  {tid}  {title}")
            print(f"         -> {detail}")
        except AssertionError as exc:
            failed.append(tid)
            print(f"FAIL  {tid}  {title}")
            print(f"         -> {exc}")
        except Exception as exc:  # harness fault, not a subject fault — still a failure
            failed.append(tid)
            print(f"FAIL  {tid}  {title}")
            print(f"         -> harness error: {type(exc).__name__}: {exc}")

    total = len(CHECKS)
    print("")
    print(f"{passed}/{total} PASS" + (f"  |  FAILED: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
