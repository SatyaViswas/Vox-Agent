import asyncio
import json
import logging
import traceback
from fastapi import APIRouter, HTTPException, Header, Query, BackgroundTasks, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Dict, Any, Optional, Literal
from app.services.orchestrator import run_agent_workflow, resume_agent_workflow, reject_paused_run, has_paused_run
from app.services import pending_actions
from app.services.telemetry import telemetry_manager
from app.services.composio_engine import generate_sample_trigger_payload
from app.services import trigger_engine, telegram_client_engine
from app.services.telegram_client_engine import TELEGRAM_PERSONAL_APP_NAME, TELEGRAM_BOT_APP_NAME
from app.services.scheduler import add_or_update_job, remove_job
from app.database import supabase

router = APIRouter(tags=["execution"])

@router.get("/paused")
async def get_paused_runs(x_user_id: Optional[str] = Header(default=None)):
    # Scoped to the requesting user (via the X-User-Id header the frontend's
    # api client already sends on every request) — previously this returned
    # every user's pending items with no filtering at all. Omitting the
    # header still lists everything, matching the old behavior for any
    # caller that doesn't send it (e.g. a script/curl).
    rows = pending_actions.list_pending_actions(user_id=x_user_id)
    return {
        "status": "success",
        "paused_runs": {
            row["agent_id"]: {
                "id": row["id"],
                "question": row["question"],
                "input_type": row.get("input_type"),
                "reconnect_app": (row.get("context_snapshot") or {}).get("reconnect_app"),
                "missing_field": (row.get("context_snapshot") or {}).get("missing_field"),
                "agent_id": row["agent_id"],
            }
            for row in rows
        }
    }

logger = logging.getLogger(__name__)

TriggerType = Literal["on_demand", "scheduled", "event_trigger"]

# _slugify_app("Telegram Personal Account") — the trigger.event_app value
# planner.py uses for "my telegram"/"saved messages" style automations,
# which listen via telegram_client_engine (a real logged-in account) instead
# of trigger_engine (Composio's push-based triggers, which the bot-based
# Telegram integration would use if Composio ever adds a trigger for it).
TELEGRAM_PERSONAL_SLUG = "".join(ch for ch in TELEGRAM_PERSONAL_APP_NAME.lower() if ch.isalnum())
TELEGRAM_BOT_SLUG = "".join(ch for ch in TELEGRAM_BOT_APP_NAME.lower() if ch.isalnum())

def _to_public_agent(row: Dict[str, Any]) -> Dict[str, Any]:
    """The agents table stores an `is_active` boolean, but the frontend's
    public API contract uses a `status: "active" | "paused"` string
    (matching the shape it already renders). Translate on the way out so the
    contract stays stable regardless of the underlying column."""
    row = dict(row)
    if "is_active" in row:
        row["status"] = "active" if row.pop("is_active") else "paused"
    return row


def _event_trigger_target(blueprint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Pulls the (app, target) an event_trigger agent should listen on out
    of its blueprint's trigger spec, per planner.py Rule 4."""
    trigger = (blueprint or {}).get("trigger") or {}
    event_app = trigger.get("event_app")
    if not event_app:
        return None
    return {"app": event_app, "target": trigger.get("event_target")}


def _slugify_app(app: str) -> str:
    return "".join(ch for ch in (app or "").lower() if ch.isalnum())


async def arm_event_trigger(agent_id: str, user_id: str, blueprint: Dict[str, Any]) -> None:
    """Best-effort: starts the live listener for an event_trigger agent —
    either Composio's push-based trigger (trigger_engine) or, for a personal
    Telegram account automation, a real logged-in Telethon client
    (telegram_client_engine). Failures are logged to telemetry rather than
    raised — a missing permission or an unconnected app shouldn't block
    toggling the agent's status, it should just explain why listening isn't
    live yet."""
    target = _event_trigger_target(blueprint)
    if not target:
        await telemetry_manager.send_log(
            agent_id,
            "Can't start listening — this agent's blueprint has no trigger.event_app to watch.",
            level="error",
        )
        return

    slug = _slugify_app(target["app"])
    intent_description = (blueprint.get("trigger") or {}).get("details")
    try:
        if slug in (TELEGRAM_PERSONAL_SLUG, TELEGRAM_BOT_SLUG):
            await telegram_client_engine.start_event_trigger(agent_id, user_id, target.get("target"), app_name=target["app"])
        else:
            loop = asyncio.get_running_loop()
            
            # The blueprint may have already populated trigger_config (e.g., via missing_parameters in the UI)
            blueprint_trigger_config = blueprint.get("trigger", {}).get("trigger_config") or {}
            trigger_config = {**blueprint_trigger_config} if blueprint_trigger_config else None
            
            if target.get("app") == "Google Sheets" and target.get("target"):
                if trigger_config is None:
                    trigger_config = {}
                trigger_config["spreadsheet_id"] = target["target"]
                
                from app.services.composio_engine import composio, resolve_connected_user_id, _find_search_tool, _search_tool_query_param, _extract_named_id
                entity_id = resolve_connected_user_id(user_id, "Google Sheets")
                search_tool = _find_search_tool("googlesheets")
                if search_tool:
                    query_param = _search_tool_query_param(search_tool)
                    try:
                        from app.services.composio_engine import _execute_composio_with_timeout
                        result = await _execute_composio_with_timeout(
                            slug=search_tool.slug,
                            arguments={query_param: target["target"]} if query_param else {},
                            user_id=entity_id,
                            dangerously_skip_version_check=True,
                        )
                        s_id = _extract_named_id(result, target["target"])
                        if s_id:
                            trigger_config["spreadsheet_id"] = s_id
                    except Exception as ex:
                        print(f"Warning: Auto-resolve for spreadsheet_id failed: {ex}")

            trigger_engine.start_event_trigger(
                agent_id, user_id, slug, loop,
                trigger_config=trigger_config,
                event_target=target.get("target"),
                intent_description=intent_description,
            )
            trigger_engine.clear_last_error(agent_id)
        await telemetry_manager.send_log(agent_id, f"Listening for {target['app']} events (live, no polling).", level="success")
    except Exception as e:
        traceback.print_exc()
        reason = str(e)
        if slug in (TELEGRAM_PERSONAL_SLUG, TELEGRAM_BOT_SLUG):
            telegram_client_engine.set_last_error(agent_id, reason)
        else:
            trigger_engine.set_last_error(agent_id, reason)
        await telemetry_manager.send_log(agent_id, f"Failed to start listening for {target['app']} events: {reason}", level="error")


class AgentCreateRequest(BaseModel):
    title: str
    original_prompt: str
    json_blueprint: Dict[str, Any]
    trigger_type: TriggerType
    cron_schedule: Optional[str] = None
    user_id: Optional[str] = "00000000-0000-0000-0000-000000000000"

@router.post("/agents")
async def create_agent(request: AgentCreateRequest):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    payload = request.model_dump()
    try:
        response = supabase.table("agents").insert(payload).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create agent")
        agent_id = response.data[0]["id"]

        if request.trigger_type == "event_trigger":
            await arm_event_trigger(agent_id, request.user_id, request.json_blueprint)
        elif request.trigger_type == "scheduled" and request.cron_schedule:
            add_or_update_job(agent_id, request.user_id, request.cron_schedule)

        return {"status": "success", "agent_id": agent_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/agents")
async def get_agents(user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        response = supabase.table("agents").select("*").eq("user_id", user_id).execute()
        return {"status": "success", "agents": [_to_public_agent(a) for a in response.data]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/execute/{agent_id}")
async def execute_agent(agent_id: str, background_tasks: BackgroundTasks, user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    trigger_result = None
    trigger_chat_id = None
    trigger_data = None
    if supabase:
        try:
            row = supabase.table("agents").select("trigger_type, json_blueprint").eq("id", agent_id).execute()
            if row.data and row.data[0].get("trigger_type") == "event_trigger":
                # There's no real captured event for a manual test run — an
                # event-triggered agent's reaction steps expect real-looking
                # content (a subject/sender/body to extract from), not just
                # a bare placeholder string, so this synthesizes a realistic
                # sample event matching the agent's own watched condition
                # and reaction steps (see generate_sample_trigger_payload)
                # instead of one that would fail whatever the real steps
                # try to extract. This is also the way to confirm an
                # event-triggered agent's wiring actually works without
                # waiting on a real external event to happen.
                blueprint = row.data[0].get("json_blueprint") or {}
                if isinstance(blueprint, str):
                    try:
                        blueprint = json.loads(blueprint)
                    except Exception:
                        blueprint = {}
                sample = generate_sample_trigger_payload(blueprint)
                trigger_result = sample["message_text"]
                trigger_chat_id = sample["sender"]
                trigger_data = sample["payload_data"]
        except Exception:
            traceback.print_exc()

    background_tasks.add_task(run_agent_workflow, agent_id, user_id, trigger_result, trigger_chat_id, trigger_data)
    return {"status": "started", "agent_id": agent_id, "message": "Agent execution triggered in background"}


@router.get("/agents/{agent_id}/trigger-status")
async def get_trigger_status(agent_id: str):
    """Whether this event_trigger agent's live listener is actually
    registered right now, across either engine (Composio's push-based
    triggers, or a personal Telegram account's Telethon client) — lets the
    UI show real state instead of just reflecting the is_active flag (which
    can be true while the listener itself failed to start). When not
    listening, `reason` carries why instead of leaving the UI to guess."""
    listening = trigger_engine.is_agent_active(agent_id) or telegram_client_engine.is_agent_active(agent_id)
    reason = None if listening else (trigger_engine.get_last_error(agent_id) or telegram_client_engine.get_last_error(agent_id))
    return {"status": "success", "listening": listening, "reason": reason}


class ResumeRequest(BaseModel):
    answer: str

@router.post("/agents/{agent_id}/resume")
async def resume_agent(agent_id: str, request: ResumeRequest, background_tasks: BackgroundTasks):
    if not has_paused_run(agent_id):
        raise HTTPException(status_code=404, detail="No paused run found for this agent.")
    background_tasks.add_task(resume_agent_workflow, agent_id, request.answer)
    return {"status": "started", "agent_id": agent_id, "message": "Resuming with clarification"}


class RejectRequest(BaseModel):
    reason: Optional[str] = "Rejected by user"

@router.post("/pending-actions/{pending_id}/approve")
async def approve_pending_action(pending_id: str, background_tasks: BackgroundTasks):
    """Distinct from the generic /resume — restricted to the sensitive-action
    approval gate ("confirm" input_type) so approving/rejecting is a typed
    action rather than a magic answer string piped through the same
    free-text path (see MutAgent plan Part 3.2)."""
    pending = pending_actions.get_by_id(pending_id)
    if not pending or pending.get("status") != "pending":
        raise HTTPException(status_code=404, detail="No pending action with that id.")
    if pending.get("input_type") != "confirm":
        raise HTTPException(status_code=400, detail="This pending action isn't an approval gate — use /resume instead.")
    background_tasks.add_task(resume_agent_workflow, pending["agent_id"], "Approved")
    return {"status": "started", "agent_id": pending["agent_id"], "message": "Approved — resuming"}

@router.post("/pending-actions/{pending_id}/reject")
async def reject_pending_action(pending_id: str, request: RejectRequest, background_tasks: BackgroundTasks):
    pending = pending_actions.get_by_id(pending_id)
    if not pending or pending.get("status") != "pending":
        raise HTTPException(status_code=404, detail="No pending action with that id.")
    background_tasks.add_task(reject_paused_run, pending["agent_id"], request.reason)
    return {"status": "started", "agent_id": pending["agent_id"], "message": "Rejected"}


class ScheduleUpdateRequest(BaseModel):
    trigger_type: TriggerType
    cron_schedule: Optional[str] = None
    status: Literal["active", "paused"]

@router.patch("/agents/{agent_id}/schedule")
async def update_agent_schedule(agent_id: str, request: ScheduleUpdateRequest):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        payload = {
            "trigger_type": request.trigger_type,
            "cron_schedule": request.cron_schedule,
            "is_active": request.status == "active",
        }
        response = supabase.table("agents").update(payload).eq("id", agent_id).execute()

        if not response.data:
            raise HTTPException(status_code=404, detail="Agent not found")

        updated = response.data[0]
        if request.trigger_type == "event_trigger":
            if request.status == "active":
                await arm_event_trigger(agent_id, updated.get("user_id"), updated.get("json_blueprint") or {})
            else:
                trigger_engine.stop_event_trigger(agent_id)
                trigger_engine.clear_last_error(agent_id)
                telegram_client_engine.stop_event_trigger(agent_id)
                telegram_client_engine.clear_last_error(agent_id)
                await telemetry_manager.send_log(agent_id, "Stopped listening for events.", level="info")
        elif request.trigger_type == "scheduled":
            if request.status == "active" and request.cron_schedule:
                add_or_update_job(agent_id, updated.get("user_id"), request.cron_schedule)
            else:
                remove_job(agent_id)
        else:
            remove_job(agent_id)

        return {"status": "success", "message": "Schedule updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class AgentUpdateRequest(BaseModel):
    title: Optional[str] = None
    original_prompt: Optional[str] = None
    json_blueprint: Optional[Dict[str, Any]] = None
    trigger_type: Optional[TriggerType] = None
    cron_schedule: Optional[str] = None
    status: Optional[Literal["active", "paused"]] = None

@router.put("/agents/{agent_id}")
async def update_agent(agent_id: str, request: AgentUpdateRequest):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    payload = request.model_dump(exclude_unset=True)
    if "status" in payload:
        payload["is_active"] = payload.pop("status") == "active"
    if not payload:
        raise HTTPException(status_code=400, detail="No fields provided to update")

    try:
        trigger_engine.stop_event_trigger(agent_id)
        telegram_client_engine.stop_event_trigger(agent_id)
        response = supabase.table("agents").update(payload).eq("id", agent_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Agent not found")
            
        updated = response.data[0]
        is_active = updated.get("is_active")
        trigger_type = updated.get("trigger_type")
        
        if trigger_type == "scheduled":
            if is_active and updated.get("cron_schedule"):
                add_or_update_job(agent_id, updated.get("user_id"), updated.get("cron_schedule"))
            else:
                remove_job(agent_id)
        elif trigger_type == "event_trigger":
            remove_job(agent_id)
            if is_active:
                await arm_event_trigger(agent_id, updated.get("user_id"), updated.get("json_blueprint"))
        else:
            remove_job(agent_id)

        return {"status": "success", "agent": _to_public_agent(updated)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        trigger_engine.stop_event_trigger(agent_id)
        telegram_client_engine.stop_event_trigger(agent_id)
        remove_job(agent_id)
        response = supabase.table("agents").delete().eq("id", agent_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        return {"status": "success", "message": "Agent deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/agents/{agent_id}/logs")
async def get_agent_logs(agent_id: str, limit: int = Query(10, le=50), offset: int = Query(0, ge=0)):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        response = supabase.table("execution_logs") \
            .select("id, agent_id, status, log_messages, proof_screenshot_url, executed_at", count="exact") \
            .eq("agent_id", agent_id) \
            .order("executed_at", desc=True) \
            .range(offset, offset + limit - 1) \
            .execute()
        total = response.count if response.count is not None else len(response.data)
        return {
            "status": "success",
            "logs": response.data,
            "total": total,
            "has_more": offset + len(response.data) < total,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.websocket("/ws/telemetry/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await telemetry_manager.connect(websocket, client_id)
    try:
        while True:
            # Keep the connection open and listen for client messages if any
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        # Any other transport-level failure (reset connection, bad frame,
        # etc.) should still clean up the connection instead of leaving a
        # dead socket registered against this agent's telemetry stream.
        logging.getLogger(__name__).warning(f"Telemetry websocket for {client_id} closed unexpectedly: {e}")
    finally:
        telemetry_manager.disconnect(websocket, client_id)
