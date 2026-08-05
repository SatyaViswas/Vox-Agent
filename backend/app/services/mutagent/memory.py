"""MutAgent Phase 3 — mutation_memory persistence: learned fixes keyed by
(app, action, failure_signature). Backed by the `mutation_memory` table
created in the Phase 0 migration.

Every operation here is best-effort: a missing table, an unreachable
Supabase, or any other failure degrades to "no memory available" rather
than breaking the run — this is a self-healing convenience layer, not a
source of truth anything else depends on. Matches the rest of this
codebase's own convention of calling the (synchronous) supabase-py client
directly from inside async functions rather than wrapping it in a thread.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.database import supabase

logger = logging.getLogger(__name__)

_TABLE = "mutation_memory"


async def lookup_fix(app: str, action: str, failure_signature: str) -> Optional[dict[str, Any]]:
    """Returns {"fix_type", "fix_payload", "success_count"} for this exact
    (app, action, failure_signature) if something's been learned before,
    else None."""
    if not supabase or not app or not action or not failure_signature:
        return None
    try:
        response = (
            supabase.table(_TABLE)
            .select("fix_type, fix_payload, success_count")
            .eq("app", app)
            .eq("action", action)
            .eq("failure_signature", failure_signature)
            .limit(1)
            .execute()
        )
        rows = response.data or []
        return rows[0] if rows else None
    except Exception as e:
        logger.warning("mutation_memory lookup failed (continuing without it): %s", e)
        return None


async def record_fix(
    app: str,
    action: str,
    failure_signature: str,
    *,
    fix_type: str,
    fix_payload: dict[str, Any],
    created_by_llm: bool = False,
) -> None:
    """Upserts a learned fix — increments success_count if this exact
    signature was already recorded, otherwise inserts a new row. Failures
    are logged, not raised: the run that produced this fix already
    finished, so a failed memory write shouldn't retroactively fail it."""
    if not supabase or not app or not action or not failure_signature:
        return
    try:
        existing = (
            supabase.table(_TABLE)
            .select("id, success_count")
            .eq("app", app)
            .eq("action", action)
            .eq("failure_signature", failure_signature)
            .limit(1)
            .execute()
        )
        rows = existing.data or []
        now = datetime.now(timezone.utc).isoformat()
        if rows:
            supabase.table(_TABLE).update(
                {
                    "fix_type": fix_type,
                    "fix_payload": fix_payload,
                    "success_count": rows[0]["success_count"] + 1,
                    "last_used_at": now,
                }
            ).eq("id", rows[0]["id"]).execute()
        else:
            supabase.table(_TABLE).insert(
                {
                    "app": app,
                    "action": action,
                    "failure_signature": failure_signature,
                    "fix_type": fix_type,
                    "fix_payload": fix_payload,
                    "success_count": 1,
                    "created_by_llm": created_by_llm,
                    "last_used_at": now,
                }
            ).execute()
    except Exception as e:
        logger.warning("mutation_memory record failed (fix was still applied this run): %s", e)
