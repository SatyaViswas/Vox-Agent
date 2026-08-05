"""MutAgent Phase 2 — the interceptor entry point wrapping a single engine
dispatch call with retry-with-backoff for transient/rate-limited failures.

This is intentionally the *only* mutator wired in so far (RetryMutator).
When MUTAGENT_ENABLED is False (the default), execute_with_mutation makes
exactly one attempt and returns immediately — byte-for-byte the same
behavior orchestrator.py had before MutAgent existed. Nothing else in the
codebase needs to change for this to be safe to ship.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any, Awaitable, Callable, Optional

from app.config import settings
from app.services.mutagent import memory
from app.services.mutagent import llm_repair
from app.services.mutagent import circuit_breaker
from app.services.mutagent.classifier import FailureClass, classify_failure
from app.services.telemetry import telemetry_manager

_RETRYABLE = (FailureClass.TRANSIENT, FailureClass.RATE_LIMIT)


def _backoff_delay(attempt: int) -> float:
    """Exponential backoff with jitter, capped at 8s. attempt is 1-indexed
    (the delay is how long to wait *before* the next attempt)."""
    base = min(8.0, 0.5 * (2 ** (attempt - 1)))
    return base + random.uniform(0, base * 0.25)


async def execute_with_mutation(
    dispatch_fn: Callable[..., Awaitable[dict]],
    dispatch_args: tuple,
    *,
    agent_id: str,
    step_number: int,
    route: Optional[str],
    app: Optional[str] = None,
    action: Optional[str] = None,
    mutation_budget: Optional[int] = None,
) -> tuple[dict[str, Any], Optional[Exception]]:
    """Calls dispatch_fn(*dispatch_args), retrying with backoff if the
    result classifies as a transient/rate-limit failure. Returns
    (result_data, caught_exception) — the same shape orchestrator.py already
    produced from a single unwrapped call, so callers don't need to change
    how they handle the result."""
    # Phase 7 — an (app, action) with a known-open circuit breaker skips the
    # ENTIRE mutation pipeline below (retry, mutation_memory, selector,
    # LLM repair), not just the costliest one — still makes the one plain
    # attempt (it may have recovered), but doesn't spend extra latency/LLM
    # cost re-discovering it's still broken on every single run.
    breaker_open = bool(app and action and circuit_breaker.is_open(app, action))

    max_attempts = 1
    if settings.MUTAGENT_ENABLED and not breaker_open:
        budget = mutation_budget if mutation_budget is not None else settings.MUTAGENT_MAX_RETRY_ATTEMPTS
        max_attempts = max(1, budget)

    attempt = 0
    last_exception: Optional[Exception] = None
    result_data: dict[str, Any] = {}

    while attempt < max_attempts:
        attempt += 1
        last_exception = None
        try:
            result_data = await dispatch_fn(*dispatch_args)
        except Exception as e:
            last_exception = e
            result_data = {"status": "error", "error": str(e), "message": str(e)}

        if attempt >= max_attempts:
            break

        failure_class = classify_failure(result_data, last_exception, route=route)
        if failure_class not in _RETRYABLE:
            break

        delay = _backoff_delay(attempt)
        await telemetry_manager.send_log(
            agent_id,
            f"Self-healing: retrying step {step_number} "
            f"({failure_class.value} error, attempt {attempt + 1}/{max_attempts})",
            level="info",
            data={
                "type": "mutation_attempt",
                "step": step_number,
                "failure_class": failure_class.value,
                "attempt": attempt + 1,
                "max_attempts": max_attempts,
            },
        )
        await asyncio.sleep(delay)

    # Phase 3 — if the step is still stuck asking for one named missing
    # field, check whether a human already solved this exact (app, action,
    # field) gap on a previous run. If so, apply the remembered value once
    # instead of pausing again. dispatch_args' last element is always the
    # step's `parameters` dict (see orchestrator._run_action_and_classify).
    if settings.MUTAGENT_ENABLED and not breaker_open and app and action and result_data.get("status") == "needs_input":
        missing_field = result_data.get("missing_field")
        if missing_field and missing_field != "_approved":
            remembered = await memory.lookup_fix(app, action, missing_field)
            if remembered and remembered.get("fix_type") == "param_map":
                fix_value = (remembered.get("fix_payload") or {}).get("value")
                fixed_parameters = dict(dispatch_args[-1])
                fixed_parameters[missing_field] = fix_value
                fixed_args = dispatch_args[:-1] + (fixed_parameters,)

                await telemetry_manager.send_log(
                    agent_id,
                    f"Self-healing: applying a previously-learned fix for step {step_number} "
                    f"({app} was missing '{missing_field}').",
                    level="info",
                    data={
                        "type": "mutation_memory_applied",
                        "step": step_number,
                        "app": app,
                        "missing_field": missing_field,
                    },
                )
                last_exception = None
                try:
                    retried_result = await dispatch_fn(*fixed_args)
                except Exception as e:
                    last_exception = e
                    retried_result = {"status": "error", "error": str(e), "message": str(e)}

                # Only trust the memory-driven retry if it actually moved
                # past the SAME gap — otherwise fall through to the normal
                # needs_input pause rather than trusting stale/wrong memory
                # forever.
                same_gap_again = (
                    retried_result.get("status") == "needs_input"
                    and retried_result.get("missing_field") == missing_field
                )
                if not same_gap_again:
                    result_data = retried_result

    # Phase 4a — SelectorMutator: a browser_agent step looks stuck (nothing
    # found, or it asked a clarifying question instead of finishing).
    # Reuses dispatch_fn itself (rather than calling browser_engine
    # directly) by folding the previous outcome into the step's own
    # parameters under `_mutation_hint` — orchestrator._dispatch_action
    # already flattens every parameter into the browser agent's task
    # description, so this reaches it for free. Capped at one extra try.
    if settings.MUTAGENT_ENABLED and not breaker_open and route == "browser_agent":
        failure_class = classify_failure(result_data, last_exception, route=route)
        if failure_class == FailureClass.SELECTOR_DRIFT:
            previous_text = (
                result_data.get("question")
                or result_data.get("error")
                or result_data.get("result")
                or "no usable result"
            )
            hinted_parameters = dict(dispatch_args[-1])
            hinted_parameters["_mutation_hint"] = (
                f'A previous attempt at this task did not succeed and returned: "{previous_text}". '
                f"Try a different approach this time."
            )
            hinted_args = dispatch_args[:-1] + (hinted_parameters,)

            await telemetry_manager.send_log(
                agent_id,
                f"Self-healing: retrying step {step_number} with an adjusted approach (selector drift).",
                level="info",
                data={"type": "mutation_attempt", "step": step_number, "failure_class": failure_class.value, "mutator": "selector"},
            )
            last_exception = None
            try:
                retried_result = await dispatch_fn(*hinted_args)
            except Exception as e:
                last_exception = e
                retried_result = {"status": "error", "error": str(e), "message": str(e)}
            if classify_failure(retried_result, last_exception, route=route) != FailureClass.SELECTOR_DRIFT:
                result_data = retried_result

    # Phase 4b — LLMRepairMutator: last resort for a parameter/action-shaped
    # gap (composio_api / http_webhook only — browser_agent is handled by
    # the SelectorMutator above instead) that retrying and mutation_memory
    # couldn't resolve. Independently gated so it can be validated apart
    # from Phase 2/3, and respects shadow mode (propose + log only) until
    # you trust it enough to let it actually apply.
    failure_class_final = classify_failure(result_data, last_exception, route=route)
    repairable = failure_class_final in (FailureClass.SCHEMA_MISMATCH, FailureClass.ROUTE_MISMATCH)
    if (
        settings.MUTAGENT_LLM_REPAIR_ENABLED
        and not breaker_open
        and repairable
        and route in ("composio_api", "http_webhook")
        and app
        and action
    ):
        error_text = result_data.get("question") or result_data.get("error") or "unknown failure"
        current_parameters = dispatch_args[-1]
        proposed = await llm_repair.propose_repair(
            app=app, action=action, parameters=current_parameters, error_text=error_text,
        )
        if proposed:
            if settings.MUTAGENT_SHADOW_MODE:
                await telemetry_manager.send_log(
                    agent_id,
                    f"Self-healing (shadow mode): would retry step {step_number} with an LLM-proposed fix — not applied.",
                    level="info",
                    data={"type": "mutation_shadow", "step": step_number, "proposed_parameters": proposed},
                )
            else:
                fixed_args = dispatch_args[:-1] + (proposed,)
                await telemetry_manager.send_log(
                    agent_id,
                    f"Self-healing: retrying step {step_number} with an LLM-proposed fix.",
                    level="info",
                    data={"type": "mutation_attempt", "step": step_number, "failure_class": failure_class_final.value, "mutator": "llm_repair"},
                )
                last_exception = None
                try:
                    retried_result = await dispatch_fn(*fixed_args)
                except Exception as e:
                    last_exception = e
                    retried_result = {"status": "error", "error": str(e), "message": str(e)}

                if classify_failure(retried_result, last_exception, route=route) != failure_class_final:
                    missing_field_before = result_data.get("missing_field")
                    result_data = retried_result
                    if (
                        result_data.get("status") == "success"
                        and missing_field_before
                        and missing_field_before != "_approved"
                        and missing_field_before in proposed
                    ):
                        # Recorded with fix_type="param_map" (not "llm_repair")
                        # on purpose — Phase 3's own memory.lookup_fix only
                        # auto-applies "param_map" fixes, so the NEXT time
                        # this exact gap occurs it's applied for free,
                        # skipping the LLM call entirely. created_by_llm=True
                        # keeps the origin visible for anyone inspecting the
                        # table.
                        await memory.record_fix(
                            app, action, missing_field_before,
                            fix_type="param_map",
                            fix_payload={"parameter_key": missing_field_before, "value": proposed[missing_field_before]},
                            created_by_llm=True,
                        )

    # Phase 7 — record this step's ultimate outcome against the (app,
    # action) circuit breaker (success resets it; a tracked failure class
    # nudges it toward opening), and — if the breaker was ALREADY open when
    # this call started and it's still failing — annotate the human-facing
    # text so the Action Center/Studio pause explains *why* self-healing
    # didn't even try, rather than looking identical to an ordinary pause.
    if app and action:
        outcome_failure_class = classify_failure(result_data, last_exception, route=route)
        circuit_breaker.record_result(app, action, outcome_failure_class)
        if breaker_open and outcome_failure_class is not None:
            warning = (
                f"⚠️ {app}'s '{action}' has failed repeatedly across recent runs, so self-healing "
                f"has been paused for it for a while — this looks like a broken integration rather than "
                f"something answering here will fix. "
            )
            if result_data.get("question"):
                result_data["question"] = warning + result_data["question"]
            elif result_data.get("error"):
                result_data["error"] = warning + result_data["error"]

    return result_data, last_exception
