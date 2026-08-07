import os
import sys
from pathlib import Path

# Explicitly prepend the project's local venv/bin path so subprocesses can locate 'playwright'
venv_bin = str(Path(__file__).parent / "venv" / "bin")
if venv_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{venv_bin}{os.pathsep}{os.environ.get('PATH', '')}"

import traceback
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import supabase
from app.config import settings
from app.routers import planner, engines, vault, execution, knowledge, auth, translate
from app.routers.execution import arm_event_trigger
from app.services.scheduler import scheduler, add_or_update_job

app = FastAPI(title="Vox Agent Backend")

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi import Request

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    try:
        body = await request.body()
        print(f"\n\n=== 422 Error Payload ===\n{body.decode('utf-8')}\n=======================\n\n")
    except Exception:
        pass
    print(f"\n\n=== 422 Error Detail ===\n{exc.errors()}\n=======================\n\n")
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(planner.router, prefix="/api/v1")
app.include_router(engines.router, prefix="/api/v1")
app.include_router(vault.router, prefix="/api/v1")
app.include_router(execution.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(translate.router, prefix="/api/v1")

import asyncio

async def _watchdog_loop():
    from app.services.telegram_client_engine import _live_clients
    from app.services.trigger_engine import _subscription
    while True:
        try:
            await asyncio.sleep(60)
            
            # 1. Reconnect Telethon if dead
            for user_id, client in list(_live_clients.items()):
                if not client.is_connected():
                    print(f"[Watchdog] Telethon client for {user_id} disconnected! Reconnecting...")
                    try:
                        await client.connect()
                    except Exception as e:
                        print(f"[Watchdog] Failed to reconnect Telethon: {e}")
                        
            # 2. Reconnect Composio if dead
            if _subscription is not None:
                if hasattr(_subscription, "is_alive") and not _subscription.is_alive():
                    print("[Watchdog] Composio subscription died! Restarting...")
                    try:
                        if hasattr(_subscription, "restart"):
                            _subscription.restart()
                        elif hasattr(_subscription, "_pusher") and hasattr(_subscription._pusher, "connect"):
                            _subscription._pusher.connect()
                    except Exception as e:
                        print(f"[Watchdog] Failed to restart Composio: {e}")
                        
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Watchdog] Error: {e}")

@app.on_event("startup")
async def _rearm_event_trigger_agents():
    """Event-trigger listeners live in memory (see trigger_engine.py) — they
    don't survive a restart on their own, so re-register one for every
    currently-active event_trigger agent when the server comes back up."""
    if not supabase:
        return
    try:
        response = supabase.table("agents").select("*").eq("trigger_type", "event_trigger").eq("is_active", True).execute()
    except Exception:
        traceback.print_exc()
        return

    # A brief grace period before reconnecting any Telegram-backed listener.
    # `uvicorn --reload` kills the old worker and starts a new one on every
    # file save; if the old worker hasn't fully released its Telegram
    # connection by the time this new one reconnects with the SAME session
    # file, Telegram sees the same auth key used from two places at once and
    # permanently revokes it (AuthKeyDuplicatedError — unrecoverable in code,
    # requires reconnecting in App Vault). This delay gives the old worker's
    # shutdown handler (below) time to finish disconnecting first, shrinking
    # that race window. It only matters when reload is actually in play; the
    # cost on a normal single boot is one harmless second.
    if any((agent.get("json_blueprint") or {}).get("trigger", {}).get("event_app", "").lower().startswith("telegram") for agent in (response.data or [])):
        await asyncio.sleep(2)

    for agent in response.data or []:
        try:
            await arm_event_trigger(agent["id"], agent.get("user_id"), agent.get("json_blueprint") or {})
        except Exception:
            traceback.print_exc()

    # Load scheduled agents and start the APScheduler
    try:
        scheduler.start()
        sched_response = supabase.table("agents").select("*").eq("trigger_type", "scheduled").eq("is_active", True).execute()
        for agent in sched_response.data or []:
            cron = agent.get("cron_schedule")
            if cron:
                add_or_update_job(agent["id"], agent.get("user_id"), cron)
    except Exception:
        traceback.print_exc()

    asyncio.create_task(_watchdog_loop())

@app.on_event("shutdown")
async def _shutdown_handler():
    from app.services.telegram_client_engine import _live_clients
    for client_key, client in list(_live_clients.items()):
        try:
            if client.is_connected():
                print(f"[Shutdown] Disconnecting Telethon client {client_key}...")
                await client.disconnect()
        except Exception as e:
            print(f"[Shutdown] Error disconnecting Telethon client {client_key}: {e}")

@app.get("/health")
def health_check():
    db_status = "disconnected"
    if supabase:
        try:
            # Verify connectivity with a simple auth ping or request
            supabase.auth.get_session()
            db_status = "connected"
        except Exception as e:
            print(f"Health check warning: {e}")
            db_status = "connected (or api reachable)"
    return {"status": "online", "database": db_status}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
