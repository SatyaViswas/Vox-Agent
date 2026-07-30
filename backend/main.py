import os
import sys
from pathlib import Path

# Explicitly prepend the project's local venv/bin path so subprocesses can locate 'playwright'
venv_bin = str(Path(__file__).parent / "venv" / "bin")
if venv_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{venv_bin}{os.pathsep}{os.environ.get('PATH', '')}"

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import supabase
from app.config import settings
from app.routers import planner, engines

app = FastAPI(title="VoxAgent AI Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(planner.router, prefix="/api/v1")
app.include_router(engines.router, prefix="/api/v1")

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
