import traceback
from fastapi import APIRouter, HTTPException, Query, WebSocket
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
    introspect_app_resources,
    list_composio_apps,
    list_composio_connected_accounts,
    slugify_app_name,
)
from app.services.whatsapp_engine import (
    start_whatsapp_qr_session,
    poll_whatsapp_qr_session,
    cancel_whatsapp_qr_session,
)
from app.services.browser_login_engine import (
    start_browser_login_session,
    start_mobile_browser_login_session,
    handle_mobile_stream,
    capture_browser_login_session,
    cancel_browser_login_session,
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

@router.get("/vault/introspect-resources")
async def introspect_resources(
    app: str = Query(..., description="App name, e.g. 'Google Sheets' or 'Slack'"),
    user_id: str = Query("00000000-0000-0000-0000-000000000000"),
    parameter_key: Optional[str] = Query(None, description="Optional parameter key, e.g. 'spreadsheet_name' or 'channel'"),
):
    """Dynamically introspects connected app resources (e.g. spreadsheet names,
    slack channels, notion databases) to populate dropdown/selection pills."""
    try:
        resources = await introspect_app_resources(user_id=user_id, app=app, parameter_key=parameter_key or "")
        return {"status": "success", "app": app, "resources": resources}
    except Exception as e:
        traceback.print_exc()
        return {"status": "error", "app": app, "resources": [], "error": str(e)}

_BUILTIN_APPS = {"voxagent ai", "voxagent vault notes"}


@router.get("/vault/required-apps-status")
async def required_apps_status(
    apps: str = Query(..., description="Comma-separated app display names, e.g. a blueprint's required_apps"),
    user_id: str = Query("00000000-0000-0000-0000-000000000000"),
    routes: Optional[str] = Query(
        None,
        description="Comma-separated route per app, positionally paired with `apps` "
        "(e.g. 'composio_api,browser_agent'). An app whose route is 'browser_agent' is "
        "checked against the local App Vault session store instead of Composio.",
    ),
):
    """Tells the caller, for a whole blueprint's required_apps list at once,
    which apps are already usable and which still need connecting — lets
    Agent Studio gate agent creation on this instead of creating an agent
    that's silently broken until a step fails (or, for an event-triggered
    agent, until a real event happens and nothing visibly comes of it)."""
    names = [a.strip() for a in (apps or "").split(",") if a.strip()]
    route_list = [r.strip() for r in (routes or "").split(",")] if routes else []
    connected_slugs = {c["slug"] for c in list_composio_connected_accounts(user_id)}
    user_apps = list_user_apps(user_id)
    vault_connected_names = {
        (a.get("app_name") or "").strip().lower() for a in user_apps if a.get("status") == "active"
    }
    telegram_personal_connected = any(
        (a.get("app_name") or "").strip().lower() == TELEGRAM_PERSONAL_APP_NAME.lower() and a.get("status") == "active"
        for a in user_apps
    )
    telegram_bot_connected = any(
        (a.get("app_name") or "").strip().lower() == TELEGRAM_BOT_APP_NAME.lower() and a.get("status") == "active"
        for a in user_apps
    )

    results = []
    for i, name in enumerate(names):
        lowered = name.lower()
        route = route_list[i] if i < len(route_list) else None
        if lowered in _BUILTIN_APPS:
            results.append({"app": name, "connected": True, "builtin": True})
        elif lowered == TELEGRAM_PERSONAL_APP_NAME.lower():
            results.append({"app": name, "connected": telegram_personal_connected, "connect_via": "telegram_personal"})
        elif lowered == TELEGRAM_BOT_APP_NAME.lower():
            results.append({"app": name, "connected": telegram_bot_connected, "connect_via": "telegram_bot"})
        elif route == "browser_agent":
            # A browser_agent step's "app" needs a saved App Vault session
            # (cookies, or a username/password portal login — see
            # PortalSessionFormModal / browser_engine.execute_browser_action),
            # never a Composio connection — checking Composio here is exactly
            # what used to 500 for an app Composio doesn't have at all
            # (e.g. "zomato") and misleadingly offer an OAuth "Connect"
            # button for one it does (e.g. "Google Slides") when the
            # workflow never actually calls its API.
            results.append({
                "app": name,
                "connected": lowered in vault_connected_names,
                "connect_via": "browser_vault",
            })
        else:
            slug = slugify_app_name(name)
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
    except ValueError as e:
        # Not a real Composio toolkit (e.g. an app the planner routed to
        # browser_agent, or a typo'd/unsupported name) — a clean, expected
        # 404 instead of a scary 500.
        raise HTTPException(status_code=404, detail=str(e))
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


class BrowserLoginStartRequest(BaseModel):
    user_id: str = "00000000-0000-0000-0000-000000000000"
    app_name: str
    login_url: Optional[str] = None
    is_mobile: Optional[bool] = False
    viewport_width: Optional[int] = 390
    viewport_height: Optional[int] = 844


@router.post("/vault/browser-login/start")
async def start_browser_login(request: BrowserLoginStartRequest):
    """Opens a real Chromium browser for logging into `app_name`.
    - On desktop/laptop (is_mobile=False): opens a visible Chromium window on the host screen.
    - On mobile (is_mobile=True): launches headless Chromium with low-latency CDP screencasting
      streamed directly to the mobile device over WebSocket.
    """
    try:
        if request.is_mobile:
            return await start_mobile_browser_login_session(
                request.user_id,
                request.app_name,
                request.login_url,
                width=request.viewport_width or 390,
                height=request.viewport_height or 844,
            )
        return await start_browser_login_session(request.user_id, request.app_name, request.login_url)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/vault/browser-login/stream/{session_id}")
async def stream_browser_login(websocket: WebSocket, session_id: str):
    """Real-time bi-directional screencast and touch-interaction stream for mobile browser login."""
    await handle_mobile_stream(websocket, session_id)


@router.post("/vault/browser-login/{session_id}/capture")
async def capture_browser_login(session_id: str):
    """Called once the user confirms they've finished logging in — reads
    the browser's cookies and stores them, then closes the session."""
    result = await capture_browser_login_session(session_id)
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    return {"status": "success", **{k: v for k, v in result.items() if k != "status"}}


@router.delete("/vault/browser-login/{session_id}")
async def cancel_browser_login(session_id: str):
    await cancel_browser_login_session(session_id)
    return {"status": "success"}


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
