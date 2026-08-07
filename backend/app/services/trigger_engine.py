import asyncio
import traceback
from app.services.composio_engine import ai_content_matches_condition, ai_pick_best_match, composio
from app.services.telemetry import telemetry_manager

# A single shared Pusher-based subscription for the whole process — Composio
# pushes matching events to us in real time (no polling, no persistent
# browser). Each event_trigger agent registers its own filtered callback on
# top of this one connection.
_subscription = None

# agent_id -> {"user_id", "toolkit_slug", "trigger_slug"} for agents whose
# listener is currently considered active. The installed SDK's
# TriggerSubscription doesn't expose a per-callback unregister, so a stopped
# agent's callback is left registered but checks this map and no-ops.
_active_agents: dict = {}

# agent_id -> the last error that prevented its listener from starting, so
# the "Not listening" state in the UI can say *why* (e.g. "Composio doesn't
# expose an event trigger for 'telegram' yet") instead of a generic guess
# that sends users chasing a connection/permission problem that isn't real.
_last_errors: dict = {}


def set_last_error(agent_id: str, message: str) -> None:
    _last_errors[agent_id] = message


def clear_last_error(agent_id: str) -> None:
    _last_errors.pop(agent_id, None)


def get_last_error(agent_id: str) -> str | None:
    return _last_errors.get(agent_id)


def _require_composio():
    if not composio:
        raise Exception("Composio client is not initialized — check COMPOSIO_API_KEY.")


def _get_subscription():
    global _subscription
    _require_composio()
    if _subscription is None:
        _subscription = composio.triggers.subscribe()
    return _subscription


def _extract_slug(item):
    if hasattr(item, "slug"):
        return item.slug
    if isinstance(item, dict):
        return item.get("slug") or item.get("name")
    return getattr(item, "name", None)


def _extract_description(item) -> str | None:
    if hasattr(item, "description"):
        return item.description
    if isinstance(item, dict):
        return item.get("description")
    return None


def discover_trigger_slug(toolkit_slug: str, intent_description: str | None = None) -> str:
    """Looks up the Composio trigger type to arm for a toolkit. Requires the
    API key to have "triggers" read access — raises a clear, actionable
    error if that permission is missing, since that's the most likely
    reason this fails.

    Many toolkits expose more than one trigger type (Gmail alone has both
    "message sent" and "message received") — blindly taking the first one
    the API returns previously armed whichever happened to sort first,
    which for Gmail is the SENT trigger, silently listening for the user's
    own outgoing mail instead of their inbox. When there's more than one
    candidate, `intent_description` (the blueprint's own plain-English
    description of what should be watched, e.g. "whenever an email
    arrives...") lets a quick AI call pick by each trigger's real
    description instead of by list order.
    """
    _require_composio()
    try:
        response = composio.triggers.list(toolkit_slugs=[toolkit_slug])
        items = list(getattr(response, "items", response) or [])
    except Exception as e:
        raise Exception(
            f"Could not look up trigger types for '{toolkit_slug}': {e}. "
            "If this mentions permissions, grant the API key \"triggers\" read "
            "access in the Composio dashboard (API Keys) and try again."
        ) from e

    if not items:
        raise Exception(f"Composio doesn't expose an event trigger for '{toolkit_slug}' yet.")

    if len(items) == 1:
        slug = _extract_slug(items[0])
        if not slug:
            raise Exception(f"Composio returned a trigger type for '{toolkit_slug}' with no usable slug.")
        return slug

    candidates = [(_extract_slug(i), _extract_description(i)) for i in items]
    candidates = [(s, d) for s, d in candidates if s]
    context = (
        f"An automation is being armed to watch '{toolkit_slug}' for this condition: "
        f"\"{intent_description or 'a new event of some kind'}\". Here are the trigger types this app "
        "supports — pick the one whose own description best matches what should actually be watched for "
        "(e.g. a RECEIVED-message trigger for \"whenever I get an email\", not a SENT-message one)."
    )
    picked = ai_pick_best_match(context, candidates)
    slug = picked or (candidates[0][0] if candidates else None)
    if not slug:
        raise Exception(f"Composio returned trigger types for '{toolkit_slug}' with no usable slugs.")
    return slug


def _ensure_trigger_instance(user_id: str, trigger_slug: str, trigger_config: dict | None = None):
    try:
        return composio.triggers.create(trigger_slug, user_id=user_id, trigger_config=trigger_config or {})
    except Exception as e:
        raise Exception(
            f"Failed to register the '{trigger_slug}' trigger with Composio for this account: {e}"
        ) from e


def _payload_text_blob(payload) -> str:
    """Flattens an event payload's own text fields (subject, sender,
    message body/preview, ...) into one blob for the AI condition check —
    generic over ANY app's payload shape rather than a fixed field list."""
    parts = []

    def _collect(value, depth=0):
        if depth > 3 or len(parts) > 40:
            return
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
        elif isinstance(value, dict):
            for v in value.values():
                _collect(v, depth + 1)
        elif isinstance(value, list):
            for v in value[:5]:
                _collect(v, depth + 1)

    _collect(payload)
    return " | ".join(parts)


def _event_matches_intent(payload, event_target: str | None, intent_description: str | None) -> bool:
    """Whether an incoming event should actually fire this agent's reaction
    steps. With no filter at all ("any message"), everything matches — this
    is what "detect any message from any account" means. With a filter
    (e.g. "subject containing 'New Lead' or 'Pricing'"), no one actually
    types their filter as a literal exact string in real messages, so this
    uses an AI judge over the event's own content against the user's
    plain-language condition (see composio_engine.ai_content_matches_
    condition) instead of exact/substring matching — handles wording
    variation for ANY app's payload, not just email subjects.
    """
    condition = intent_description
    if not condition:
        return True
    return ai_content_matches_condition(condition, _payload_text_blob(payload))


async def _dispatch_event(agent_id: str, user_id: str, toolkit_slug: str, payload):
    # Imported lazily to avoid a circular import (orchestrator doesn't need
    # to know about trigger_engine at module load time).
    from app.services.composio_engine import normalize_trigger_payload
    from app.services.orchestrator import run_agent_workflow

    try:
        info = _active_agents.get(agent_id) or {}
        if not _event_matches_intent(payload, info.get("event_target"), info.get("intent_description")):
            await telemetry_manager.send_log(
                agent_id, "Event received but didn't match this agent's watched condition — skipping.", level="info"
            )
            return

        await telemetry_manager.send_log(agent_id, "Event received — running reaction steps...", level="info")
        # Generic across every trigger-capable toolkit (Telegram, Gmail,
        # Slack, GitHub, ...) — no per-app branching here. Reaction steps get
        # {{trigger_result}} (message text), {{trigger_chat_id}} (sender),
        # and {{trigger_data}} (the full normalized payload) uniformly.
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


def start_event_trigger(
    agent_id: str,
    user_id: str,
    toolkit_slug: str,
    loop: asyncio.AbstractEventLoop,
    trigger_config: dict | None = None,
    event_target: str | None = None,
    intent_description: str | None = None,
) -> None:
    """Registers a live Composio event listener for `toolkit_slug`, scoped to
    `user_id`'s connected account. Delivery from Composio to us is
    push-based (Pusher) — no polling on our side — though Composio's own
    detection for most toolkits (Gmail included) is itself a periodic poll
    (2 minutes by default), so a real event can take a little while to
    surface even once everything is wired up correctly; see
    generate_sample_trigger_payload for a way to confirm the wiring works
    immediately instead of waiting on that.

    `event_target`/`intent_description` narrow which events actually fire
    this agent's reaction steps (see _event_matches_intent) — without
    either, every event from this toolkit for this account does.
    """
    trigger_slug = discover_trigger_slug(toolkit_slug, intent_description)
    trigger_instance = _ensure_trigger_instance(user_id, trigger_slug, trigger_config)
    subscription = _get_subscription()

    @subscription.handle(user_id=user_id, trigger_slug=trigger_slug)
    def _on_event(event):
        if agent_id not in _active_agents:
            return
            
        event_id = event.get("id") if isinstance(event, dict) else getattr(event, "id", None)
        if event_id and event_id != trigger_instance.trigger_id:
            # Another agent's trigger for the same user and app fired this event
            return
            
        payload = dict(event.get("payload") or {}) if hasattr(event, "get") else {}
        # Callback runs on Composio's own listener thread — hop back onto
        # the FastAPI event loop to run the (async) reaction steps.
        asyncio.run_coroutine_threadsafe(_dispatch_event(agent_id, user_id, toolkit_slug, payload), loop)

    _active_agents[agent_id] = {
        "user_id": user_id,
        "toolkit_slug": toolkit_slug,
        "trigger_slug": trigger_slug,
        "event_target": event_target,
        "intent_description": intent_description,
    }


def stop_event_trigger(agent_id: str) -> None:
    _active_agents.pop(agent_id, None)


def is_agent_active(agent_id: str) -> bool:
    return agent_id in _active_agents
