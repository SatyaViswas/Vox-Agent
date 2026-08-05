"""MutAgent Phase 7 — per-(app, action) circuit breaker.

If the same integration keeps failing across different runs even after
mutation, mark it "open" and skip the whole mutation pipeline (retry,
mutation_memory, selector, LLM repair) for a cooldown window instead of
re-attempting it on every single run — this is what stops a systemically
broken integration (the app's API is down, a permanently changed schema)
from burning LLM calls and retry latency run after run, escalating
straight to a human instead.

Failures that aren't really "this integration is broken" — an expired
token, a permission problem, genuine ambiguity — don't count toward this;
those already have their own clear, distinct resolution paths and
repeating them isn't evidence of a broken integration.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.config import settings
from app.database import supabase
from app.services.mutagent.classifier import FailureClass

logger = logging.getLogger(__name__)
_TABLE = "circuit_breakers"

_COUNTS_TOWARD_BREAKER = (
    FailureClass.TRANSIENT,
    FailureClass.RATE_LIMIT,
    FailureClass.SCHEMA_MISMATCH,
    FailureClass.ROUTE_MISMATCH,
    FailureClass.SELECTOR_DRIFT,
    FailureClass.UNKNOWN,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_state(app: str, action: str) -> Optional[dict]:
    if not supabase or not app or not action:
        return None
    try:
        response = supabase.table(_TABLE).select("*").eq("app", app).eq("action", action).limit(1).execute()
        rows = response.data or []
        return rows[0] if rows else None
    except Exception as e:
        logger.warning("circuit_breaker lookup failed for %s.%s: %s", app, action, e)
        return None


def is_open(app: str, action: str) -> bool:
    """True only while the breaker is open AND still within its cooldown
    window — once cooldown passes, it's treated as closed again (a
    "let's try once more" half-open state) even though the row itself
    isn't reset until the next success/failure explicitly updates it."""
    state = get_state(app, action)
    if not state or state.get("status") != "open":
        return False
    cooldown_until = state.get("cooldown_until")
    if not cooldown_until:
        return False
    try:
        deadline = datetime.fromisoformat(str(cooldown_until).replace("Z", "+00:00"))
    except Exception:
        return False
    return datetime.now(timezone.utc) < deadline


def record_result(app: str, action: str, failure_class: Optional[FailureClass]) -> None:
    """Called once per step, after the mutation pipeline is fully
    exhausted, with the FINAL failure_class (None means it ultimately
    succeeded). Best-effort — a failed write here just means the breaker
    doesn't update this one time, not that the run itself fails."""
    if not supabase or not app or not action:
        return
    try:
        if failure_class is None or failure_class not in _COUNTS_TOWARD_BREAKER:
            existing = get_state(app, action)
            if existing and existing.get("consecutive_failures", 0) > 0:
                supabase.table(_TABLE).update(
                    {
                        "consecutive_failures": 0,
                        "status": "closed",
                        "opened_at": None,
                        "cooldown_until": None,
                        "updated_at": _now(),
                    }
                ).eq("id", existing["id"]).execute()
            return

        existing = get_state(app, action)
        count = (existing.get("consecutive_failures", 0) if existing else 0) + 1
        payload = {
            "app": app,
            "action": action,
            "consecutive_failures": count,
            "last_failure_at": _now(),
            "updated_at": _now(),
        }
        if count >= settings.MUTAGENT_CIRCUIT_BREAKER_THRESHOLD:
            payload["status"] = "open"
            payload["opened_at"] = _now()
            payload["cooldown_until"] = (
                datetime.now(timezone.utc) + timedelta(minutes=settings.MUTAGENT_CIRCUIT_BREAKER_COOLDOWN_MINUTES)
            ).isoformat()

        if existing:
            supabase.table(_TABLE).update(payload).eq("id", existing["id"]).execute()
        else:
            supabase.table(_TABLE).insert(payload).execute()
    except Exception as e:
        logger.warning("circuit_breaker record failed for %s.%s: %s", app, action, e)
