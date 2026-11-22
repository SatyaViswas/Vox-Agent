import os
import sys
from pathlib import Path

# Prepend project's venv/bin and standard Homebrew/Unix paths for ffmpeg and playwright
venv_bin = str(Path(__file__).parent / "venv" / "bin")
for extra_p in ["/opt/homebrew/bin", "/usr/local/bin", venv_bin]:
    if extra_p not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{extra_p}{os.pathsep}{os.environ.get('PATH', '')}"

import traceback
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import supabase
from app.config import settings
from app.routers import planner, engines, vault, execution, knowledge, auth, translate, tts
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
app.include_router(tts.router, prefix="/api/v1")

import asyncio

async def _watchdog_loop():
    from app.services.telegram_client_engine import _live_clients
    from app.services.trigger_engine import _subscription
    while True:
        try:
            await asyncio.sleep(60)
            
            # 1. Reconnect Telethon if dead (non-blocking with timeout)
            for user_id, client in list(_live_clients.items()):
                if not client.is_connected():
                    print(f"[Watchdog] Telethon client for {user_id} disconnected! Reconnecting...")
                    try:
                        await asyncio.wait_for(client.connect(), timeout=5.0)
                    except Exception as e:
                        print(f"[Watchdog] Failed to reconnect Telethon: {e}")
                        
            # 2. Reconnect Composio if dead (in thread to avoid blocking event loop)
            if _subscription is not None:
                if hasattr(_subscription, "is_alive") and not _subscription.is_alive():
                    print("[Watchdog] Composio subscription died! Restarting...")
                    try:
                        if hasattr(_subscription, "restart"):
                            await asyncio.to_thread(_subscription.restart)
                        elif hasattr(_subscription, "_pusher") and hasattr(_subscription._pusher, "connect"):
                            await asyncio.to_thread(_subscription._pusher.connect)
                    except Exception as e:
                        print(f"[Watchdog] Failed to restart Composio: {e}")
                        
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Watchdog] Error: {e}")

async def _background_startup_rearm():
    """Rearms event listeners and scheduled jobs in background worker tasks so
    Uvicorn starts serving HTTP requests immediately without blocking."""
    if not supabase:
        return

    try:
        # Fetch agents concurrently without blocking the event loop
        event_res, sched_res = await asyncio.gather(
            asyncio.to_thread(lambda: supabase.table("agents").select("*").eq("trigger_type", "event_trigger").eq("is_active", True).execute()),
            asyncio.to_thread(lambda: supabase.table("agents").select("*").eq("trigger_type", "scheduled").eq("is_active", True).execute()),
            return_exceptions=True,
        )
    except Exception:
        traceback.print_exc()
        return

    # 1. Arm scheduled jobs
    if not isinstance(sched_res, Exception) and getattr(sched_res, "data", None):
        for agent in sched_res.data:
            cron = agent.get("cron_schedule")
            if cron:
                try:
                    add_or_update_job(agent["id"], agent.get("user_id"), cron)
                except Exception:
                    traceback.print_exc()

    # 2. Arm event triggers
    event_agents = sched_res.data if False else (event_res.data if not isinstance(event_res, Exception) and getattr(event_res, "data", None) else [])
    if any((agent.get("json_blueprint") or {}).get("trigger", {}).get("event_app", "").lower().startswith("telegram") for agent in event_agents):
        await asyncio.sleep(2)

    async def _safe_arm(agent):
        try:
            # Enforce 10-second timeout per agent so slow third parties never freeze the process
            await asyncio.wait_for(
                arm_event_trigger(agent["id"], agent.get("user_id"), agent.get("json_blueprint") or {}),
                timeout=10.0,
            )
        except asyncio.TimeoutError:
            print(f"[Startup] Timed out arming trigger for agent {agent.get('id')} ({agent.get('title')})")
        except Exception:
            traceback.print_exc()

    await asyncio.gather(*[_safe_arm(agent) for agent in event_agents], return_exceptions=True)
    print(f"[Startup] Background rearm completed for {len(event_agents)} active event triggers.")

@app.on_event("startup")
async def _startup_handler():
    """Starts scheduler and spawns background re-arming tasks so Uvicorn binds
    and serves HTTP traffic immediately with zero cold-start delay."""
    try:
        scheduler.start()
    except Exception:
        traceback.print_exc()

    asyncio.create_task(_background_startup_rearm())
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
