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
from app.routers import planner, engines, vault, execution
from app.routers.execution import arm_event_trigger
from app.services.scheduler import scheduler, add_or_update_job

app = FastAPI(title="Vox Agent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(planner.router, prefix="/api/v1")
app.include_router(engines.router, prefix="/api/v1")
app.include_router(vault.router, prefix="/api/v1")
app.include_router(execution.router, prefix="/api/v1")

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
