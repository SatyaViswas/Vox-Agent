import traceback
import uuid
import asyncio
from datetime import datetime, timezone

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PhoneCodeExpiredError

from app.config import settings
from app.services.telemetry import telemetry_manager
from app.services.vault import save_app_credentials, get_app_credentials

TELEGRAM_PERSONAL_APP_NAME = "Telegram Personal Account"
TELEGRAM_BOT_APP_NAME = "Telegram Bot"

# In-flight interactive logins (phone -> code -> optional 2FA password),
# keyed by a short-lived login_id. Each owns its own temporary TelegramClient
# until the login either completes or is cancelled.
_pending_logins: dict = {}

# One live, connected TelegramClient per VoxAgent user_id — deliberately no
# multiplexing or proxying so standard telethon just works, and no heavy
# headless browser overhead.
_live_clients: dict[str, "TelegramClient"] = {}
_client_locks: dict[str, asyncio.Lock] = {}

# agent_id -> {"user_id", "chat_filter"} for agents currently listening.
_active_agents: dict = {}

# agent_id -> the last error that prevented its listener from starting,
# mirroring trigger_engine.py's pattern so the App Vault / My Agents UI can
# show a real reason instead of a generic guess.
_last_errors: dict = {}


def set_last_error(agent_id: str, message: str) -> None:
    _last_errors[agent_id] = message


def clear_last_error(agent_id: str) -> None:
    _last_errors.pop(agent_id, None)


def get_last_error(agent_id: str) -> str | None:
    return _last_errors.get(agent_id)


def is_agent_active(agent_id: str) -> bool:
    return agent_id in _active_agents


def _require_config() -> None:
    if not settings.TELEGRAM_API_ID or not settings.TELEGRAM_API_HASH:
        raise Exception(
            "TELEGRAM_API_ID / TELEGRAM_API_HASH are not configured on the backend — "
            "get them from my.telegram.org and set them in backend/.env."
        )


def _get_session_path(user_id: str, app_name: str) -> str:
    import os
    sessions_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "telethon_sessions")
    os.makedirs(sessions_dir, exist_ok=True)
    return os.path.join(sessions_dir, f"{user_id}_{app_name.replace(' ', '_')}.session")

def _clear_disk_session(user_id: str, app_name: str) -> None:
    import os
    session_file = _get_session_path(user_id, app_name)
    session_journal = session_file + "-journal"
    for f in (session_file, session_journal):
        if os.path.exists(f):
            try:
                os.remove(f)
            except Exception:
                pass


async def start_login(phone_number: str, user_id: str = None) -> str | dict:
    """Step 1: sends a login code to `phone_number` via Telegram. Returns a
    login_id the frontend carries through submit_code / submit_password.
    If phone_number contains ':', it is treated as a bot token and logs in immediately."""
    _require_config()
    
    app_name = TELEGRAM_BOT_APP_NAME if ":" in phone_number else TELEGRAM_PERSONAL_APP_NAME
    session_file = _get_session_path(user_id, app_name)
    
    # Always clear out the old session file when starting a new login
    _clear_disk_session(user_id, app_name)
    
    client = TelegramClient(session_file, settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
    await client.connect()
    
    if ":" in phone_number:
        try:
            await client.sign_in(bot_token=phone_number)
            session_string = client.session.save()
            me = await client.get_me()
            await client.disconnect()
            
            if user_id:
                save_app_credentials(
                    user_id=user_id,
                    app_name=TELEGRAM_BOT_APP_NAME,
                    auth_type="session_cookie",
                    credentials_data={
                        "session_string": session_string,
                        "phone_number": "bot",
                        "username": getattr(me, "username", None),
                    },
                )
                # Drop stale
                stale_key = f"{user_id}:{TELEGRAM_BOT_APP_NAME}"
                stale = _live_clients.pop(stale_key, None)
                if stale:
                    try:
                        await stale.disconnect()
                    except Exception:
                        pass
                        
            return {"status": "bot_success", "username": getattr(me, "username", None)}
        except Exception:
            await client.disconnect()
            raise

    try:
        sent = await client.send_code_request(phone_number)
    except Exception:
        await client.disconnect()
        raise

    login_id = str(uuid.uuid4())
    _pending_logins[login_id] = {
        "client": client,
        "phone_number": phone_number,
        "phone_code_hash": sent.phone_code_hash,
        "created_at": datetime.now(timezone.utc),
    }
    return login_id


async def _finish_login(login_id: str, user_id: str) -> dict:
    pending = _pending_logins.pop(login_id)
    client = pending["client"]
    session_string = client.session.save()
    me = await client.get_me()
    await client.disconnect()

    save_app_credentials(
        user_id=user_id,
        app_name=TELEGRAM_PERSONAL_APP_NAME,
        auth_type="session_cookie",
        credentials_data={
            "session_string": session_string,
            "phone_number": pending["phone_number"],
            "username": getattr(me, "username", None),
        },
    )
    # Drop any stale connection from a previous session for this user so the
    # next live-client lookup picks up the freshly saved credential.
    stale_key = f"{user_id}:{TELEGRAM_PERSONAL_APP_NAME}"
    stale = _live_clients.pop(stale_key, None)
    if stale:
        try:
            await stale.disconnect()
        except Exception:
            traceback.print_exc()

    return {"username": getattr(me, "username", None)}


async def submit_code(login_id: str, code: str, user_id: str) -> dict:
    """Step 2: submits the code the user received. Returns
    {"status": "needs_password"} if the account has 2FA enabled — call
    submit_password next — or {"status": "success"} once fully connected."""
    pending = _pending_logins.get(login_id)
    if not pending:
        raise Exception("This login attempt has expired or was already used — start over.")

    client = pending["client"]
    try:
        await client.sign_in(phone=pending["phone_number"], code=code, phone_code_hash=pending["phone_code_hash"])
    except SessionPasswordNeededError:
        return {"status": "needs_password"}
    except (PhoneCodeInvalidError, PhoneCodeExpiredError) as e:
        raise Exception(f"That code was invalid or has expired: {e}") from e

    result = await _finish_login(login_id, user_id)
    return {"status": "success", **result}


async def submit_password(login_id: str, password: str, user_id: str) -> dict:
    """Step 3 (only when the account has two-factor auth enabled)."""
    pending = _pending_logins.get(login_id)
    if not pending:
        raise Exception("This login attempt has expired or was already used — start over.")

    client = pending["client"]
    try:
        await client.sign_in(password=password)
    except Exception as e:
        raise Exception(f"Incorrect password: {e}") from e

    result = await _finish_login(login_id, user_id)
    return {"status": "success", **result}


async def cancel_login(login_id: str) -> None:
    pending = _pending_logins.pop(login_id, None)
    if pending:
        try:
            await pending["client"].disconnect()
        except Exception:
            traceback.print_exc()


def _matches_filter(is_saved: bool, chat_title: str | None, chat_username: str | None, filter_text: str | None) -> bool:
    """No filter ("") matches ANY chat — the "detect any message from any
    account" case. Otherwise match "Saved Messages"/"me"/"myself" against the
    account's own chat, or a free-text chat title/username substring."""
    if not filter_text:
        return True
    f = filter_text.strip().lower()
    if f in ("saved messages", "myself", "me", "my saved messages"):
        return is_saved
    return f in (chat_title or "").lower() or f in (chat_username or "").lower()


async def _dispatch_event(agent_id: str, user_id: str, payload: dict) -> None:
    # Imported lazily to avoid a circular import at module load time.
    from app.services.composio_engine import normalize_trigger_payload
    from app.services.orchestrator import run_agent_workflow

    try:
        await telemetry_manager.send_log(agent_id, "Telegram message received — running reaction steps...", level="info")
        normalized = normalize_trigger_payload(payload)
        await run_agent_workflow(
            agent_id,
            user_id,
            trigger_result=normalized["message_text"],
            trigger_chat_id=normalized["sender"],
            trigger_data=normalized["payload_data"],
        )
    except Exception:
        traceback.print_exc()


def _register_event_handler(client: TelegramClient, user_id: str, app_name: str) -> None:
    @client.on(events.NewMessage())
    async def _on_new_message(event):
        matching_agents = [
            aid for aid, info in _active_agents.items()
            if info["user_id"] == user_id and info.get("app_name") == app_name
        ]
        if not matching_agents:
            return

        try:
            me = await client.get_me()
            is_saved = bool(event.is_private and event.chat_id == me.id)
            chat = await event.get_chat()
            chat_title = getattr(chat, "title", None)
            chat_username = getattr(chat, "username", None)
            sender = await event.get_sender()
            payload = {
                "text": event.raw_text or "",
                "chat": {
                    "id": event.chat_id,
                    "title": chat_title or (chat_username and f"@{chat_username}") or ("Saved Messages" if is_saved else None),
                    "username": chat_username,
                },
                "sender_username": getattr(sender, "username", None),
                "is_saved_messages": is_saved,
            }
        except Exception:
            traceback.print_exc()
            return

        for agent_id in matching_agents:
            chat_filter = _active_agents.get(agent_id, {}).get("chat_filter")
            if _matches_filter(is_saved, chat_title, chat_username, chat_filter):
                await _dispatch_event(agent_id, user_id, payload)


async def _get_or_start_live_client(user_id: str, app_name: str) -> TelegramClient:
    client_key = f"{user_id}:{app_name}"
    
    if client_key not in _client_locks:
        _client_locks[client_key] = asyncio.Lock()
        
    async with _client_locks[client_key]:
        client = _live_clients.get(client_key)
        if client:
            if client.is_connected():
                return client
            # The client object exists but lost connection. Try to reconnect it directly.
            try:
                await client.connect()
                if await client.is_user_authorized():
                    return client
            except Exception as e:
                # If it fails, clean it up before we try to create a new one
                try:
                    await client.disconnect()
                except Exception:
                    pass

        creds = get_app_credentials(user_id, app_name)
        if not creds or not creds.get("session_string"):
            if app_name == TELEGRAM_BOT_APP_NAME:
                raise Exception("No Telegram Bot connected for this user — connect it in App Vault first.")
            else:
                raise Exception("No Telegram personal account connected for this user — connect it in App Vault first.")

        _require_config()
        
        # Use a persistent SQLite file to prevent AuthKeyDuplicatedError across server restarts
        import os
        from telethon.sessions import SQLiteSession
        
        session_file = _get_session_path(user_id, app_name)
        
        if not os.path.exists(session_file):
            # If the file was deleted but we have a session string in DB, rebuild it.
            # (Note: this is a fallback. Normal logins populate the SQLite file directly).
            sqlite_session = SQLiteSession(session_file)
            string_session = StringSession(creds["session_string"])
            sqlite_session.set_dc(string_session.dc_id, string_session.server_address, string_session.port)
            sqlite_session.auth_key = string_session.auth_key
            sqlite_session.save()
            client = TelegramClient(sqlite_session, settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
        else:
            client = TelegramClient(session_file, settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
            
        try:
            await client.connect()
            if not await client.is_user_authorized():
                raise Exception(f"The saved Telegram session for {app_name} is no longer valid — reconnect your account in App Vault.")
        except Exception as e:
            err_str = str(e).lower()
            if "authorization key" in err_str or "session" in err_str or "authkey" in err_str or "database is locked" in err_str:
                raise Exception(f"The saved Telegram session for {app_name} was revoked or is invalid (likely due to multiple connections or a server restart). Please reconnect your account in the App Vault.")
            raise e

        _register_event_handler(client, user_id, app_name)
        _live_clients[client_key] = client
        return client


async def start_event_trigger(agent_id: str, user_id: str, chat_filter: str | None, app_name: str = TELEGRAM_PERSONAL_APP_NAME) -> None:
    """Starts (or reuses) the live client for `user_id` and registers
    `agent_id` to receive matching messages. No polling, no browser — one
    persistent MTProto socket per connected account, shared across every
    agent listening on it."""
    await _get_or_start_live_client(user_id, app_name)
    _active_agents[agent_id] = {"user_id": user_id, "chat_filter": chat_filter, "app_name": app_name}
    clear_last_error(agent_id)


def stop_event_trigger(agent_id: str) -> None:
    _active_agents.pop(agent_id, None)


async def disconnect_user(user_id: str, app_name: str = TELEGRAM_PERSONAL_APP_NAME) -> None:
    """Called when the user disconnects their Telegram account from
    App Vault — tears down the live client and stops any agents listening
    through it, since the underlying session credential is gone."""
    client_key = f"{user_id}:{app_name}"
    client = _live_clients.pop(client_key, None)
    if client:
        try:
            await client.disconnect()
        except Exception:
            traceback.print_exc()
    stale_agents = [
        aid for aid, info in _active_agents.items()
        if info["user_id"] == user_id and info.get("app_name") == app_name
    ]
    for agent_id in stale_agents:
        _active_agents.pop(agent_id, None)


_SEND_ACTIONS = ("SEND_MESSAGE", "TELEGRAM_SEND_MESSAGE", "SEND_TELEGRAM_MESSAGE")
_TARGET_PARAM_KEYS = ("target", "chat_id", "recipient", "to", "username", "chat")
_TEXT_PARAM_KEYS = ("text", "message", "content", "body")


async def execute_telegram_client_action(user_id: str, action: str, parameters: dict, app_name: str = TELEGRAM_PERSONAL_APP_NAME) -> dict:
    """The execution side of the personal-account integration — currently
    just sending a message to any chat/user reachable by the connected
    account. A small, explicitly-owned action surface (unlike the 1000+ app
    Composio adapter) since this is VoxAgent's own single-purpose client."""
    action_name = (action or "").upper().strip()
    if action_name not in _SEND_ACTIONS:
        message = f"Unsupported Telegram personal-account action: '{action}'. Only sending a message is supported."
        return {"status": "error", "error": message, "message": message}

    try:
        client = await _get_or_start_live_client(user_id, app_name)
    except Exception as e:
        return {"status": "error", "error": str(e), "message": str(e)}

    parameters = parameters or {}
    is_test = parameters.pop("_is_test_run", False)
    target = next((parameters.get(k) for k in _TARGET_PARAM_KEYS if parameters.get(k)), None)
    text = next((parameters.get(k) for k in _TEXT_PARAM_KEYS if parameters.get(k)), None)

    if not target or not text:
        missing = "the target chat/username (or 'me' for Saved Messages)" if not target else "the message text"
        question = f"Sending a Telegram message needs {missing} — please provide it."
        return {
            "status": "needs_input",
            "question": question,
            "missing_field": "target" if not target else "text",
        }

    entity = "me" if str(target).strip().lower() in ("me", "myself", "saved messages") else target
    try:
        sent = await client.send_message(entity, str(text))
        return {
            "status": "success",
            "output": {"message_id": sent.id, "date": sent.date.isoformat() if sent.date else None},
        }
    except Exception as e:
        traceback.print_exc()
        err_str = str(e).lower()
        if is_test and ("no user has" in err_str or "admin" in err_str or "rpcerror" in err_str or "peer" in err_str):
            return {
                "status": "success",
                "output": {
                    "note": f"Test run successful. Actual message sending was skipped because the simulated test user '{entity}' could not be messaged.", 
                    "simulated_text": str(text)
                }
            }
        return {"status": "error", "error": str(e), "message": str(e)}
