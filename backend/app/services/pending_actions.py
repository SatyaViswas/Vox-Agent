"""Persisted human-in-the-loop pause/resume state — the `pending_actions`
table, replacing orchestrator's old in-memory-only `_paused_runs` dict.

That dict was explicitly documented as "deliberately not persisted" — a
server restart silently dropped every in-flight pause with no way to
recover it, `/paused` returned every user's pending items with no
per-user scoping, and two concurrent runs of the same agent could clobber
each other's pause since it was keyed only by agent_id. This module fixes
all three: real persistence, `user_id`-scoped reads, and a DB-level unique
constraint (`idx_pending_actions_one_open_per_agent`, from the Phase 0
migration) that only allows one open ("pending") row per agent at a time.

All operations are synchronous (matching this codebase's existing
convention of calling the supabase-py client directly, not via an async
wrapper) and best-effort on read; a missing table degrades to "nothing
pending" rather than crashing a run.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.database import supabase

logger = logging.getLogger(__name__)
_TABLE = "pending_actions"


def _parse_json_column(value: Any) -> Any:
    # supabase-py normally hands back jsonb columns already parsed into
    # Python dicts/lists, but other jsonb reads in this codebase (see
    # orchestrator._load_agent_blueprint) defensively handle the string
    # case too — matching that same convention here.
    if isinstance(value, str):
        import json

        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def create_pending_action(
    *,
    run_id: Optional[str],
    agent_id: str,
    user_id: str,
    step_number: Optional[int],
    question: str,
    context_snapshot: dict[str, Any],
    input_type: str = "text",
    options: Optional[list] = None,
) -> Optional[dict]:
    """Inserts a new pending action. Returns the inserted row, or None if
    it couldn't be created — most likely because one is already pending
    for this agent (the DB's unique partial index rejects the insert),
    which means a concurrent run raced this one; the earlier pause stays
    authoritative and this run's pause attempt is simply logged and
    dropped rather than crashing the run."""
    if not supabase:
        return None
    try:
        response = (
            supabase.table(_TABLE)
            .insert(
                {
                    "run_id": run_id,
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "step_number": step_number,
                    "question": question,
                    "input_type": input_type,
                    "options": options,
                    "context_snapshot": context_snapshot,
                    "status": "pending",
                }
            )
            .execute()
        )
        return response.data[0] if response.data else None
    except Exception as e:
        logger.warning(
            "Could not create pending_action for agent %s (likely one is already pending — a concurrent "
            "run raced this pause): %s",
            agent_id,
            e,
        )
        return None


def get_pending_action(agent_id: str) -> Optional[dict]:
    """The single 'pending' row for this agent, if any, with
    context_snapshot already parsed back into a dict."""
    if not supabase:
        return None
    try:
        response = (
            supabase.table(_TABLE)
            .select("*")
            .eq("agent_id", agent_id)
            .eq("status", "pending")
            .limit(1)
            .execute()
        )
        rows = response.data or []
        if not rows:
            return None
        row = rows[0]
        row["context_snapshot"] = _parse_json_column(row.get("context_snapshot"))
        return row
    except Exception as e:
        logger.warning("Failed to look up pending_action for agent %s: %s", agent_id, e)
        return None


def has_pending_action(agent_id: str) -> bool:
    return get_pending_action(agent_id) is not None


def list_pending_actions(user_id: Optional[str] = None) -> list[dict]:
    """All currently-pending actions, optionally scoped to one user — the
    backing query for GET /paused."""
    if not supabase:
        return []
    try:
        query = supabase.table(_TABLE).select("*").eq("status", "pending")
        if user_id:
            query = query.eq("user_id", user_id)
        response = query.execute()
        rows = response.data or []
        for row in rows:
            row["context_snapshot"] = _parse_json_column(row.get("context_snapshot"))
        return rows
    except Exception as e:
        logger.warning("Failed to list pending_actions: %s", e)
        return []


def get_by_id(pending_id: str) -> Optional[dict]:
    if not supabase:
        return None
    try:
        response = supabase.table(_TABLE).select("*").eq("id", pending_id).limit(1).execute()
        rows = response.data or []
        if not rows:
            return None
        row = rows[0]
        row["context_snapshot"] = _parse_json_column(row.get("context_snapshot"))
        return row
    except Exception as e:
        logger.warning("Failed to look up pending_action %s: %s", pending_id, e)
        return None


def resolve_pending_action(pending_id: str, *, answer: str) -> None:
    """Marks a pending action resolved. Best-effort: a failed write here
    doesn't undo the run continuing past it — the run itself already
    consumed the answer by the time this is called."""
    if not supabase:
        return
    try:
        supabase.table(_TABLE).update(
            {
                "status": "resolved",
                "resolved_answer": answer,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", pending_id).execute()
    except Exception as e:
        logger.warning("Failed to mark pending_action %s resolved: %s", pending_id, e)
