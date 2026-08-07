import asyncio
import contextvars
import json
import logging
import re
import traceback
import uuid
from datetime import datetime, timezone
from app.config import settings
from app.database import supabase
from app.services import pending_actions
from app.services.telemetry import telemetry_manager
from app.services.browser_engine import execute_browser_action
from app.services import composio_engine
from app.services.composio_engine import execute_composio_action
from app.services.http_engine import execute_http_webhook
from app.services.mutagent import classify_failure, execute_with_mutation
from app.services.mutagent import memory as mutation_memory
from app.services.planner import generate_ai_content
from app.services.telegram_client_engine import execute_telegram_client_action
from app.services.vault import is_vault_notes_target, save_vault_note

logger = logging.getLogger(__name__)

# Cross-step data handoff: a step's parameters may reference an earlier
# step's output with {{step_N_result}}, or (for event-triggered agents) the
# captured trigger payload with {{trigger_result}} — see planner.py's system
# prompt, which teaches Gemini this convention. Gemini doesn't always use the
# double-brace form despite the prompt spelling it out (observed emitting
# "{step_1_result}"), so both {token} and {{token}} are accepted rather than
# silently passing the literal placeholder through as data.
#
# {{trigger_chat_id}} and {{trigger_data}} are additional slots alongside
# {{trigger_result}} for triggers whose payload carries more than just a
# message body: {{trigger_chat_id}} is the sender/chat identifier (e.g. who
# to reply to), {{trigger_data}} is the full normalized event payload (see
# composio_engine.normalize_trigger_payload) for a step that wants
# structured data rather than just the message text. {{item}} is a further
# slot that only resolves to something meaningful inside a `for_each` step's
# own parameters — see _run_for_each_step — where it's set to the current
# iteration's value before that step's parameters are interpolated. Kept as
# separate placeholders rather than folded into {{trigger_result}} because
# that placeholder's whole-match resolves to the raw value verbatim (see
# _interpolate), and a text-generating step (e.g. an email body) needs the
# plain message text, not a dict it would have to reach into.
# Resolves both:
#   FORM A  {{step_N_result}}.prop  / {step_N_result}.prop    — dot AFTER closing brace
#   FORM B  {{step_N_result.prop}}  / {step_1_result.prop}    — dot INSIDE braces
# Single pattern, no duplicate named groups. The trick: capture `prop_b` inside
# the braces (only present in FORM B), then the closing brace, then optionally
# capture `prop_a` after (only present in FORM A).  Exactly one of prop_b/prop_a
# will be set; _get_prop() returns whichever one matched.
_PLACEHOLDER_TOKEN = (
    r"\{{1,2}"                                                             # opening {{ or {
    r"\s*"
    r"(?:step_(?P<step>\d+)_result"                                        # step_N_result
    r"|(?P<trigger_field>trigger_result|trigger_chat_id|trigger_data)"     # trigger slots
    r"|(?P<item_field>item))"                                              # item slot
    r"\s*"
    r"(?:\.(?P<prop_b>[a-zA-Z0-9_]+)\s*)?"                                # FORM B: prop inside braces (optional)
    r"\}{1,2}"                                                             # closing }} or }
    r"(?:\.(?P<prop_a>[a-zA-Z0-9_]+))?"                                   # FORM A: prop after braces (optional)
)
_FULL_PLACEHOLDER_RE = re.compile(rf"^{_PLACEHOLDER_TOKEN}$")
_INLINE_PLACEHOLDER_RE = re.compile(_PLACEHOLDER_TOKEN)


def _get_prop(m: re.Match) -> str | None:
    """Return the property name from either FORM_B (dot-inside braces) or
    FORM_A (dot-outside braces), or None when the placeholder has no property."""
    return m.group("prop_b") or m.group("prop_a") or None

# Runtime responses that read as a clarifying question rather than completed
# work (e.g. a browser_agent's underlying LLM asking "which platform did you
# mean?") should pause the workflow for human input instead of silently
# being treated as a successful result and fed into the next step.
_CLARIFICATION_HINTS = (
    "could you please",
    "can you specify",
    "can you please",
    "can you clarify",
    "please provide",
    "please specify",
    "please clarify",
    "let me know which",
    "which platform",
    "which messaging",
    "which service",
    "need more information",
    "specify which",
    "i need more details",
    "i need clarification",
)

# The current run's id, for the duration of one run_agent_workflow /
# resume_agent_workflow call — threaded through _persist_run and the pause
# sites below via a contextvar instead of an explicit parameter on every
# function in the call chain (_execute_steps -> _run_for_each_step/
# _run_single_step -> _run_for_each_items), since asyncio tasks each get
# their own copy of the context, so concurrent runs never see each other's
# run_id. Replaces the old in-memory-only _paused_runs dict — see
# app.services.pending_actions for the real persistence layer.
_current_run_id: contextvars.ContextVar = contextvars.ContextVar("orchestrator_current_run_id", default=None)

# The current run's agent.trigger_type ("on_demand" | "scheduled" |
# "event_trigger"), set alongside _current_run_id — used by
# _notify_user_of_unattended_pause below to only email for a run nobody's
# watching live (a scheduled/triggered run), not a manual run where the
# Studio's own live pause UI already covers it. Also stashed inside each
# pending_actions row's context_snapshot so resume_agent_workflow /
# reject_paused_run can restore it for a run that pauses more than once.
_current_trigger_type: contextvars.ContextVar = contextvars.ContextVar("orchestrator_current_trigger_type", default=None)

_UNATTENDED_TRIGGER_TYPES = {"scheduled", "event_trigger"}


def _notify_user_of_unattended_pause(user_id: str, app: str, question: str) -> None:
    """Best-effort email nudge for a pause on a run nobody's watching live.
    Replaces the old hardcoded approval-email address (MutAgent plan
    Part 1.4 — every user's approval requests used to go to one fixed
    inbox) with a real per-user lookup, and fires for any pause on an
    unattended run, not just the sensitive-action approval gate. Sent via
    the same mechanism that hardcoded address used (Composio Gmail, using
    whichever Gmail account this specific user has connected) — no new
    email provider needed. Fire-and-forget: nothing breaks if the user has
    no Gmail connected, they just don't get an email on top of the
    in-app Action Center."""
    if _current_trigger_type.get() not in _UNATTENDED_TRIGGER_TYPES:
        return
    if not supabase:
        return
    try:
        row = supabase.table("users").select("email").eq("id", user_id).limit(1).execute()
        email = (row.data[0]["email"] if row.data else None) or ""
    except Exception:
        return
    # Guest/seed accounts carry a synthetic "<uuid>@example.com" placeholder
    # (see the `users` table) rather than a real address — skip emailing a
    # fake inbox.
    if not email or email.endswith("@example.com"):
        return
    asyncio.create_task(
        execute_composio_action(
            app="gmail",
            action="GMAIL_SEND_EMAIL",
            parameters={
                "to": email,
                "subject": f"VoxAgent: {app} needs your input",
                "body": f"Your automation is paused and needs your input:\n\n{question}\n\nOpen VoxAgent's Action Center to respond.",
            },
            entity_id=user_id,
        )
    )


def _resolve_key(match):
    digits = match.group("step")
    if digits is not None:
        return int(digits)
    if match.group("item_field") is not None:
        return "item"
    field = match.group("trigger_field")
    if field in ("trigger_chat_id", "trigger_data"):
        return field
    return "trigger"


def _for_each_targets_step(for_each_spec, step_number) -> bool:
    """True when `for_each_spec` (a step's raw `for_each` field) is exactly
    the placeholder for `step_number`'s result — used to decide, purely from
    blueprint structure, whether an 'ai_generate' step should be asked to
    produce a list instead of one block of text (see _execute_steps)."""
    if not isinstance(for_each_spec, str):
        return False
    match = _FULL_PLACEHOLDER_RE.match(for_each_spec.strip())
    return bool(match) and match.group("step") is not None and int(match.group("step")) == step_number


def _coerce_list(raw_value):
    """Normalizes a for_each source value into a Python list to iterate
    over. Handles the common cases generically rather than assuming any one
    producing step's exact output shape: an actual list (e.g. an
    'ai_generate' step asked for as_list=True) passes through untouched; a
    JSON-encoded array string is parsed; a plain multi-line block of text
    (a model that ignored the list-output instruction) is split into lines
    as a best-effort fallback; anything else becomes a single-item list so a
    for_each step still runs (once) instead of silently doing nothing."""
    if isinstance(raw_value, list):
        return raw_value
    if isinstance(raw_value, dict):
        return list(raw_value.values())
    if raw_value is None:
        return []
    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except Exception:
            parsed = None
        if isinstance(parsed, list):
            return parsed
        lines = [line.strip(" -*\t") for line in stripped.splitlines() if line.strip()]
        return lines if len(lines) > 1 else [stripped]
    return [raw_value]


def _extract_result_value(result_data):
    """Pull the meaningful payload out of a step result dict, regardless of
    which engine produced it (browser_agent uses "result", composio_api uses
    "output", http_webhook uses "data")."""
    if not isinstance(result_data, dict):
        return result_data
    for key in ("result", "output", "data", "message"):
        if result_data.get(key) is not None:
            return result_data[key]
    return result_data


def _stringify(value):
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value)


def _resolve_property(base_value, prop: str | None):
    if not prop:
        return base_value
    
    # Try parsing base_value if it's a JSON string
    if isinstance(base_value, str):
        try:
            base_value = json.loads(base_value)
        except Exception:
            pass
            
    if isinstance(base_value, dict) and prop in base_value:
        return base_value[prop]
    return base_value


def _interpolate(value, step_results):
    """Recursively resolve {{step_N_result}} / {{trigger_result}} / {{item}}
    placeholders against prior steps' extracted results (and, for
    event-triggered runs, the captured trigger payload under the "trigger"
    key; and, inside a for_each iteration, the current item under "item").
    A parameter that is *exactly* a placeholder resolves to the referenced
    value verbatim (preserving its type — dict/list/number/str); a
    placeholder embedded in a larger string is stringified in place."""
    if isinstance(value, str):
        stripped = value.strip()
        full_match = _FULL_PLACEHOLDER_RE.match(stripped)
        if full_match:
            base_val = step_results.get(_resolve_key(full_match), value)
            return _resolve_property(base_val, _get_prop(full_match))
        if _INLINE_PLACEHOLDER_RE.search(value):
            return _INLINE_PLACEHOLDER_RE.sub(
                lambda m: _stringify(_resolve_property(step_results.get(_resolve_key(m)), _get_prop(m))), value
            )
        return value
    if isinstance(value, dict):
        return {k: _interpolate(v, step_results) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, step_results) for v in value]
    return value


def _looks_like_clarification_request(text) -> bool:
    if not isinstance(text, str):
        return False
    stripped = text.strip()
    if not stripped:
        return False
    if stripped.endswith("?"):
        return True
    lowered = stripped.lower()
    return any(hint in lowered for hint in _CLARIFICATION_HINTS)


async def _load_agent_blueprint(agent_id: str):
    agent_response = supabase.table("agents").select("*").eq("id", agent_id).execute()
    if not agent_response.data:
        return None, None
    agent_record = agent_response.data[0]
    blueprint = agent_record.get("json_blueprint", {})
    if isinstance(blueprint, str):
        try:
            blueprint = json.loads(blueprint)
        except Exception:
            blueprint = {}
    return agent_record, blueprint


async def _persist_run(agent_id: str, status: str, step_logs: list):
    try:
        supabase.table("execution_logs").insert({
            "agent_id": agent_id,
            "run_id": _current_run_id.get(),
            "status": status,
            "log_messages": step_logs,
            "proof_screenshot_url": None
        }).execute()
    except Exception as e:
        traceback.print_exc()
        logger.error(f"Error saving execution logs: {e}")
        await telemetry_manager.send_log(agent_id, "Warning: Failed to save execution logs to database.", level="warning")


async def _dispatch_action(agent_id, user_id, blueprint, steps, index, step_number, step_results, app, action, route, parameters):
    """Executes exactly one action call for a step (or one for_each
    iteration of a step) and returns its raw result dict. Pulled out of
    _run_single_step / _run_for_each_step so both paths share one dispatch
    table instead of drifting apart."""
    trigger_data = step_results.get("trigger_data")
    if isinstance(trigger_data, dict) and trigger_data.get("is_test"):
        parameters["_is_test_run"] = True

    if is_vault_notes_target(app):
        # No real destination was specified for extracted data (see
        # planner.py Rule 1) — persist the previous step's output into
        # vault_notes instead of attempting a generic HTTP call against a
        # non-existent URL.
        prev_step = steps[index - 1] if index > 0 else {}
        source_app = prev_step.get("app", app)
        source_action = prev_step.get("action", action)
        note_content = {
            "agent_name": blueprint.get("title") or "VoxAgent Automation",
            "source_app": source_app,
            "action": source_action,
            "data": step_results.get(step_number - 1, parameters),
            "extracted_at": datetime.now(timezone.utc).isoformat(),
        }
        note_title = f"{source_app} — {source_action}"[:255]
        saved_note = save_vault_note(user_id, note_title, note_content)
        return {"status": "success", "result": saved_note}

    if route == "browser_agent":
        # The acting LLM only ever sees task_description — passing the bare
        # `action` string (e.g. "monitor_messages") gives it zero context on
        # the app or target the blueprint's `app` and `parameters` fields
        # already captured, so it has nothing to act on and asks a
        # clarifying question back instead. Fold that context into the task
        # text explicitly.
        task_description = f"On {app}: {action}."
        if parameters:
            detail_str = ", ".join(f"{k}={v}" for k, v in parameters.items())
            task_description += f" Relevant details: {detail_str}."
        return await execute_browser_action(task_description=task_description, user_id=user_id, app_name=app)

    if route == "composio_api":
        return await execute_composio_action(app=app, action=action, parameters=parameters, entity_id=user_id)

    if route == "http_webhook":
        url = parameters.get("url") or action
        return await execute_http_webhook(url=url, payload=parameters)

    if route == "telegram_client":
        # Supports both "Telegram Personal Account" and "Telegram Bot" apps.
        # Resolves via telegram_client_engine using the specific app_name.
        return await execute_telegram_client_action(user_id=user_id, action=action, parameters=parameters, app_name=app)

    if route == "ai_generate":
        # Runs entirely on VoxAgent's own built-in AI — no external app
        # connection required (see planner.py's 'ai_generate' rule). The
        # internal-only "_as_list" flag is stripped out before this
        # reaches parameters the user actually specified.
        prompt = parameters.get("prompt") or parameters.get("text") or parameters.get("content") or ""
        as_list = bool(parameters.get("_as_list"))
        # An automation may be scoped to specific knowledge sources (e.g. a
        # bakery bot vs a real estate bot sharing the same user's knowledge
        # hub) — see EditAgentDrawer.jsx's Knowledge Sources picker. Absent
        # for agents that haven't set one, which keeps the old "search
        # everything" behavior for them.
        knowledge_sources = (blueprint or {}).get("knowledge_sources") or None
        try:
            content = generate_ai_content(prompt, as_list=as_list, user_id=user_id, knowledge_sources=knowledge_sources)
            return {"status": "success", "output": content}
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "error": str(e), "message": str(e)}

    return {"status": "error", "error": f"Unknown route: {route}"}


SENSITIVE_ACTIONS = {
    "LINKEDIN_CREATE_POST",
    "TWITTER_CREATE_TWEET",
    "TWITTER_CREATE_A_TWEET_OAUTH2",
    "GMAIL_SEND_EMAIL",
    "SLACK_SEND_MESSAGE",
}

async def _run_action_and_classify(agent_id, user_id, blueprint, steps, index, step_number, step_results, app, action, route, parameters):
    """Executes one action call and classifies the result the same way for
    both a plain step and a single for_each iteration.

    Returns (status, result_data, extracted_value, question) where status is
    "success" | "failed" | "needs_input".
    """
    require_approval = blueprint.get("require_approval", True)
    if require_approval and action and action.upper().strip() in SENSITIVE_ACTIONS and not parameters.get("_approved"):
        safe_params = {k: v for k, v in parameters.items() if k not in ["_approved", "clarification_answer"]}
        question = f"Please review and approve this {app} action:\n```json\n{json.dumps(safe_params, indent=2)}\n```\nReply 'Approved' to proceed."

        # Previously fired an email to a hardcoded personal address
        # ("24b81a67r1@gmail.com") regardless of which user's agent
        # triggered it (see MutAgent plan Part 1.4). Notification for an
        # unattended run is now handled uniformly at the pause-creation
        # sites (_run_single_step / _run_for_each_items) via
        # _notify_user_of_unattended_pause, using the real user's own
        # registered email — covers this approval-gate pause the same way
        # it covers any other.

        result_data = {"status": "needs_input", "question": question, "missing_field": "_approved"}
        result_data["failure_class"] = classify_failure(result_data, route=route).value
        return "needs_input", result_data, None, question

    # Remove internal tracking parameters before sending to API
    clean_parameters = {k: v for k, v in parameters.items() if k not in ["_approved", "clarification_answer"]}

    current_step = steps[index] if 0 <= index < len(steps) else {}
    result_data, caught_exception = await execute_with_mutation(
        _dispatch_action,
        (agent_id, user_id, blueprint, steps, index, step_number, step_results, app, action, route, clean_parameters),
        agent_id=agent_id,
        step_number=step_number,
        route=route,
        app=app,
        action=action,
        mutation_budget=current_step.get("mutation_budget"),
    )
    if caught_exception is not None:
        # traceback.print_exc() only works inside a live except block (it
        # reads sys.exc_info()) — the exception was already caught and
        # stored inside execute_with_mutation by the time we get here, so
        # print_exception() with the saved object is used instead.
        traceback.print_exception(type(caught_exception), caught_exception, caught_exception.__traceback__)

    is_error = result_data.get("status") == "error"
    # composio_api steps can report "needs_input" directly (a schema
    # validation error from the target app's own JSON Schema — see
    # composio_engine._build_execution_result) alongside the existing
    # text-heuristic for browser_agent's "which platform did you mean?"
    # style replies. Either source pauses the run the same way.
    explicit_question = result_data.get("question") if result_data.get("status") == "needs_input" else None
    extracted_value = None if (is_error or explicit_question) else _extract_result_value(result_data)
    question = explicit_question or (
        extracted_value.strip()
        if not is_error and route == "browser_agent" and _looks_like_clarification_request(extracted_value)
        else None
    )

    if question:
        result_data["failure_class"] = classify_failure(result_data, caught_exception, route=route).value
        return "needs_input", result_data, extracted_value, question
    if is_error:
        result_data["failure_class"] = classify_failure(result_data, caught_exception, route=route).value
        return "failed", result_data, extracted_value, None
    result_data["failure_class"] = None
    return "success", result_data, extracted_value, None


def _log_entry(step_number, app, action, route, result):
    return {
        "step": step_number,
        "app": app,
        "action": action,
        "route": route,
        "result": result,
        "at": datetime.now(timezone.utc).isoformat(),
    }


async def _run_single_step(agent_id, user_id, blueprint, steps, index, step_number, route, app, action, raw_parameters, step_results, step_logs):
    parameters = _interpolate(raw_parameters, step_results)
    await telemetry_manager.send_log(agent_id, f"Executing Step {step_number}: {action} on {app}", level="info")

    status, result_data, extracted_value, question = await _run_action_and_classify(
        agent_id, user_id, blueprint, steps, index, step_number, step_results, app, action, route, parameters
    )

    if status == "needs_input":
        reconnect_app = result_data.get("reconnect_app")
        missing_field = result_data.get("missing_field") if result_data.get("question") else None
        step_logs.append(_log_entry(step_number, app, action, route, {"status": "needs_input", "question": question}))
        pending_actions.create_pending_action(
            run_id=_current_run_id.get(),
            agent_id=agent_id,
            user_id=user_id,
            step_number=step_number,
            question=question,
            input_type=(
                "credential_reconnect" if reconnect_app
                else "confirm" if missing_field == "_approved"
                else "text"
            ),
            context_snapshot={
                "user_id": user_id,
                "blueprint": blueprint,
                "steps": steps,
                "step_results": dict(step_results),
                "paused_index": index,
                # When the pause came from a schema validation error (see
                # composio_engine._build_execution_result), this names the
                # one required field that was missing, so resume can drop
                # the user's answer straight into it instead of an opaque
                # "clarification_answer" the target tool's schema wouldn't
                # recognize.
                "missing_field": missing_field,
                # Set instead of missing_field when the pause is "this app
                # isn't connected" (see composio_engine.execute_composio_action)
                # — resume doesn't need the answer to go anywhere specific,
                # just to retry once the user has reconnected it elsewhere.
                "reconnect_app": reconnect_app,
                "trigger_type": _current_trigger_type.get(),
            },
        )
        _notify_user_of_unattended_pause(user_id, app, question)
        await telemetry_manager.send_log(
            agent_id,
            f"Step {step_number} needs clarification: {question}",
            level="needs_input",
            data={"type": "clarification_needed", "step": step_number, "question": question, "reconnect_app": reconnect_app},
        )
        await _persist_run(agent_id, "needs_input", step_logs)
        return "needs_input"

    if status == "failed":
        step_logs.append(_log_entry(step_number, app, action, route, result_data))
        error_detail = result_data.get("error") or result_data.get("message") or "Unknown error"
        await telemetry_manager.send_log(agent_id, f"Step {step_number} failed: {error_detail}", level="error")
        await telemetry_manager.send_log(agent_id, "Halting workflow due to error.", level="error")
        return "failed"

    step_results[step_number] = extracted_value
    step_logs.append(_log_entry(step_number, app, action, route, result_data))
    await telemetry_manager.send_log(agent_id, f"Step {step_number} completed: {json.dumps(result_data)[:200]}", level="success")
    return "success"


async def _run_for_each_items(agent_id, user_id, blueprint, steps, index, step_number, route, app, action, raw_parameters, step_results, step_logs, items, outputs, start_item_index):
    """Runs items[start_item_index:], appending each one's extracted value
    to `outputs` in place. Shared by a fresh for_each step (start_item_index
    0, outputs []) and a resume (see _resume_for_each_step) that picks back
    up mid-batch instead of redoing already-completed items.

    A needs_input result pauses the WHOLE workflow the same way a plain
    step does (see _run_single_step) — never silently converted into a
    failure — so the user always gets a popup to fill in whatever's
    missing instead of the run just dying partway through a batch.
    """
    for i in range(start_item_index, len(items)):
        item = items[i]
        step_results["item"] = item
        try:
            parameters = _interpolate(raw_parameters, step_results)
        finally:
            step_results.pop("item", None)

        status, result_data, extracted_value, question = await _run_action_and_classify(
            agent_id, user_id, blueprint, steps, index, step_number, step_results, app, action, route, parameters
        )

        if status == "needs_input":
            reconnect_app = result_data.get("reconnect_app")
            missing_field = result_data.get("missing_field") if result_data.get("question") else None
            step_logs.append(_log_entry(step_number, app, action, route, {"status": "needs_input", "question": question}))
            pending_actions.create_pending_action(
                run_id=_current_run_id.get(),
                agent_id=agent_id,
                user_id=user_id,
                step_number=step_number,
                question=question,
                input_type=(
                    "credential_reconnect" if reconnect_app
                    else "confirm" if missing_field == "_approved"
                    else "text"
                ),
                context_snapshot={
                    "user_id": user_id,
                    "blueprint": blueprint,
                    "steps": steps,
                    "step_results": dict(step_results),
                    "paused_index": index,
                    "missing_field": missing_field,
                    "reconnect_app": reconnect_app,
                    # The missing value (e.g. a spreadsheet name) almost
                    # always applies to the whole batch, not just this one
                    # item — on resume it gets baked into the step's own
                    # template parameters (see resume_agent_workflow) so
                    # every remaining item picks it up, and the batch
                    # continues from here rather than redoing items[:i]
                    # that already succeeded.
                    "for_each": {"items": items, "outputs": list(outputs), "resume_item_index": i},
                    "trigger_type": _current_trigger_type.get(),
                },
            )
            _notify_user_of_unattended_pause(user_id, app, question)
            await telemetry_manager.send_log(
                agent_id,
                f"Step {step_number} needs clarification: {question}",
                level="needs_input",
                data={"type": "clarification_needed", "step": step_number, "question": question, "reconnect_app": reconnect_app},
            )
            await _persist_run(agent_id, "needs_input", step_logs)
            return "needs_input"

        if status == "failed":
            error_detail = result_data.get("error") or result_data.get("message") or "Unknown error"
            message = f"Item {i + 1}/{len(items)} failed: {error_detail}"
            step_logs.append(_log_entry(step_number, app, action, route, result_data))
            await telemetry_manager.send_log(agent_id, f"Step {step_number} failed: {message}", level="error")
            await telemetry_manager.send_log(agent_id, "Halting workflow due to error.", level="error")
            return "failed"

        outputs.append(extracted_value)
        await telemetry_manager.send_log(agent_id, f"Step {step_number}: item {i + 1}/{len(items)} completed.", level="success")

    step_results[step_number] = outputs
    step_logs.append(_log_entry(step_number, app, action, route, {"status": "success", "output": outputs, "items_processed": len(items)}))
    await telemetry_manager.send_log(agent_id, f"Step {step_number} completed: fanned out across {len(items)} item(s).", level="success")
    return "success"


def _item_placeholder_keys(raw_parameters) -> list:
    """Top-level parameter keys whose value is the {{item}} placeholder —
    either bare, or wrapped one level in a single-entry dict (e.g.
    `{"Caption": "{{item}}"}`, a common shape when the planner labels the
    per-iteration value under a column name — see planner.py Rule 5/6).
    Used to check, via the destination's real schema, whether it wants one
    call per item or the whole batch in one call (see _run_for_each_step's
    batching check) and, if so, how to expand each key for that batched
    call (see _expand_item_placeholder).
    """
    def _is_item_placeholder(v) -> bool:
        if not isinstance(v, str):
            return False
        match = _FULL_PLACEHOLDER_RE.match(v.strip())
        return bool(match and match.group("item_field") is not None)

    keys = []
    for k, v in (raw_parameters or {}).items():
        if _is_item_placeholder(v):
            keys.append(k)
        elif isinstance(v, dict) and len(v) == 1 and _is_item_placeholder(next(iter(v.values()))):
            keys.append(k)
    return keys


def _expand_item_placeholder(value, items: list):
    """Batched replacement for one of `_item_placeholder_keys`' keys: the
    full items list itself for a bare {{item}} value, or one dict per item
    preserving the same wrapper key for a `{"Label": "{{item}}"}` value —
    so e.g. `{"Caption": "{{item}}"}` becomes
    `[{"Caption": cap1}, {"Caption": cap2}, ...]`, which
    composio_engine._coerce_value_type already knows how to turn into one
    row per item (see its flat-list-of-dicts handling).
    """
    if isinstance(value, dict):
        (inner_key, _), = value.items()
        return [{inner_key: item} for item in items]
    return items


async def _run_for_each_step(agent_id, user_id, blueprint, steps, index, step_number, route, app, action, raw_parameters, for_each_spec, step_results, step_logs):
    """Runs this step once per item of an earlier step's result (see
    planner.py Rule 5) — e.g. one Google Sheets row per AI-generated
    caption. {{item}} inside `raw_parameters` resolves to the current item
    on each iteration; every other placeholder resolves as usual.

    EXCEPTION: when the destination's real schema shows {{item}} is headed
    for an array-typed field (e.g. Google Sheets' `rows` — see
    composio_engine.find_array_batch_param), the whole batch belongs in a
    SINGLE call instead of one call per item; a spreadsheet row-adder given
    one row per call with no headers would otherwise treat every single
    call as "just a header row" and store zero actual data each time. That
    single call is delegated straight to _run_single_step with {{item}}
    replaced by the full items list, rather than duplicating its pause/
    fail/success handling here.
    """
    match = _FULL_PLACEHOLDER_RE.match((for_each_spec or "").strip())
    source_value = step_results.get(_resolve_key(match)) if match else None
    items = _coerce_list(source_value)

    if not items:
        # Matches _run_single_step's opening message format exactly — the
        # live Agent Studio view's stepper (see AgentStudio.jsx's
        # applyStatusFromMessage) only flips a step to "executing" on a
        # message starting with "Executing Step N".
        await telemetry_manager.send_log(agent_id, f"Executing Step {step_number}: {action} on {app}", level="info")
        await telemetry_manager.send_log(
            agent_id, f"Step {step_number}: for_each source is empty — skipping {action} on {app}.", level="warning"
        )
        step_results[step_number] = []
        step_logs.append(_log_entry(step_number, app, action, route, {"status": "success", "output": []}))
        return "success"

    if route == "composio_api":
        item_keys = _item_placeholder_keys(raw_parameters)
        batch_param = composio_engine.find_array_batch_param(app, action, item_keys) if item_keys else None
        if batch_param:
            await telemetry_manager.send_log(
                agent_id,
                f"Step {step_number}: batching {len(items)} item(s) into a single {action} call on {app} "
                f"(target's '{batch_param}' accepts the whole list, not one call per item).",
                level="info",
            )
            batched_parameters = {**raw_parameters, **{k: _expand_item_placeholder(raw_parameters[k], items) for k in item_keys}}
            return await _run_single_step(
                agent_id, user_id, blueprint, steps, index, step_number, route, app, action,
                batched_parameters, step_results, step_logs,
            )

    await telemetry_manager.send_log(agent_id, f"Executing Step {step_number}: {action} on {app}", level="info")
    await telemetry_manager.send_log(
        agent_id, f"Step {step_number}: fanning out {action} on {app} across {len(items)} item(s).", level="info"
    )
    return await _run_for_each_items(
        agent_id, user_id, blueprint, steps, index, step_number, route, app, action,
        raw_parameters, step_results, step_logs, items, [], 0,
    )


async def _resume_for_each_step(agent_id, user_id, blueprint, steps, index, step_number, route, app, action, raw_parameters, step_results, step_logs, for_each_state):
    """Continues a for_each step that paused mid-batch (see
    _run_for_each_items), picking up at the item that needed clarification
    instead of redoing items that already succeeded."""
    items = for_each_state["items"]
    outputs = list(for_each_state.get("outputs") or [])
    start_item_index = for_each_state.get("resume_item_index", 0)
    await telemetry_manager.send_log(
        agent_id,
        f"Resuming Step {step_number}: retrying item {start_item_index + 1}/{len(items)} on {app}.",
        level="info",
    )
    return await _run_for_each_items(
        agent_id, user_id, blueprint, steps, index, step_number, route, app, action,
        raw_parameters, step_results, step_logs, items, outputs, start_item_index,
    )


async def _execute_steps(agent_id, user_id, blueprint, steps, step_results, step_logs, start_index=0):
    """Runs `steps` starting at `start_index`, mutating `step_results` and
    `step_logs` in place. Returns "success", "failed", or "needs_input" —
    the latter means a step's output looked like a clarifying question, and
    a paused-run context has been stored for resume_agent_workflow to pick
    up later."""
    for index in range(start_index, len(steps)):
        step = steps[index]
        step_number = step.get("step_number", index + 1)
        route = step.get("route")
        app = step.get("app", "Unknown App")
        action = step.get("action", "")
        raw_parameters = dict(step.get("parameters", {}) or {})
        for_each_spec = step.get("for_each")

        if route == "ai_generate":
            # Decided purely from blueprint structure — an ai_generate step
            # produces a JSON array instead of one block of text exactly
            # when a LATER step fans out over its result via for_each (see
            # planner.py Rule 5), so the planner only ever has to set
            # for_each on the *consuming* step, not a second, easily
            # mismatched flag here.
            fans_out = any(_for_each_targets_step(s.get("for_each"), step_number) for s in steps[index + 1:])
            raw_parameters["_as_list"] = fans_out

        if for_each_spec:
            outcome = await _run_for_each_step(
                agent_id, user_id, blueprint, steps, index, step_number, route, app, action,
                raw_parameters, for_each_spec, step_results, step_logs,
            )
        else:
            outcome = await _run_single_step(
                agent_id, user_id, blueprint, steps, index, step_number, route, app, action,
                raw_parameters, step_results, step_logs,
            )

        if outcome != "success":
            return outcome

    return "success"


async def run_agent_workflow(
    agent_id: str,
    user_id: str = "00000000-0000-0000-0000-000000000000",
    trigger_result=None,
    trigger_chat_id=None,
    trigger_data=None,
):
    """Runs an agent's blueprint steps top to bottom.

    `trigger_result` is set when this run was fired by an event trigger
    (see trigger_engine.py) — it seeds the {{trigger_result}} placeholder
    with the captured event's message text so the first reaction step can
    use it. `trigger_chat_id` additionally seeds {{trigger_chat_id}} for
    triggers that carry a sender/chat identifier alongside the message
    body, and `trigger_data` seeds {{trigger_data}} with the full
    normalized event payload for a step that wants structured data rather
    than just the text. All three are populated generically for any
    trigger-capable app by composio_engine.normalize_trigger_payload.
    """
    _current_run_id.set(str(uuid.uuid4()))
    if not supabase:
        logger.error("Supabase client is not initialized")
        return

    try:
        agent_record, blueprint = await _load_agent_blueprint(agent_id)
        if agent_record is None:
            await telemetry_manager.send_log(agent_id, f"Agent {agent_id} not found.", level="error")
            return
        _current_trigger_type.set(agent_record.get("trigger_type"))
    except Exception as e:
        traceback.print_exc()
        logger.error(f"Error fetching agent: {e}")
        await telemetry_manager.send_log(agent_id, f"Error fetching agent: {e}", level="error")
        return

    steps = blueprint.get("steps", [])
    step_results = {}
    if trigger_result is not None:
        step_results["trigger"] = trigger_result
    if trigger_chat_id is not None:
        step_results["trigger_chat_id"] = trigger_chat_id
    if trigger_data is not None:
        step_results["trigger_data"] = trigger_data

    await telemetry_manager.send_log(agent_id, "Starting workflow execution...", level="info")

    step_logs = []
    outcome = await _execute_steps(agent_id, user_id, blueprint, steps, step_results, step_logs)

    if outcome == "needs_input":
        # _execute_steps already persisted the "needs_input" run and emitted
        # telemetry — nothing further to do until resume_agent_workflow runs.
        return

    await _persist_run(agent_id, outcome, step_logs)
    final_msg = "Workflow execution completed." if outcome == "success" else "Workflow execution failed."
    await telemetry_manager.send_log(agent_id, final_msg, level=("success" if outcome == "success" else "error"))


async def _maybe_record_learned_fix(step_logs, resumed_step, missing_field, answer):
    """MutAgent Phase 3 — if the answer the human just gave actually
    resolved the paused step (its fresh result in step_logs shows
    "success"), remember it in mutation_memory so the exact same
    (app, action, missing_field) gap self-heals next time instead of
    pausing again. Never records a "fix" that didn't actually work."""
    if not (settings.MUTAGENT_ENABLED and missing_field and missing_field != "_approved"):
        return
    step_number = resumed_step.get("step_number")
    matching = next((entry for entry in step_logs if entry.get("step") == step_number), None)
    if not matching or (matching.get("result") or {}).get("status") != "success":
        return
    app = resumed_step.get("app", "Unknown App")
    action = resumed_step.get("action", "")
    await mutation_memory.record_fix(
        app,
        action,
        missing_field,
        fix_type="param_map",
        fix_payload={"parameter_key": missing_field, "value": answer},
    )


async def resume_agent_workflow(agent_id: str, answer: str):
    """Resumes a run that paused for clarification, injecting the user's
    answer into the paused step's context and continuing from there.

    The pause context now lives in the `pending_actions` table (see
    app.services.pending_actions) instead of an in-memory-only dict, so a
    server restart no longer loses it — this can resume a run paused
    before this very process started.
    """
    pending = pending_actions.get_pending_action(agent_id)
    if not pending:
        raise ValueError("No paused run found for this agent — it may have already been resumed, or the pause expired.")

    _current_run_id.set(pending.get("run_id"))
    context = pending["context_snapshot"] or {}
    _current_trigger_type.set(context.get("trigger_type"))

    user_id = context["user_id"]
    blueprint = context["blueprint"]
    steps = list(context["steps"])
    step_results = {int(k) if k.isdigit() else k: v for k, v in context.get("step_results", {}).items()}
    paused_index = context["paused_index"]

    # Re-run the paused step with the user's answer folded into its
    # parameters. If the pause was a schema validation error naming exactly
    # one missing required field, the answer goes straight into that field
    # (the target tool's schema wouldn't recognize "clarification_answer");
    # otherwise (an LLM's own clarifying question) it's added generically
    # for the acting LLM to interpret.
    resumed_step = dict(steps[paused_index])
    missing_field = context.get("missing_field")
    answer_key = missing_field or "clarification_answer"
    resumed_step["parameters"] = {**resumed_step.get("parameters", {}), answer_key: answer}
    steps[paused_index] = resumed_step

    pending_actions.resolve_pending_action(pending["id"], answer=answer)
    await telemetry_manager.send_log(agent_id, f"Resuming with clarification: {answer}", level="info")

    step_logs = []
    for_each_state = context.get("for_each")

    if for_each_state:
        # The paused step was fanning out over a batch — the answer applies
        # to the whole step (e.g. a spreadsheet name), so it's now baked
        # into every remaining item's parameters above; continue the batch
        # from the item that paused rather than restarting it.
        step_number = resumed_step.get("step_number", paused_index + 1)
        route = resumed_step.get("route")
        app = resumed_step.get("app", "Unknown App")
        action = resumed_step.get("action", "")
        raw_parameters = dict(resumed_step.get("parameters", {}) or {})
        outcome = await _resume_for_each_step(
            agent_id, user_id, blueprint, steps, paused_index, step_number, route, app, action,
            raw_parameters, step_results, step_logs, for_each_state,
        )
        await _maybe_record_learned_fix(step_logs, resumed_step, missing_field, answer)
        if outcome == "needs_input":
            return
        if outcome == "success":
            outcome = await _execute_steps(agent_id, user_id, blueprint, steps, step_results, step_logs, start_index=paused_index + 1)
    else:
        outcome = await _execute_steps(agent_id, user_id, blueprint, steps, step_results, step_logs, start_index=paused_index)
        await _maybe_record_learned_fix(step_logs, resumed_step, missing_field, answer)

    if outcome == "needs_input":
        return

    await _persist_run(agent_id, outcome, step_logs)
    final_msg = "Workflow execution completed." if outcome == "success" else "Workflow execution failed."
    await telemetry_manager.send_log(agent_id, final_msg, level=("success" if outcome == "success" else "error"))


def has_paused_run(agent_id: str) -> bool:
    return pending_actions.has_pending_action(agent_id)


async def reject_paused_run(agent_id: str, reason: str = "Rejected by user") -> None:
    """A real reject branch (see MutAgent plan Part 3.2) for a paused step
    — distinct from resume_agent_workflow, which would otherwise inject
    "Rejected" as the answer and, for the sensitive-action approval gate
    specifically, set parameters["_approved"] to that string — a TRUTHY
    value the gate would treat as approved regardless of what it says.
    This never re-attempts the paused action at all; it either skips it
    (if the step's own `on_failure` is "skip") or halts the run, honoring
    the per-step policy from the Phase 0 schema addition."""
    pending = pending_actions.get_pending_action(agent_id)
    if not pending:
        raise ValueError("No paused run found for this agent — it may have already been resumed, or the pause expired.")

    _current_run_id.set(pending.get("run_id"))
    context = pending["context_snapshot"] or {}
    _current_trigger_type.set(context.get("trigger_type"))

    user_id = context["user_id"]
    blueprint = context["blueprint"]
    steps = list(context["steps"])
    step_results = {int(k) if k.isdigit() else k: v for k, v in context.get("step_results", {}).items()}
    paused_index = context["paused_index"]
    rejected_step = steps[paused_index]
    step_number = rejected_step.get("step_number", paused_index + 1)
    on_failure = rejected_step.get("on_failure") or "halt"

    pending_actions.resolve_pending_action(pending["id"], answer=reason)

    step_logs = []
    if on_failure == "skip":
        step_logs.append(_log_entry(
            step_number, rejected_step.get("app"), rejected_step.get("action"), rejected_step.get("route"),
            {"status": "skipped", "reason": reason},
        ))
        await telemetry_manager.send_log(
            agent_id, f"Step {step_number} rejected by user — skipping (on_failure=skip): {reason}", level="warning",
        )
        outcome = await _execute_steps(agent_id, user_id, blueprint, steps, step_results, step_logs, start_index=paused_index + 1)
        if outcome == "needs_input":
            return
        await _persist_run(agent_id, outcome, step_logs)
        final_msg = "Workflow execution completed." if outcome == "success" else "Workflow execution failed."
        await telemetry_manager.send_log(agent_id, final_msg, level=("success" if outcome == "success" else "error"))
    else:
        step_logs.append(_log_entry(
            step_number, rejected_step.get("app"), rejected_step.get("action"), rejected_step.get("route"),
            {"status": "failed", "error": f"Rejected by user: {reason}"},
        ))
        await telemetry_manager.send_log(agent_id, f"Step {step_number} rejected by user — halting workflow: {reason}", level="error")
        await _persist_run(agent_id, "failed", step_logs)
