import traceback
import uuid
from datetime import datetime, timezone

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PhoneCodeExpiredError

from app.config import settings
from app.services.telemetry import telemetry_manager
from app.services.vault import save_app_credentials, get_app_credentials

TELEGRAM_PERSONAL_APP_NAME = "Telegram Personal Account"

# In-flight interactive logins (phone -> code -> optional 2FA password),
# keyed by a short-lived login_id. Each owns its own temporary TelegramClient
# until the login either completes or is cancelled.
_pending_logins: dict = {}

# One live, connected TelegramClient per VoxAgent user_id — deliberately no
# multi-account support (one personal Telegram account per user for now).
_live_clients: dict = {}

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


async def start_login(phone_number: str) -> str:
    """Step 1: sends a login code to `phone_number` via Telegram. Returns a
    login_id the frontend carries through submit_code / submit_password."""
    _require_config()
    client = TelegramClient(StringSession(), settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
    await client.connect()
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
    stale = _live_clients.pop(user_id, None)
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


def _register_event_handler(client: TelegramClient, user_id: str) -> None:
    @client.on(events.NewMessage())
    async def _on_new_message(event):
        matching_agents = [aid for aid, info in _active_agents.items() if info["user_id"] == user_id]
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


async def _get_or_start_live_client(user_id: str) -> TelegramClient:
    client = _live_clients.get(user_id)
    if client and client.is_connected():
        return client

    creds = get_app_credentials(user_id, TELEGRAM_PERSONAL_APP_NAME)
    if not creds or not creds.get("session_string"):
        raise Exception("No Telegram personal account connected for this user — connect it in App Vault first.")

    _require_config()
    client = TelegramClient(StringSession(creds["session_string"]), settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        raise Exception("The saved Telegram session is no longer valid — reconnect your account in App Vault.")

    _register_event_handler(client, user_id)
    _live_clients[user_id] = client
    return client


async def start_event_trigger(agent_id: str, user_id: str, chat_filter: str | None) -> None:
    """Starts (or reuses) the live client for `user_id` and registers
    `agent_id` to receive matching messages. No polling, no browser — one
    persistent MTProto socket per connected account, shared across every
    agent listening on it."""
    await _get_or_start_live_client(user_id)
    _active_agents[agent_id] = {"user_id": user_id, "chat_filter": chat_filter}
    clear_last_error(agent_id)


def stop_event_trigger(agent_id: str) -> None:
    _active_agents.pop(agent_id, None)


async def disconnect_user(user_id: str) -> None:
    """Called when the user disconnects their Telegram personal account from
    App Vault — tears down the live client and stops any agents listening
    through it, since the underlying session credential is gone."""
    client = _live_clients.pop(user_id, None)
    if client:
        try:
            await client.disconnect()
        except Exception:
            traceback.print_exc()
    stale_agents = [aid for aid, info in _active_agents.items() if info["user_id"] == user_id]
    for agent_id in stale_agents:
        _active_agents.pop(agent_id, None)


_SEND_ACTIONS = ("SEND_MESSAGE", "TELEGRAM_SEND_MESSAGE", "SEND_TELEGRAM_MESSAGE")
_TARGET_PARAM_KEYS = ("target", "chat_id", "recipient", "to", "username", "chat")
_TEXT_PARAM_KEYS = ("text", "message", "content", "body")


async def execute_telegram_client_action(user_id: str, action: str, parameters: dict) -> dict:
    """The execution side of the personal-account integration — currently
    just sending a message to any chat/user reachable by the connected
    account. A small, explicitly-owned action surface (unlike the 1000+ app
    Composio adapter) since this is VoxAgent's own single-purpose client."""
    action_name = (action or "").upper().strip()
    if action_name not in _SEND_ACTIONS:
        message = f"Unsupported Telegram personal-account action: '{action}'. Only sending a message is supported."
        return {"status": "error", "error": message, "message": message}

    try:
        client = await _get_or_start_live_client(user_id)
    except Exception as e:
        return {"status": "error", "error": str(e), "message": str(e)}

    parameters = parameters or {}
    target = next((parameters[k] for k in _TARGET_PARAM_KEYS if parameters.get(k)), None)
    text = next((parameters[k] for k in _TEXT_PARAM_KEYS if parameters.get(k)), None)

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
        error_text = str(e)
        return {"status": "error", "error": error_text, "message": error_text}
