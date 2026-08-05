"""Typed failure classification for MutAgent.

This module does not change any existing behavior — it *wraps* the ad hoc
heuristics already scattered across composio_engine.py (auth vs. permission
error detection) and orchestrator.py (clarification-question detection,
needs_input shape) into one FailureClass enum, so that later mutation logic
has a single signal to branch on instead of re-deriving these checks per
engine. Phase 1 only attaches this as an additional `failure_class` field on
the existing result-dict shape; nothing downstream reads it yet.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Optional

from app.services.composio_engine import (
    _looks_like_api_key_permission_error,
    _looks_like_auth_error,
)

# Duplicated from orchestrator._CLARIFICATION_HINTS/_looks_like_clarification_request
# rather than imported, to avoid a circular import (orchestrator already
# imports this module). Keep in sync if that list changes — it's what lets
# classify_failure recognize a browser_agent step that came back "successful"
# but is actually a confused clarifying question (e.g. "which platform did
# you mean?"), which orchestrator.py only detects itself *after*
# execute_with_mutation has already returned, too late for SelectorMutator
# to ever see it otherwise.
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


def _looks_like_clarification_text(text: Any) -> bool:
    if not isinstance(text, str):
        return False
    stripped = text.strip()
    if not stripped:
        return False
    if stripped.endswith("?"):
        return True
    lowered = stripped.lower()
    return any(hint in lowered for hint in _CLARIFICATION_HINTS)


def _extract_text_value(result_data: dict) -> Any:
    # Mirrors orchestrator._extract_result_value's exact key priority — each
    # engine uses a different key for its payload (browser_agent -> "result",
    # composio_api -> "output", http_webhook -> "data", ai_generate/others ->
    # "message"). Duplicated rather than imported for the same circular-import
    # reason as _looks_like_clarification_text above.
    for key in ("result", "output", "data", "message"):
        if key in result_data:
            return result_data[key]
    return None


class FailureClass(str, Enum):
    TRANSIENT = "transient"
    RATE_LIMIT = "rate_limit"
    AUTH_EXPIRED = "auth_expired"
    PERMISSION_DENIED = "permission_denied"
    SCHEMA_MISMATCH = "schema_mismatch"
    SELECTOR_DRIFT = "selector_drift"
    ROUTE_MISMATCH = "route_mismatch"
    AMBIGUOUS_INTENT = "ambiguous_intent"
    UNKNOWN = "unknown"


_TRANSIENT_HINTS = re.compile(
    r"(timeout|timed out|connection (reset|refused|aborted|error|attempts failed)|"
    r"temporarily unavailable|service unavailable|bad gateway|gateway timeout|"
    r"network error|econnreset|etimedout|read timed out|"
    r"could not connect|failed to establish a new connection|"
    r"max retries exceeded|name or service not known|nodename nor servname)",
    re.IGNORECASE,
)

_RATE_LIMIT_HINTS = re.compile(r"(rate limit|too many requests|\b429\b)", re.IGNORECASE)


def _status_code_of(result_data: dict, exception: Optional[Exception]) -> Optional[int]:
    """Best-effort extraction of an HTTP status code from either the
    result dict (http_engine sets `response_code`) or the raised exception
    (Composio's SDK exceptions expose `.status_code`)."""
    for key in ("response_code", "status_code"):
        raw = result_data.get(key)
        if raw is not None:
            try:
                return int(raw)
            except (TypeError, ValueError):
                pass
    if exception is not None:
        raw = getattr(exception, "status_code", None)
        if raw is None:
            response = getattr(exception, "response", None)
            raw = getattr(response, "status_code", None)
        if raw is not None:
            try:
                return int(raw)
            except (TypeError, ValueError):
                pass
    return None


def classify_failure(
    result_data: Optional[dict[str, Any]],
    exception: Optional[Exception] = None,
    *,
    route: Optional[str] = None,
) -> Optional[FailureClass]:
    """Classifies a step's outcome. Returns None for a successful result;
    otherwise the best-guess FailureClass. `result_data` is the same dict
    shape every engine already returns (`{"status": ..., "error"/"question"/
    "reconnect_app"/"missing_field": ...}`); `exception` is the raw exception
    if one was caught (composio_engine's own heuristics work equally well on
    a plain error string, since they only ever call `str()` on it)."""
    result_data = result_data or {}
    status = result_data.get("status")

    if status is None:
        return None

    if status == "success":
        # A "successful" result can actually be a confused clarifying
        # question instead of completed work (most commonly from
        # browser_agent, e.g. "which platform did you mean?", but any
        # route's extracted text can match) — orchestrator.py only detects
        # this itself *after* the mutation controller has already
        # returned (see its own _looks_like_clarification_request), so
        # without this check here, classify_failure would return None for
        # a case orchestrator.py is about to treat as needing input, and
        # `.value` on that None crashes orchestrator's own unconditional
        # `classify_failure(...).value` call at its needs_input return
        # point. browser_agent gets the more specific SELECTOR_DRIFT (so
        # SelectorMutator can act on it); every other route gets
        # AMBIGUOUS_INTENT (straight to a human, same as orchestrator's
        # existing behavior, no mutator currently attempts these).
        if _looks_like_clarification_text(_extract_text_value(result_data)):
            return FailureClass.SELECTOR_DRIFT if route == "browser_agent" else FailureClass.AMBIGUOUS_INTENT
        return None

    if status == "needs_input":
        if result_data.get("reconnect_app"):
            return FailureClass.AUTH_EXPIRED
        missing_field = result_data.get("missing_field")
        if missing_field and missing_field != "_approved":
            return FailureClass.SCHEMA_MISMATCH
        # Covers both the sensitive-action human-approval gate
        # (missing_field == "_approved") and a genuine clarifying question
        # (e.g. browser_agent asking "which platform did you mean?") — both
        # need a real human decision, not a mutation attempt.
        return FailureClass.AMBIGUOUS_INTENT

    # status == "error" (or any other non-success value) from here on.
    error_source: Any = exception if exception is not None else (
        result_data.get("error") or result_data.get("message")
    )

    if error_source is not None:
        if _looks_like_api_key_permission_error(error_source):
            return FailureClass.PERMISSION_DENIED
        if _looks_like_auth_error(error_source):
            return FailureClass.AUTH_EXPIRED

    error_text = str(error_source) if error_source is not None else ""

    code = _status_code_of(result_data, exception)
    if code == 429 or _RATE_LIMIT_HINTS.search(error_text):
        return FailureClass.RATE_LIMIT
    if code is not None and 500 <= code < 600:
        return FailureClass.TRANSIENT
    if code == 404:
        return FailureClass.ROUTE_MISMATCH
    if _TRANSIENT_HINTS.search(error_text):
        return FailureClass.TRANSIENT

    if route == "browser_agent":
        return FailureClass.SELECTOR_DRIFT

    return FailureClass.UNKNOWN
