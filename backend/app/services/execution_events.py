import collections
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from app.database import supabase
from app.services.telemetry import telemetry_manager

logger = logging.getLogger(__name__)

# Sliding in-memory buffer for recent execution events (max 200 events)
_recent_events: collections.deque = collections.deque(maxlen=200)
_seen_event_ids: set = set()
_SERVER_BOOT_TIME_MS: int = int(time.time() * 1000)


def _is_valid_uuid(val: Any) -> bool:
    try:
        uuid.UUID(str(val))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def record_trigger_started(
    agent_id: str,
    user_id: str,
    trigger_type: str,
    agent_title: str,
    run_id: str,
) -> Dict[str, Any]:
    """Records an event indicating that a scheduled or event-triggered workflow has begun executing in the background."""
    now_ms = int(time.time() * 1000)
    event_id = f"evt_{run_id}_started"

    if event_id in _seen_event_ids:
        return {}

    title = agent_title or "Workflow"
    if trigger_type == "scheduled":
        message = f'Scheduled run triggered for "{title}" in background.'
        spoken = f"Notification: Scheduled workflow {title} has started in the background."
    elif trigger_type == "event_trigger":
        message = f'Trigger event detected for "{title}". Running workflow in background...'
        spoken = f"Notification: Event detected for {title}. Running workflow."
    else:
        message = f'Workflow "{title}" started running.'
        spoken = f"Notification: Workflow {title} has started."

    event = {
        "id": event_id,
        "run_id": run_id,
        "agent_id": agent_id,
        "user_id": user_id or "00000000-0000-0000-0000-000000000000",
        "agent_title": title,
        "trigger_type": trigger_type,
        "event_type": "trigger_started",
        "status": "info",
        "message": message,
        "spoken_message": spoken,
        "skipped_steps": [],
        "timestamp": now_ms,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dedup_key": f"run_{agent_id}_{run_id}_started",
    }

    _recent_events.append(event)
    _seen_event_ids.add(event_id)

    # Broadcast to telemetry manager
    try:
        import asyncio
        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        if loop and loop.is_running():
            asyncio.create_task(
                telemetry_manager.send_log(
                    agent_id,
                    message,
                    level="info",
                    data={"type": "trigger_started", "event": event},
                )
            )
    except Exception as e:
        logger.debug(f"Telemetry broadcast skipped: {e}")

    return event


def record_execution_completed(
    agent_id: str,
    user_id: str,
    trigger_type: str,
    outcome: str,
    step_logs: list,
    agent_title: str,
    run_id: str,
    log_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Records an event indicating that a workflow execution has finished (success, failed, or needs_input)."""
    now_ms = int(time.time() * 1000)
    event_id = f"evt_{run_id}_{outcome}"

    title = agent_title or "Workflow"
    skipped_steps = [
        e["step"]
        for e in (step_logs or [])
        if isinstance(e, dict)
        and (e.get("result") or {}).get("status") == "skipped"
        and e.get("step") is not None
    ]

    prefix = (
        "Scheduled workflow"
        if trigger_type == "scheduled"
        else ("Triggered workflow" if trigger_type == "event_trigger" else "Workflow")
    )

    if outcome == "success":
        if skipped_steps:
            skipped_str = ", ".join(str(s) for s in skipped_steps)
            message = f'{prefix} "{title}" completed with step {skipped_str} skipped.'
            spoken = f"Notification: {prefix} {title} completed. Step {skipped_str} was skipped as condition was not met."
        else:
            message = f'{prefix} "{title}" executed successfully!'
            spoken = f"Notification: {prefix} {title} completed successfully."
        status = "success"
    elif outcome == "needs_input":
        message = f'{prefix} "{title}" paused and requires your input.'
        spoken = f"Notification: {prefix} {title} requires your attention."
        status = "needs_input"
    else:
        message = f'{prefix} "{title}" encountered an error during execution.'
        spoken = f"Notification: {prefix} {title} failed."
        status = "failed"

    effective_id = log_id or run_id or str(int(time.time()))
    event = {
        "id": event_id,
        "run_id": run_id,
        "log_id": log_id,
        "agent_id": agent_id,
        "user_id": user_id or "00000000-0000-0000-0000-000000000000",
        "agent_title": title,
        "trigger_type": trigger_type,
        "event_type": "execution_completed",
        "status": status,
        "message": message,
        "spoken_message": spoken,
        "skipped_steps": skipped_steps,
        "timestamp": now_ms,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dedup_key": f"run_{agent_id}_{effective_id}",
    }

    _recent_events.append(event)
    _seen_event_ids.add(event_id)

    # Broadcast to telemetry manager
    try:
        import asyncio
        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        if loop and loop.is_running():
            asyncio.create_task(
                telemetry_manager.send_log(
                    agent_id,
                    message,
                    level=("success" if outcome == "success" else ("error" if outcome == "failed" else "needs_input")),
                    data={"type": "execution_completed", "event": event},
                )
            )
    except Exception as e:
        logger.debug(f"Telemetry broadcast skipped: {e}")

    return event


def get_recent_execution_events(
    user_id: Optional[str] = None,
    since_timestamp: Optional[float] = None,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """Returns recent execution events filtered by user and timestamp.
    Merges in-memory events with persisted database execution_logs."""
    effective_user_id = user_id if (user_id and user_id != "00000000-0000-0000-0000-000000000000") else None

    seen_dedup_keys = set()
    results = []

    # 1. Collect in-memory events
    for evt in reversed(_recent_events):
        if since_timestamp and evt.get("timestamp", 0) <= since_timestamp:
            continue
        if effective_user_id:
            evt_user = evt.get("user_id")
            if evt_user and evt_user != "00000000-0000-0000-0000-000000000000" and evt_user != effective_user_id:
                continue

        dedup_key = evt.get("dedup_key") or evt.get("id")
        if dedup_key not in seen_dedup_keys:
            seen_dedup_keys.add(dedup_key)
            results.append(evt)

    # 2. Backfill / enrich from Supabase execution_logs only when cold-starting or querying pre-boot history
    needs_db_backfill = since_timestamp is None or since_timestamp < _SERVER_BOOT_TIME_MS
    if needs_db_backfill and supabase and (effective_user_id is None or _is_valid_uuid(effective_user_id)):
        try:
            agents_query = supabase.table("agents").select("id, title, trigger_type, user_id")
            if effective_user_id:
                agents_query = agents_query.eq("user_id", effective_user_id)
            agent_rows = agents_query.execute().data or []
            agent_map = {a["id"]: a for a in agent_rows}

            if agent_map:
                logs_query = (
                    supabase.table("execution_logs")
                    .select("id, agent_id, run_id, status, log_messages, executed_at")
                    .in_("agent_id", list(agent_map.keys()))
                    .order("executed_at", desc=True)
                    .limit(limit)
                )
                log_rows = logs_query.execute().data or []
                for row in log_rows:
                    log_id = row.get("id")
                    agent_id = row.get("agent_id")
                    run_id = row.get("run_id") or log_id
                    dedup_key = f"run_{agent_id}_{log_id or run_id}"

                    if dedup_key in seen_dedup_keys:
                        continue

                    # Parse timestamp
                    try:
                        dt = datetime.fromisoformat(row["executed_at"].replace("Z", "+00:00"))
                        ts_ms = int(dt.timestamp() * 1000)
                    except Exception:
                        ts_ms = int(time.time() * 1000)

                    if since_timestamp and ts_ms <= since_timestamp:
                        continue

                    agent_info = agent_map.get(agent_id) or {}
                    agent_title = agent_info.get("title") or "Workflow"
                    trigger_type = agent_info.get("trigger_type") or "on_demand"
                    outcome = row.get("status") or "success"
                    step_logs = row.get("log_messages") or []

                    skipped_steps = [
                        e["step"]
                        for e in (step_logs or [])
                        if isinstance(e, dict)
                        and (e.get("result") or {}).get("status") == "skipped"
                        and e.get("step") is not None
                    ]

                    prefix = (
                        "Scheduled workflow"
                        if trigger_type == "scheduled"
                        else ("Triggered workflow" if trigger_type == "event_trigger" else "Workflow")
                    )

                    if outcome == "success":
                        if skipped_steps:
                            skipped_str = ", ".join(str(s) for s in skipped_steps)
                            message = f'{prefix} "{agent_title}" completed with step {skipped_str} skipped.'
                            spoken = f"Notification: {prefix} {agent_title} completed. Step {skipped_str} was skipped as condition was not met."
                        else:
                            message = f'{prefix} "{agent_title}" executed successfully!'
                            spoken = f"Notification: {prefix} {agent_title} completed successfully."
                        status = "success"
                    elif outcome == "needs_input":
                        message = f'{prefix} "{agent_title}" paused and requires your input.'
                        spoken = f"Notification: {prefix} {agent_title} requires your attention."
                        status = "needs_input"
                    else:
                        message = f'{prefix} "{agent_title}" encountered an error during execution.'
                        spoken = f"Notification: {prefix} {agent_title} failed."
                        status = "failed"

                    event = {
                        "id": f"evt_{run_id}_{outcome}",
                        "run_id": run_id,
                        "log_id": log_id,
                        "agent_id": agent_id,
                        "user_id": agent_info.get("user_id") or "00000000-0000-0000-0000-000000000000",
                        "agent_title": agent_title,
                        "trigger_type": trigger_type,
                        "event_type": "execution_completed",
                        "status": status,
                        "message": message,
                        "spoken_message": spoken,
                        "skipped_steps": skipped_steps,
                        "timestamp": ts_ms,
                        "created_at": row.get("executed_at"),
                        "dedup_key": dedup_key,
                    }
                    seen_dedup_keys.add(dedup_key)
                    results.append(event)
        except Exception as e:
            logger.error(f"Error querying execution logs for events: {e}")

    results.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    return results[:limit]
