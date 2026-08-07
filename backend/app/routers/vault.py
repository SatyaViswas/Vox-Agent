import traceback
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Dict, Any, Literal, Optional
from app.services.vault import (
    save_app_credentials,
    list_user_apps,
    disconnect_app
)
from app.database import supabase
from app.services.composio_engine import (
    NoAuthRequiredError,
    connect_app_with_credentials,
    disconnect_composio_account,
    get_app_connect_url,
    get_toolkit_connect_requirements,
    list_composio_apps,
    list_composio_connected_accounts,
)
from app.services.whatsapp_engine import (
    start_whatsapp_qr_session,
    poll_whatsapp_qr_session,
    cancel_whatsapp_qr_session,
)
from app.services import telegram_client_engine
from app.services.telegram_client_engine import TELEGRAM_PERSONAL_APP_NAME, TELEGRAM_BOT_APP_NAME

router = APIRouter(tags=["vault"])

class SaveSessionRequest(BaseModel):
    user_id: str
    app_name: str
    auth_type: Literal["session_cookie", "oauth2", "api_key"]
    credentials: Dict[str, Any]

class ConnectAppRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    app_slug: str

@router.get("/vault/composio-apps")
async def get_composio_apps(
    search: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(30, le=100),
):
    """Dynamic catalog of Composio's full app library (1000+ toolkits,
    WhatsApp included) — replaces the old hardcoded ~20-app list."""
    try:
        return {"status": "success", **list_composio_apps(search=search, cursor=cursor, limit=limit)}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/vault/composio-connections")
async def get_composio_connections(user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    """Live connection state for the dynamic Composio app catalog, read
    straight from Composio's API — see list_composio_connected_accounts for
    why this (and not the local `connected_apps` table) is the source of
    truth for apps connected via the OAuth "Connect (1-Click)" flow."""
    try:
        return {"status": "success", "connections": list_composio_connected_accounts(user_id)}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

_BUILTIN_APPS = {"voxagent ai", "voxagent vault notes"}


def _slugify_app(app: str) -> str:
    return "".join(ch for ch in (app or "").lower() if ch.isalnum())


@router.get("/vault/required-apps-status")
async def required_apps_status(
    apps: str = Query(..., description="Comma-separated app display names, e.g. a blueprint's required_apps"),
    user_id: str = Query("00000000-0000-0000-0000-000000000000"),
):
    """Tells the caller, for a whole blueprint's required_apps list at once,
    which apps are already usable and which still need connecting — lets
    Agent Studio gate agent creation on this instead of creating an agent
    that's silently broken until a step fails (or, for an event-triggered
    agent, until a real event happens and nothing visibly comes of it)."""
    names = [a.strip() for a in (apps or "").split(",") if a.strip()]
    connected_slugs = {c["slug"] for c in list_composio_connected_accounts(user_id)}
    telegram_personal_connected = any(
        (a.get("app_name") or "").strip().lower() == TELEGRAM_PERSONAL_APP_NAME.lower() and a.get("status") == "active"
        for a in list_user_apps(user_id)
    )
    telegram_bot_connected = any(
        (a.get("app_name") or "").strip().lower() == TELEGRAM_BOT_APP_NAME.lower() and a.get("status") == "active"
        for a in list_user_apps(user_id)
    )

    results = []
    for name in names:
        lowered = name.lower()
        if lowered in _BUILTIN_APPS:
            results.append({"app": name, "connected": True, "builtin": True})
        elif lowered == TELEGRAM_PERSONAL_APP_NAME.lower():
            results.append({"app": name, "connected": telegram_personal_connected, "connect_via": "telegram_personal"})
        elif lowered == TELEGRAM_BOT_APP_NAME.lower():
            results.append({"app": name, "connected": telegram_bot_connected, "connect_via": "telegram_bot"})
        else:
            slug = _slugify_app(name)
            connected = slug in connected_slugs
            no_auth = False
            if not connected:
                # A toolkit whose tools work with no connected account at all
                # (e.g. Hacker News's public read API) has nothing to be
                # "connected" in the first place — checking connected_slugs
                # alone would permanently show it as needing a connection it
                # can never actually gain, blocking or warning on agent
                # creation for an app that already works.
                try:
                    no_auth = get_toolkit_connect_requirements(slug).get("mode") == "none"
                except Exception:
                    no_auth = False
            results.append({
                "app": name,
                "connected": connected or no_auth,
                "slug": slug,
                "no_auth_required": no_auth,
            })

    return {"status": "success", "apps": results}


@router.delete("/vault/composio-connections/{connected_account_id}")
async def delete_composio_connection(connected_account_id: str):
    try:
        disconnect_composio_account(connected_account_id)
        return {"status": "success", "message": "Connection removed"}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/vault/apps")
async def get_user_apps(user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    try:
        apps = list_user_apps(user_id)
        return {"status": "success", "apps": apps}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _rearm_event_triggers(user_id: str):
    from app.database import supabase
    from app.routers.execution import arm_event_trigger
    import asyncio
    
    if not supabase: return
    response = supabase.table("agents").select("*").eq("user_id", user_id).eq("trigger_type", "event_trigger").eq("is_active", True).execute()
    
    for agent in response.data or []:
        try:
            blueprint = agent.get("json_blueprint") or {}
            if isinstance(blueprint, str):
                import json
                blueprint = json.loads(blueprint)
            asyncio.create_task(arm_event_trigger(agent["id"], user_id, blueprint))
        except Exception:
            pass

@router.post("/vault/save-session")
async def save_session(request: SaveSessionRequest):
    try:
        save_app_credentials(
            user_id=request.user_id,
            app_name=request.app_name,
            auth_type=request.auth_type,
            credentials_data=request.credentials
        )
        _rearm_event_triggers(request.user_id)
        return {"status": "success", "message": "Credentials stored securely"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/vault/apps/{app_name}")
async def remove_app(app_name: str, user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    try:
        success = disconnect_app(user_id, app_name)
        if success and app_name.strip().lower() in (TELEGRAM_PERSONAL_APP_NAME.lower(), TELEGRAM_BOT_APP_NAME.lower()):
            # The saved session credential is gone — tear down the live
            # client and stop any agents that were listening through it.
            # Determine the exact internal app name
            exact_app_name = TELEGRAM_PERSONAL_APP_NAME if app_name.strip().lower() == TELEGRAM_PERSONAL_APP_NAME.lower() else TELEGRAM_BOT_APP_NAME
            await telegram_client_engine.disconnect_user(user_id, exact_app_name)
        if success:
            return {"status": "success", "message": f"{app_name} disconnected"}
        else:
            raise HTTPException(status_code=404, detail="App not found or already disconnected")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/vault/notes")
async def get_vault_notes(user_id: str = Query("00000000-0000-0000-0000-000000000000")):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
        
    try:
        response = supabase.table("vault_notes").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
        return {"status": "success", "notes": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/vault/connect")
async def get_connect_url(request: ConnectAppRequest):
    try:
        url = get_app_connect_url(request.user_id, request.app_slug)
        return {"status": "success", "app_slug": request.app_slug, "redirect_url": url}
    except NoAuthRequiredError as e:
        # Not a failure — this toolkit's tools work with no connected
        # account at all (e.g. Gemini). Tell the frontend so it can show
        # "always available" instead of a scary connect error.
        return {"status": "no_auth_required", "app_slug": request.app_slug, "message": str(e)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/vault/connect-requirements")
async def get_connect_requirements(app_slug: str = Query(...)):
    """Tells the frontend whether `app_slug` connects via the 1-click OAuth
    popup or needs a manual credential form (API key, bot token, ...) —
    e.g. Telegram has no Composio-managed OAuth at all."""
    try:
        return {"status": "success", **get_toolkit_connect_requirements(app_slug)}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

class ConnectWithCredentialsRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    app_slug: str
    credentials: Dict[str, str]

@router.post("/vault/connect-with-credentials")
async def connect_with_credentials_route(request: ConnectWithCredentialsRequest):
    try:
        result = connect_app_with_credentials(request.user_id, request.app_slug, request.credentials)
        _rearm_event_triggers(request.user_id)
        return {"status": "success", **result}
    except NoAuthRequiredError as e:
        return {"status": "no_auth_required", "app_slug": request.app_slug, "message": str(e)}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

class WhatsAppQrStartRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"

@router.post("/vault/whatsapp/qr")
async def start_whatsapp_qr(request: WhatsAppQrStartRequest):
    # Note: the service's own "status" field (waiting/linked/error) is the
    # meaningful signal here, not a generic HTTP-success wrapper — an actual
    # failure raises and is surfaced as a non-200 below instead.
    try:
        return await start_whatsapp_qr_session(request.user_id)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/vault/whatsapp/qr/{session_id}")
async def poll_whatsapp_qr(session_id: str):
    try:
        return await poll_whatsapp_qr_session(session_id)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/vault/whatsapp/qr/{session_id}")
async def cancel_whatsapp_qr(session_id: str):
    try:
        await cancel_whatsapp_qr_session(session_id)
        return {"status": "success"}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


class TelegramLoginStartRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    phone_number: str


class TelegramLoginCodeRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    login_id: str
    code: str


class TelegramLoginPasswordRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    login_id: str
    password: str


@router.post("/vault/telegram/login/start")
async def start_telegram_login(request: TelegramLoginStartRequest):
    """Step 1 of connecting a personal Telegram account: sends a login code
    to the given phone number via Telegram (not SMS by default)."""
    try:
        res = await telegram_client_engine.start_login(request.phone_number, request.user_id)
        if isinstance(res, dict) and res.get("status") == "bot_success":
            return res
        return {"status": "success", "login_id": res}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vault/telegram/login/code")
async def submit_telegram_code(request: TelegramLoginCodeRequest):
    """Step 2: submits the received code. Returns needs_password=true if the
    account has two-factor auth enabled — call the password endpoint next."""
    try:
        result = await telegram_client_engine.submit_code(request.login_id, request.code, request.user_id)
        return {"status": "success", **result}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vault/telegram/login/password")
async def submit_telegram_password(request: TelegramLoginPasswordRequest):
    """Step 3, only when the account has two-factor auth enabled."""
    try:
        result = await telegram_client_engine.submit_password(request.login_id, request.password, request.user_id)
        return {"status": "success", **result}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vault/telegram/login/{login_id}")
async def cancel_telegram_login(login_id: str):
    await telegram_client_engine.cancel_login(login_id)
    return {"status": "success"}
