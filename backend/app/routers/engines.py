from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Literal, Optional
from app.services.composio_engine import execute_composio_action
from app.services.browser_engine import execute_browser_action
from app.services.http_engine import execute_http_webhook
from app.services.git_engine import discover_local_repos, git_status
from pathlib import Path
import asyncio

router = APIRouter(tags=["engines"])


@router.get("/git/repos")
async def list_local_git_repositories():
    """Returns discovered local Git repositories for the Studio workspace selector."""
    try:
        repos = await asyncio.to_thread(discover_local_repos, False)
        async def _enrich(r):
            try:
                st = await git_status(Path(r["path"]))
                return {
                    **r,
                    "branch": st.get("branch"),
                    "is_clean": st.get("is_clean", True),
                    "changes_count": (st.get("staged_count", 0) + st.get("unstaged_count", 0) + st.get("untracked_count", 0)),
                }
            except Exception:
                return r

        enriched = await asyncio.gather(*[_enrich(r) for r in repos])
        return {"status": "success", "repositories": enriched}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class TestEngineRequest(BaseModel):
    route: Literal["browser_agent", "composio_api", "http_webhook"]
    app: str
    action: str
    parameters: Dict[str, Any]
    session_cookies: Optional[list] = None

@router.post("/test-engine")
async def test_engine(request: TestEngineRequest):
    try:
        if request.route == "composio_api":
            result = await execute_composio_action(
                app=request.app,
                action=request.action,
                parameters=request.parameters
            )
            return result
            
        elif request.route == "browser_agent":
            # Extract task description from parameters or action
            task_description = request.parameters.get("task", request.action)
            result = await execute_browser_action(
                task_description=task_description,
                session_cookies=request.session_cookies
            )
            return result
            
        elif request.route == "http_webhook":
            url = request.parameters.get("url") or (request.action if request.action.startswith("http") else None)
            if not url:
                raise HTTPException(status_code=400, detail="URL is required for http_webhook")
                
            method = request.parameters.get("method", "POST")
            headers = request.parameters.get("headers", {})
            payload = request.parameters.get("payload")
            
            # If payload isn't explicitly defined, use all non-routing parameters as the payload
            if payload is None:
                payload = {k: v for k, v in request.parameters.items() if k not in ["url", "method", "headers"]}
            
            result = await execute_http_webhook(
                url=url,
                method=method,
                headers=headers,
                payload=payload
            )
            return result
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
