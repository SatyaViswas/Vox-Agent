import os
import asyncio
import json
import re
import traceback
from app.config import settings

from composio import Composio
from google import genai
from google.genai import types as genai_types

# Initialize Composio safely
composio = None
if settings.COMPOSIO_API_KEY:
    try:
        composio = Composio(api_key=settings.COMPOSIO_API_KEY)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to initialize Composio: {e}")

# A separate, minimal Gemini client used only to disambiguate a guessed
# action slug against a shortlist of an app's real tools (see
# _pick_best_action_via_ai) — kept local to this module rather than shared
# with planner.py's client since the two have no other coupling.
_gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

GUEST_USER_ID = "00000000-0000-0000-0000-000000000000"

GMAIL_SEND_ACTION_SLUG = "GMAIL_SEND_EMAIL"  # the real Composio tool slug — "GMAIL_SEND_AN_EMAIL" does not exist

GMAIL_ACTION_ALIASES = {
    "SEND_EMAIL": GMAIL_SEND_ACTION_SLUG,
    "FIND_MESSAGES": "GMAIL_FETCH_EMAILS",
    "SEARCH_MESSAGES": "GMAIL_FETCH_EMAILS",
    "GET_EMAILS": "GMAIL_FETCH_EMAILS",
    "SEARCH": "GMAIL_FETCH_EMAILS",
    "LIST_MESSAGES": "GMAIL_FETCH_EMAILS",
    "GMAIL_LIST_MESSAGES": "GMAIL_FETCH_EMAILS",
}

# Generic, app-agnostic English synonym groups used by
# _normalize_parameters_via_schema — NOT keyed by app or action name. The
# same buckets apply whether the target tool is Gmail, Telegram, Slack, or
# any of the other 1000+ Composio toolkits; which bucket actually fires
# depends entirely on what property names exist in that action's own JSON
# Schema (fetched live, see _get_action_schema), not on hardcoded knowledge
# of any specific app.
#
# Kept as two separate buckets rather than one merged "content-ish" bucket:
# a single free-text blob ("message"/"body"/"description") and a batch of
# structured records ("rows"/"items"/"data") are different shapes, and
# merging them let an unrelated single-string field (e.g. a tool's internal
# "normalization_message") get pulled in as an ambiguous second candidate
# whenever a planner-invented key like "row_data" was being matched against
# a real "rows" property — silently leaving "row_data" unmapped instead of
# resolving to the one real match. See _normalize_parameters_via_schema.
_GENERIC_PARAM_SYNONYM_BUCKETS = [
    {"to", "recipient", "recipient_email", "email", "chat_id", "user_id", "target", "destination", "channel", "phone_number", "phone", "address"},
    {"message", "content", "text", "body", "text_body", "message_text", "description", "commentary"},
    {"rows", "row", "values", "value", "data", "items", "records", "entries"},
    {"subject", "title", "heading", "summary"},
]


def _normalize_key_token(key: str) -> str:
    """Strips everything but letters/digits and lowercases — so a
    snake_case parameter the planner invented (e.g. "sheet_name") still
    matches a schema property in camelCase ("sheetName") or any other
    separator convention, instead of only matching an identical string."""
    return re.sub(r"[^a-z0-9]", "", key.lower())


_WORD_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+")


def _tokenize(key: str) -> set:
    """Splits a parameter name into lowercase words across snake_case,
    kebab-case, and camelCase/PascalCase boundaries — e.g. "row_data" ->
    {"row", "data"}, "spreadsheetId" -> {"spreadsheet", "id"}. Used for
    synonym-bucket matching so a compound key the planner invents (like
    "row_data" for a schema's plain "rows" property) still matches on
    whichever of its words is the meaningful one, instead of requiring the
    whole key to equal a bucket entry verbatim."""
    tokens = set()
    for part in re.split(r"[^A-Za-z0-9]+", key):
        if not part:
            continue
        words = _WORD_RE.findall(part) or [part]
        tokens.update(w.lower() for w in words)
    return tokens


_action_schema_cache: dict = {}


def _get_action_schema(action_name: str) -> dict | None:
    """Fetches (and caches) the live Composio JSON Schema for `action_name`'s
    input parameters, so parameter alignment reflects the real target tool
    instead of hardcoded per-app knowledge. Cached in-process since a given
    action's schema doesn't change between calls within a run."""
    if action_name in _action_schema_cache:
        return _action_schema_cache[action_name]
    if not composio:
        return None
    try:
        tools = composio.tools.get_raw_composio_tools(tools=[action_name])
        schema = tools[0].input_parameters if tools else None
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to fetch schema for '{action_name}': {e}")
        schema = None
    _action_schema_cache[action_name] = schema
    return schema


def _synonym_bucket_for_tokens(tokens: set) -> set | None:
    for bucket in _GENERIC_PARAM_SYNONYM_BUCKETS:
        if tokens & bucket:
            return bucket
    return None


def _coerce_value_type(value, prop_schema: dict):
    """Loosely aligns a value's type with what the schema declares — planner
    output is JSON but LLMs don't always match declared types exactly.

    Besides the usual stringified-number/boolean cases, a schema property
    typed `array` (e.g. Google Sheets' `rows`/`values`, expecting one row
    per array element) but handed something else gets wrapped into the
    shape the schema actually declares:
    - a bare scalar (the ordinary shape of a single {{item}} in a for_each
      fan-out) becomes one element for a flat array, or one row with one
      cell ([[value]]) when the array's own elements are themselves arrays;
    - a dict (the planner wrapping a value under a descriptive key, e.g.
      {"Caption": "{{item}}"} for a "rows" property — a common shape
      mismatch since the planner has no way to know the real tool wants a
      bare list, not a labeled object) gets flattened to its values as one
      row's cells, e.g. {"Caption": "hi"} -> ["hi"] (or [["hi"]] if the
      array is nested).
    This is what lets "one caption per row" work without the planner (or
    the user) needing to know that a given app's row-add tool wants a
    nested list rather than a plain string or object.
    """
    if not isinstance(prop_schema, dict):
        return value

    prop_type = prop_schema.get("type")
    types = prop_type if isinstance(prop_type, list) else [prop_type]

    if "array" in types:
        items_schema = prop_schema.get("items")
        is_nested_array = isinstance(items_schema, dict) and items_schema.get("type") == "array"

        if isinstance(value, list):
            # A batch call passing a whole prior step's result directly
            # (e.g. "rows": "{{step_1_result}}" — 5 AI-generated captions,
            # one call instead of 5 for_each calls) hands a flat list of
            # scalars/dicts where the schema wants one row PER element, not
            # one flat row. Only reshape when every element still needs it
            # (a plain flat list of strings/numbers, or a list of dicts);
            # a list that's already row-shaped (elements are themselves
            # lists) passes through untouched.
            if is_nested_array and value and not any(isinstance(v, list) for v in value):
                return [list(v.values()) if isinstance(v, dict) else [v] for v in value]
            return value

        if isinstance(value, dict):
            cells = list(value.values())
            return [cells] if is_nested_array else cells
        if is_nested_array:
            return [[value]]
        return [value]

    if not isinstance(value, str):
        return value
    if "integer" in types:
        try:
            return int(value)
        except ValueError:
            return value
    if "number" in types:
        try:
            return float(value)
        except ValueError:
            return value
    if "boolean" in types:
        if value.lower() in ("true", "false"):
            return value.lower() == "true"
    return value


def _resolve_schema_key(properties: dict, key: str) -> str | None:
    """Which property in `properties` a planner-invented parameter name
    `key` refers to, or None if it doesn't map onto exactly one of them.

    Resolution order: exact (case-insensitive, punctuation-insensitive)
    match to a schema property, then a generic synonym-bucket match (only
    when exactly one schema property also falls in the same bucket —
    ambiguous cases are left alone rather than guessed), then a
    substring/description-overlap fallback. Shared by
    _normalize_parameters_via_schema (aligning a whole parameters dict) and
    find_array_batch_param (checking a single for_each `{{item}}` key ahead
    of execution — see orchestrator.py's batching decision).
    """
    prop_names = list(properties.keys())
    target = {_normalize_key_token(p): p for p in prop_names}.get(_normalize_key_token(key))
    if target is not None:
        return target

    # Word-level match — e.g. "row_data" -> {"row","data"} overlaps a
    # bucket that "rows" also belongs to, even though neither string
    # contains the other. Only trusted when it narrows to exactly one
    # property; more than one keeps the key unmapped rather than guessing
    # which one the planner meant.
    prop_word_tokens = {p: _tokenize(p) for p in prop_names}
    key_tokens = _tokenize(key)
    bucket = _synonym_bucket_for_tokens(key_tokens)
    if bucket:
        candidates = [p for p in prop_names if prop_word_tokens[p] & bucket]
        if len(candidates) == 1:
            return candidates[0]
        elif len(candidates) > 1:
            exact_matches = [p for p in candidates if _normalize_key_token(p) in bucket]
            if len(exact_matches) == 1:
                return exact_matches[0]
            
    candidates = []
    if not candidates:
        lowered = key.lower()
        for p in prop_names:
            p_lower = p.lower()
            description = str(properties.get(p, {}).get("description") or "").lower()
            if lowered in p_lower or p_lower in lowered or (lowered and lowered in description):
                candidates.append(p)
    return candidates[0] if len(candidates) == 1 else None


def _normalize_parameters_via_schema(action_name: str, parameters: dict) -> dict:
    """Aligns the planner's loosely-named step parameters onto whatever
    parameter names `action_name` actually expects, by inspecting that
    action's live Composio JSON Schema — replaces per-app alias tables so
    any of Composio's 1000+ tools work without hardcoded mapping. Unmatched
    keys pass through unchanged; if that means a required field is genuinely
    missing, Composio's own schema validation catches it and the caller
    turns that into a human-clarification pause rather than a silent
    failure (see execute_composio_action).
    """
    schema = _get_action_schema(action_name)
    properties = (schema or {}).get("properties") or {}
    if not properties or not parameters:
        return dict(parameters or {})

    normalized = {}
    for key, value in (parameters or {}).items():
        final_key = _resolve_schema_key(properties, key) or key
        normalized[final_key] = _coerce_value_type(value, properties.get(final_key, {}))

    return normalized


def find_array_batch_param(app: str, action: str, item_keys: list) -> str | None:
    """Read-only introspection (no execution) used by the orchestrator to
    decide, ahead of running a for_each step, whether the destination wants
    ONE call per item (a scalar field, e.g. an email body) or the WHOLE
    batch in a single call (an array field, e.g. a spreadsheet's `rows`) —
    see orchestrator._maybe_run_for_each_as_batch. Checks whether any of
    `item_keys` (the raw parameter keys whose value is the bare `{{item}}`
    placeholder) would resolve, via the same matching _normalize_parameters
    _via_schema uses, onto one of the real target action's array-typed
    properties. Returns that property's real key if so, else None — the
    for_each step should keep looping one call per item exactly as before.
    """
    if not composio:
        return None
    resolved_action = _resolve_action_slug(app, (action or "").upper().strip())
    schema = _get_action_schema(resolved_action)
    properties = (schema or {}).get("properties") or {}
    if not properties:
        return None

    for key in item_keys:
        target = _resolve_schema_key(properties, key)
        if target and (properties.get(target) or {}).get("type") == "array":
            return target
    return None


def _normalize_gmail_action(action_name: str) -> str:
    """Map common Gmail action aliases onto the standard Composio action slug."""
    return GMAIL_ACTION_ALIASES.get(action_name, action_name)


_resolved_action_cache: dict = {}


def _resolve_action_slug(app: str, action_name: str) -> str:
    """The planner guesses an action slug from the app's display name using
    Composio's {APPNAME}_{VERB}_{OBJECT} convention (see planner.py), but
    that's a best-effort guess, not a guarantee — e.g. it's easy to guess
    "GOOGLE_SHEETS_APPEND_ROW" when the real toolkit slug is "googlesheets"
    (no underscore), so the real tool is "GOOGLESHEETS_APPEND_ROW" (or
    something else entirely; Composio's verb/object naming isn't always
    predictable). Rather than hardcode fixes per app, self-correct generically:
    if the guessed slug isn't a real tool, search the app's own toolkit for
    the closest real match by the guessed verb/object words and use that
    instead — the same "ask Composio what's actually there" approach already
    used for parameter alignment (_normalize_parameters_via_schema).
    """
    if action_name in _resolved_action_cache:
        return _resolved_action_cache[action_name]
    if not composio:
        return action_name

    if _get_action_schema(action_name):
        # The guess is already a real tool — nothing to resolve.
        _resolved_action_cache[action_name] = action_name
        return action_name

    toolkit_slug = _slugify_app(app)
    search_words = action_name.replace("_", " ").strip()
    try:
        candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], search=search_words, limit=8)
        if not candidates:
            candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], limit=40)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to search tools for toolkit '{toolkit_slug}' while resolving '{action_name}': {e}")
        _resolved_action_cache[action_name] = action_name
        return action_name

    if not candidates:
        _resolved_action_cache[action_name] = action_name
        return action_name

    # Composio's own search ranking is keyword-based and unreliable for this
    # (it can rank e.g. "ADD_SHEET" above the real "append a row of data"
    # tool just because both contain "ADD") — a real tool's own description
    # says what it actually does, so let a focused AI call pick from the
    # shortlist by intent rather than trusting search order or string
    # similarity. Falls back to the top search result if that call fails.
    resolved_name = _pick_best_action_via_ai(action_name, candidates) or candidates[0].slug
    if resolved_name != action_name:
        print(f"Info: Resolved guessed action '{action_name}' to real tool '{resolved_name}' for toolkit '{toolkit_slug}'.")
    _resolved_action_cache[action_name] = resolved_name
    return resolved_name


def _pick_best_action_via_ai(guessed_action: str, candidates: list) -> str | None:
    """Disambiguates a guessed action slug against a shortlist of an app's
    real tools by intent, using each candidate's own description — far more
    reliable than slug/keyword similarity (see _resolve_action_slug)."""
    if not _gemini_client or not candidates:
        return None

    listing = "\n".join(f"- {c.slug}: {(getattr(c, 'description', None) or '')[:220]}" for c in candidates)
    prompt = (
        f"An automation planner guessed the action \"{guessed_action}\", but that exact tool doesn't exist. "
        f"Here are the real tools available for this app:\n{listing}\n\n"
        "Which ONE tool slug best matches the guessed action's intent? Respond with ONLY that exact slug and "
        "nothing else. If none of them are a reasonable match, respond with NONE."
    )
    try:
        response = _gemini_client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        picked = (response.text or "").strip().strip('"').strip()
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: AI action-resolution call failed for '{guessed_action}': {e}")
        return None

    valid_slugs = {c.slug for c in candidates}
    return picked if picked in valid_slugs else None


def ai_pick_best_match(context: str, candidates: list) -> str | None:
    """General-purpose version of the disambiguation _pick_best_action_via_ai
    does for action slugs — given a situation described in `context` and a
    list of (slug, description) options, asks a quick AI call to pick the
    one that best fits. Used by trigger_engine.py to pick the right trigger
    type when a toolkit exposes more than one (e.g. Gmail's "message sent"
    vs "message received" — blindly taking the first one silently arms the
    wrong listener)."""
    if not _gemini_client or not candidates:
        return None

    listing = "\n".join(f"- {slug}: {(desc or '')[:220]}" for slug, desc in candidates)
    prompt = f"{context}\n\nOptions:\n{listing}\n\nRespond with ONLY the single best slug, nothing else. If none fit, respond NONE."
    try:
        response = _gemini_client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        picked = (response.text or "").strip().strip('"').strip()
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: AI disambiguation call failed: {e}")
        return None

    valid = {slug for slug, _ in candidates}
    return picked if picked in valid else None


def ai_content_matches_condition(condition: str, content: str) -> bool:
    """Whether `content` (an incoming event's own text — subject, sender,
    body/preview, ...) satisfies a plain-language `condition` the user
    described (e.g. "subject containing 'New Lead' or 'Pricing'") — used to
    filter which events actually fire an event-triggered agent's reaction
    steps (see trigger_engine._event_matches_intent). An AI judge handles
    real-world variation (case, wording, "Re: New Lead", "new lead inquiry"
    vs the literal phrase "New Lead") that exact or substring matching would
    silently miss, for ANY app's event content, not just email subjects.
    Fails open (returns True) if no AI is configured or the call errors —
    a wrong-but-visible run is better than a real event silently vanishing.
    """
    if not _gemini_client:
        return True
    prompt = (
        f"An automation should only fire when this condition is met: \"{condition}\".\n"
        f"An event just arrived with this content: \"{content[:1500]}\"\n\n"
        "Does this event satisfy that condition? Consider reasonable real-world variation in wording, "
        "capitalization, or phrasing (e.g. \"New Lead\" should match \"new lead inquiry\", \"RE: New lead\", "
        "\"NEW LEAD\", etc.) rather than requiring an exact literal match. Respond with ONLY YES or NO."
    )
    try:
        response = _gemini_client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        answer = (response.text or "").strip().upper()
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Event-condition match check failed, letting the event through: {e}")
        return True
    return answer.startswith("Y")


_TRIGGER_TEXT_KEYS = ("text", "body", "content", "message_text", "description")
_TRIGGER_SENDER_KEYS = ("chat_id", "sender", "sender_id", "from", "user_id", "author", "recipient")


def normalize_trigger_payload(payload) -> dict:
    """Extracts a standard `{message_text, sender, payload_data}` shape out
    of ANY app's event trigger payload — Telegram, Gmail, Slack, GitHub,
    etc. — using generic structural heuristics (a nested "message"/"chat"
    object, common field-name synonyms) instead of per-app branching, so
    new trigger-capable toolkits work without new code here.
    """
    if not isinstance(payload, dict):
        return {"message_text": str(payload) if payload is not None else "", "sender": None, "payload_data": payload}

    # Many chat-style payloads nest the actual message under a "message" key
    # (Telegram's Bot API update shape being the canonical example) — look
    # there first, then fall back to the top-level payload.
    message = payload.get("message") if isinstance(payload.get("message"), dict) else payload

    message_text = None
    for key in _TRIGGER_TEXT_KEYS:
        value = message.get(key)
        if isinstance(value, str) and value:
            message_text = value
            break
    if message_text is None:
        for key in _TRIGGER_TEXT_KEYS:
            value = payload.get(key)
            if isinstance(value, str) and value:
                message_text = value
                break
    if message_text is None:
        import json
        message_text = json.dumps(payload)

    sender = None
    chat = message.get("chat") if isinstance(message.get("chat"), dict) else None
    if chat is not None:
        sender = chat.get("id")
    if sender is None:
        for key in _TRIGGER_SENDER_KEYS:
            if message.get(key) is not None:
                sender = message[key]
                break
    if sender is None:
        for key in _TRIGGER_SENDER_KEYS:
            if payload.get(key) is not None:
                sender = payload[key]
                break

    return {"message_text": message_text or "", "sender": sender, "payload_data": payload}


def generate_sample_trigger_payload(blueprint: dict) -> dict:
    """Synthesizes a realistic fake event for a "test this trigger now" run
    (see execution.py's /execute/{agent_id}) — matching the specific
    automation's own watched condition and reaction steps well enough to
    genuinely exercise them, instead of a generic placeholder string that
    would fail whatever real extraction the reaction steps do (e.g. "pull
    the contact name/email/company from the body"). This is what gives a
    user real confirmation an event-triggered agent actually works, without
    waiting on a real external event (which, for a polling-based Composio
    trigger, can also take a couple of minutes even once it does happen).

    Returns the same `{message_text, sender, payload_data}` shape
    normalize_trigger_payload produces from a real event, so it feeds into
    run_agent_workflow identically either way.
    """
    trigger = blueprint.get("trigger") or {}
    condition = trigger.get("details") or trigger.get("event_target") or "any event"
    fallback = {
        "message_text": f"[TEST RUN] Sample event content for: {condition}",
        "sender": "test-run@example.com",
        "payload_data": {"is_test": True, "subject": "[TEST RUN]", "sender": "test-run@example.com"},
    }
    if not _gemini_client:
        return fallback

    steps_summary = "; ".join(
        f"{s.get('app')}: {s.get('action')} (parameters: {s.get('parameters')})" for s in blueprint.get("steps", [])
    ) or "no reaction steps defined"
    prompt = (
        f"An automation watches '{trigger.get('event_app') or 'an app'}' for this condition: \"{condition}\".\n"
        f"When it fires, these steps run using the event's own content: {steps_summary}\n\n"
        "Generate ONE realistic sample event that would satisfy this condition and give those steps something "
        "meaningful to work with (e.g. if a step extracts a name/email/company from the content, include "
        "believable ones in the body). Respond with ONLY a JSON object with these keys: \"subject\" (string, "
        "or null if not applicable), \"sender\" (a realistic email address or username), \"message_text\" "
        "(the body/content — a few sentences, containing whatever the reaction steps need to extract)."
    )
    try:
        response = _gemini_client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(response_mime_type="application/json", temperature=0.6),
        )
        data = json.loads(response.text)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to generate a sample trigger payload, using a generic placeholder instead: {e}")
        return fallback

    message_text = data.get("message_text") or fallback["message_text"]
    sender = data.get("sender") or fallback["sender"]
    payload_data = {"is_test": True, "subject": data.get("subject"), "sender": sender, "message_text": message_text}
    return {"message_text": f"[TEST RUN] {message_text}", "sender": sender, "payload_data": payload_data}


def _candidate_user_ids(user_id: str) -> list:
    """Identifiers to try, in order, when looking up or executing under Composio.

    Guest sessions used to be tracked under the literal string "default" before
    the frontend switched to a UUID sentinel for guests. Try both so accounts
    connected under either identity keep working.
    """
    candidates = [user_id] if user_id else []
    if not user_id or user_id == GUEST_USER_ID:
        if "default" not in candidates:
            candidates.append("default")
    return candidates or ["default"]


def _slugify_app(app: str) -> str:
    return "".join(ch for ch in (app or "").lower() if ch.isalnum())


_AUTH_ERROR_HINTS = (
    "expired",
    "unauthorized",
    "not connected",
    "no connected account",
    "no active connection",
    "invalid_grant",
    "invalid credentials",
    "reauthenticate",
    "re-authenticate",
    "revoked",
    "token",
    "forbidden",
)

# A 403 from Composio can mean two very different things: the specific
# connected account's OAuth token expired/was revoked (the user needs to
# reconnect that one app), or this backend's own Composio API key was never
# granted "tool_execution" permission at all — an account-wide dashboard
# setting that has nothing to do with any particular app's connection
# status. Treating every 403 as "reconnect this app" (the old behavior)
# sent users chasing a Gmail reconnect when Gmail was fine and the real
# problem was the API key itself lacking execute access.
_API_KEY_PERMISSION_HINTS = (
    "apikey_insufficientpermissions",
    "does not have the permissions required",
    "insufficient permissions",
)


def _looks_like_api_key_permission_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in _API_KEY_PERMISSION_HINTS)

def _is_auth_error_text(text: str) -> bool:
    text = (text or "").lower()
    return any(hint in text for hint in _AUTH_ERROR_HINTS) and not any(hint in text for hint in _API_KEY_PERMISSION_HINTS)

def _looks_like_auth_error(exc: Exception) -> bool:
    """Heuristic: Composio raises a handful of different exception types
    (APIStatusError subclasses, connector-specific errors, etc.) when a
    connected account's token has expired or been revoked, with no single
    exception type covering every case. Check the HTTP status code where
    present, and otherwise pattern-match the message text — but only after
    ruling out an API-key permission error, which also surfaces as a 403."""
    if _looks_like_api_key_permission_error(exc):
        return False
    status_code = getattr(exc, "status_code", None)
    if status_code in (401, 403):
        return True
    return _is_auth_error_text(str(exc))


def _friendly_auth_message(app: str) -> str:
    return f"{app} connection has expired or was disconnected. Reconnect it in App Vault."


def _friendly_permission_message(action_name: str) -> str:
    return (
        f"The Composio API key doesn't have \"tool_execution\" permission, so it can't run '{action_name}'. "
        "Grant that key write access to tool_execution in the Composio dashboard (API Keys) and try again."
    )


def _tool_result_unsuccessful(result) -> bool:
    successful = result.get("successful") if isinstance(result, dict) else getattr(result, "successful", None)
    return successful is False


def _tool_error_message(result) -> str:
    if isinstance(result, dict):
        err = result.get("error")
        if err:
            return str(err)
        data = result.get("data")
        if isinstance(data, dict) and data.get("message"):
            return str(data["message"])
    else:
        err = getattr(result, "error", None)
        if err:
            return str(err)
    return "The request was rejected by the target app."


def _guess_missing_field(action_name: str, parameters: dict) -> str | None:
    """Picks the single most useful missing required field to ask about
    next, so resume can drop the user's answer straight into it instead of
    an opaque "clarification_answer" the target tool's schema wouldn't
    recognize.

    Two filters narrow "several fields missing at once" down to one:
    - An array-typed field (e.g. Google Sheets' `rows`) is never chosen —
      a free-text popup answer has no sane way to fill a 2D array, and this
      kind of field is meant to be populated structurally (from a
      for_each's {{item}}, see orchestrator.py) rather than typed in by
      hand. If it's still missing after that, asking the user for literal
      row data would be actively worse than the generic fallback question.
    - Among what's left, an id-shaped field takes priority — it's the one
      _auto_resolve_missing_ids can actually resolve from a name, so
      asking for it first is more likely to clear the whole failure in one
      round; a plain field only "wins" when it's the *only* thing left,
      where the answer maps unambiguously.
    """
    schema = _get_action_schema(action_name)
    required = (schema or {}).get("required") or []
    properties = (schema or {}).get("properties") or {}
    missing = [r for r in required if r not in (parameters or {})]
    if not missing:
        return None

    # No `pool = askable or missing` fallback: if every remaining required
    # field is array-typed, there is genuinely nothing sane to ask for in a
    # free-text popup — returning None here (rather than re-admitting an
    # array field once it's the only one left) means the caller falls back
    # to a generic error instead of asking a non-technical user to type a
    # 2D array of row data.
    askable = [m for m in missing if (properties.get(m) or {}).get("type") != "array"]
    if not askable:
        return None

    id_missing = [m for m in askable if _looks_like_id_field(m)]
    if id_missing:
        return id_missing[0]
    return askable[0]


def _looks_like_id_field(prop_name: str) -> bool:
    return _normalize_key_token(prop_name).endswith("id")


def _looks_like_opaque_id(value) -> bool:
    """Heuristic for "this is already a real ID", not a name a person typed
    — Google/Composio-style resource IDs are long, unspaced alphanumeric
    tokens (e.g. a 44-character Sheets ID), unlike a human-readable name."""
    if not isinstance(value, str):
        return False
    value = value.strip()
    if value.lower() in ("primary", "me"):
        return True
    if value.startswith("urn:"):
        return True
    if re.fullmatch(r"[CGDU][A-Z0-9]{8,10}", value):
        return True
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{15,}", value))


_search_tool_cache: dict = {}


def _find_search_tool(toolkit_slug: str):
    """Looks for this toolkit's own "search/find by name" tool, following
    Composio's common SEARCH_*/FIND_*_BY_* naming convention (e.g.
    GOOGLESHEETS_SEARCH_SPREADSHEETS) — used to resolve a human-typed name
    into the opaque ID a real API call actually needs, instead of ever
    asking the user to go find and paste that ID themselves. Generic across
    every toolkit that follows the convention; toolkits that don't just
    fall back to the existing clarification-question pause."""
    if toolkit_slug in _search_tool_cache:
        return _search_tool_cache[toolkit_slug]
    if not composio:
        return None
    try:
        candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], search="search by name", limit=10)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to look up a search tool for toolkit '{toolkit_slug}': {e}")
        candidates = []

    tool = next((c for c in candidates if "SEARCH" in c.slug or "FIND" in c.slug), None)
    _search_tool_cache[toolkit_slug] = tool
    return tool


def _search_tool_query_param(search_tool) -> str | None:
    props = (search_tool.input_parameters or {}).get("properties") or {}
    for key in ("query", "name", "title", "search", "q", "search_query"):
        if key in props:
            return key
    required = (search_tool.input_parameters or {}).get("required") or []
    return next((r for r in required if props.get(r, {}).get("type") == "string"), None)


def _list_search_tool_items(result) -> list:
    """Generic extraction over ANY search-tool result shape: the first list
    of result objects found in the response, regardless of what key it's
    nested under — no per-app knowledge of what that search tool's response
    looks like."""
    data = result.get("data") if isinstance(result, dict) else getattr(result, "data", None)
    if not isinstance(data, dict):
        return []
    return next(
        (v for v in data.values() if isinstance(v, list) and v and all(isinstance(i, dict) for i in v)),
        [],
    )


def _item_id(item: dict) -> str | None:
    for key in ("id", "spreadsheetId", "file_id", "fileId"):
        if item.get(key):
            return str(item[key])
    return None


def _extract_named_id(result, name: str) -> str | None:
    """Picks whichever search result's name/title best matches `name`
    (falling back to the first result) and returns its id-shaped field."""
    items = _list_search_tool_items(result)
    if not items:
        return None

    lowered_name = name.strip().lower()
    best = next(
        (item for item in items if lowered_name and lowered_name in str(item.get("name") or item.get("title") or "").lower()),
        items[0],
    )
    return _item_id(best)


async def _auto_resolve_missing_ids(app: str, action_name: str, parameters: dict, entity_id: str) -> tuple:
    """Before ever asking the user for an opaque ID they'd have no way to
    know off the top of their head (a raw Google Sheets spreadsheet ID, a
    Slack channel ID, ...), try resolving it ourselves: if a required
    "*Id"-shaped field is missing, or holds a plain name instead of a real
    ID (the case right after a clarification answer came back as a name —
    see the friendlier wording in _build_execution_result), look for a
    plain-name value elsewhere among the supplied parameters and resolve it
    via the toolkit's own search tool (see _find_search_tool). When there's
    no name to search by at all, lists everything the search tool can see
    instead and auto-picks it if there's exactly one — a user with a single
    connected Google Sheet, for instance, should never be asked which one
    to use.

    Returns `(parameters, not_found_hint)`. `not_found_hint` is None on the
    common paths; it's set to `{"field": ..., "name": ...}` specifically
    when the user-supplied name was searched for and came back with zero
    results — in that case the bad name is also DROPPED from the returned
    parameters (not left in place), because passing it straight through to
    the real API would just produce a raw, confusing 404 instead of a clear
    "couldn't find X" — see _build_execution_result, which turns this hint
    into that message and re-asks instead.
    """
    schema = _get_action_schema(action_name)
    required = (schema or {}).get("required") or []
    properties = (schema or {}).get("properties") or {}

    target_field = next(
        (
            r for r in required
            if _looks_like_id_field(r)
            and (r not in parameters or (isinstance(parameters.get(r), str) and not _looks_like_opaque_id(parameters[r])))
        ),
        None,
    )
    if not target_field:
        return parameters, None

    toolkit_slug = _slugify_app(app)
    search_tool = _find_search_tool(toolkit_slug)
    if not search_tool or not composio:
        return parameters, None

    existing_value = parameters.get(target_field)
    if isinstance(existing_value, str) and existing_value.strip():
        # A resumed run where the user answered our "what's it called?"
        # clarification with a name rather than the ID we never showed them.
        name_value = existing_value
    else:
        name_value = next(
            (
                v for k, v in parameters.items()
                if k != target_field and k not in properties and isinstance(v, str) and v.strip() and not _looks_like_opaque_id(v)
            ),
            None,
        )

    query_param = _search_tool_query_param(search_tool)

    if not name_value:
        # No name to search by at all — rather than immediately asking the
        # user, check whether there's only ONE item to begin with (e.g. a
        # user with a single connected Google Sheet). If so, there's nothing
        # to disambiguate and no reason to ask; only fall back to the
        # clarification pause when there's real ambiguity (0 or 2+ items).
        try:
            listing = await asyncio.to_thread(
                composio.tools.execute,
                slug=search_tool.slug,
                arguments={query_param: ""} if query_param else {},
                user_id=entity_id,
                dangerously_skip_version_check=True,
            )
        except Exception as e:
            traceback.print_exc()
            print(f"Warning: Auto-resolve listing via '{search_tool.slug}' failed: {e}")
            return parameters, None

        items = _list_search_tool_items(listing)
        if len(items) != 1:
            return parameters, None
        resolved_id = _item_id(items[0])
        if not resolved_id:
            return parameters, None
        print(f"Info: Only one {app} item exists — auto-selected '{resolved_id}' via '{search_tool.slug}' without asking.")
        updated = dict(parameters)
        updated[target_field] = resolved_id
        return updated, None

    try:
        result = await asyncio.to_thread(
            composio.tools.execute,
            slug=search_tool.slug,
            arguments={query_param: name_value} if query_param else {},
            user_id=entity_id,
            dangerously_skip_version_check=True,
        )
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Auto-resolve search via '{search_tool.slug}' failed: {e}")
        return parameters, None

    resolved_id = _extract_named_id(result, name_value)
    if not resolved_id:
        print(f"Info: Searched for '{app}' item named \"{name_value}\" via '{search_tool.slug}' — found nothing.")
        updated = dict(parameters)
        updated.pop(target_field, None)
        return updated, {"field": target_field, "name": name_value}

    print(f"Info: Auto-resolved '{target_field}' to '{resolved_id}' via '{search_tool.slug}' search for \"{name_value}\".")
    updated = dict(parameters)
    updated[target_field] = resolved_id
    return updated, None


def _sibling_name_field(schema: dict, id_field: str) -> str | None:
    """If the schema ALSO requires a separate human-named sub-item field
    alongside `id_field` — e.g. Google Sheets' spreadsheetId (the file) plus
    sheetName (a tab inside it) — name it so the id-field question can
    disambiguate "the container itself" from "something inside it" instead
    of leaving the user to guess which name is wanted. Without this, a user
    asked "which Google Sheets item?" naturally answers with whichever name
    they know — often the tab name ("Sheet1") — which then fails to resolve
    as the spreadsheet file it's actually being used for.
    """
    required = (schema or {}).get("required") or []
    properties = (schema or {}).get("properties") or {}
    for r in required:
        if r == id_field or _looks_like_id_field(r):
            continue
        if (properties.get(r) or {}).get("type") == "string":
            return r
    return None


def _build_execution_result(result, app: str, action_name: str, parameters: dict, not_found_hint: dict | None = None) -> dict:
    """Composio's tools.execute doesn't always raise on failure — a schema
    validation error (missing/invalid field) comes back as a normal return
    value with `successful: False` rather than an exception. Treating that
    as a success (the old behavior) silently swallowed real failures; this
    instead surfaces it as a clarification pause — the same mechanism used
    for an LLM's own "which platform did you mean?" response — so the user
    can supply whatever Composio's own schema says is missing/invalid,
    without any app-specific error parsing.

    `not_found_hint` (see _auto_resolve_missing_ids) names a value that was
    already searched for by name and came up empty — when the id-field
    question fires for that same field, it's worth saying plainly what was
    searched for and not found, instead of just repeating the same question
    and leaving the user to guess why their last answer didn't work.
    """
    if _tool_result_unsuccessful(result):
        error_text = _tool_error_message(result)
        
        if _is_auth_error_text(error_text):
            return {"status": "error", "error": "auth_error", "reconnect_app": app}
            
        schema = _get_action_schema(action_name)
        properties = (schema or {}).get("properties") or {}
        missing_field = _guess_missing_field(action_name, parameters)
        field_description = (properties.get(missing_field) or {}).get("description") if missing_field else None

        if missing_field and _looks_like_id_field(missing_field):
            # _auto_resolve_missing_ids already tried and failed to resolve
            # this by name — ask in the same terms rather than surfacing the
            # raw ID field name, which the user would have no way to answer.
            sibling = _sibling_name_field(schema, missing_field)
            exists_note = "It needs to already exist — I can't create one for you."
            not_found_note = ""
            if not_found_hint and not_found_hint.get("field") == missing_field:
                not_found_note = f" I looked for one named \"{not_found_hint.get('name')}\" and couldn't find it — double check the exact spelling, and that it exists in the same {app} account connected to VoxAgent."
            if sibling:
                sibling_label = (properties.get(sibling) or {}).get("title") or sibling
                question = (
                    f"Which {app} item should this use? I mean the item itself, not the \"{sibling_label}\" "
                    f"inside it (that's a separate question if needed) — just tell me its exact name, no need to look up any ID. {exists_note}{not_found_note}"
                )
            else:
                question = f"Which {app} item should this use? Just tell me its exact name — no need to look up any ID. {exists_note}{not_found_note}"
        elif missing_field:
            friendly_name = missing_field.replace("_", " ").title()
            if field_description:
                desc = field_description.split(".")[0]
                question = f"To continue with {app}, please provide the {friendly_name} ({desc})."
            else:
                question = f"To continue with {app}, please provide a value for {friendly_name}."
        else:
            # _guess_missing_field deliberately returns None when every
            # remaining required field is array-typed (e.g. Google Sheets'
            # `rows`) — there's no sane free-text answer for "give me a 2D
            # array", and looping the user into another unanswerable
            # question is worse than stopping. This is a workflow-wiring
            # problem (the step producing this data isn't actually feeding
            # it into this parameter), not something the end user typed
            # wrong, so it's surfaced as a hard failure instead of a pause.
            required = (schema or {}).get("required") or []
            unresolved_array_fields = [
                r for r in required
                if r not in (parameters or {}) and (properties.get(r) or {}).get("type") == "array"
            ]
            if unresolved_array_fields:
                error_text = (
                    f"{app}'s {action_name} is missing '{', '.join(unresolved_array_fields)}', which this workflow "
                    "never supplied — the step producing that data isn't reaching this one. This isn't something "
                    "you can fix by typing an answer; the workflow itself needs to be reconfigured."
                )
            
            return {"status": "error", "error": error_text, "message": error_text}

        return {
            "status": "needs_input",
            "question": question,
            "error": error_text,
            "missing_field": missing_field,
        }
    return {"status": "success", "output": result}


def resolve_connected_user_id(user_id: str, app: str) -> str:
    """Pick which identifier to execute/connect under for `app`.

    Prefers whichever of `user_id` / "default" already has an active
    connected account for this app, so we don't silently miss a connection
    that was created under the other identity. Falls back to `user_id`
    itself (or "default") if the lookup can't determine an active match —
    this is a best-effort heuristic, never a hard requirement to execute.
    """
    candidates = _candidate_user_ids(user_id)
    if not composio or len(candidates) == 1:
        return candidates[0]

    slug = _slugify_app(app)
    for candidate in candidates:
        try:
            accounts = composio.connected_accounts.list(
                user_ids=[candidate],
                toolkit_slugs=[slug] if slug else None,
                statuses=["ACTIVE"],
            )
            if list(getattr(accounts, "items", accounts) or []):
                return candidate
        except Exception as e:
            traceback.print_exc()
            print(f"Warning: Failed to check connected accounts for '{candidate}': {e}")
            continue

    return candidates[0]


async def execute_composio_action(app: str, action: str, parameters: dict, entity_id: str = "default") -> dict:
    if not composio:
        return {"status": "error", "error": "COMPOSIO_API_KEY is not configured or Composio client is uninitialized.", "message": "COMPOSIO_API_KEY is not configured or Composio client is uninitialized."}

    action_name = action.upper().strip()
    if action_name == "GITHUB_GET_ABOUT_THE_AUTHENTICATED_USER":
        action_name = "GITHUB_GET_THE_AUTHENTICATED_USER"
    action_name = _normalize_gmail_action(action_name)
    action_name = _resolve_action_slug(app, action_name)

    parameters = _normalize_parameters_via_schema(action_name, parameters)
    entity_id = resolve_connected_user_id(entity_id, app)
    parameters, not_found_hint = await _auto_resolve_missing_ids(app, action_name, parameters, entity_id)

    if action_name == "GMAIL_FETCH_EMAILS" and "max_results" not in parameters:
        parameters["max_results"] = 100

    if action_name in ("LINKEDIN_CREATE_POST", "LINKEDIN_CREATE_LINKED_IN_POST") and "author" not in (parameters or {}):
        try:
            profile = await asyncio.to_thread(
                composio.tools.execute,
                slug="LINKEDIN_GET_MY_INFO",
                arguments={},
                user_id=entity_id,
                dangerously_skip_version_check=True
            )
            data = profile.get("data", {}) if hasattr(profile, "get") else getattr(profile, "data", {})
            if isinstance(data, dict) and "response_data" in data:
                data = data.get("response_data", {}) or {}
            
            urn = data.get("id") or data.get("urn")
            if urn and not str(urn).startswith("urn:li:person:"):
                urn = f"urn:li:person:{urn}"
            if urn:
                parameters["author"] = str(urn)
        except Exception as e:
            print(f"Warning: Failed to fetch LinkedIn profile for author auto-resolution: {e}")


    try:
        result = await asyncio.to_thread(
            composio.tools.execute,
            slug=action_name,
            arguments=parameters or {},
            user_id=entity_id,
            dangerously_skip_version_check=True
        )
        if action_name == "GMAIL_FETCH_EMAILS":
            if isinstance(result, dict) and "data" in result and isinstance(result["data"], dict):
                messages = result["data"].get("messages", [])
                if isinstance(messages, list):
                    for msg in messages:
                        if isinstance(msg, dict):
                            # Remove the massive raw payload to save tokens (we already have messageText)
                            msg.pop("payload", None)
                            msg.pop("raw", None)
        
        return _build_execution_result(result, app, action_name, parameters, not_found_hint)
    except Exception as e:
        traceback.print_exc()
        if _looks_like_api_key_permission_error(e):
            error_message = _friendly_permission_message(action_name)
            return {"status": "error", "error": error_message, "message": error_message}
        if _looks_like_auth_error(e):
            # A disconnected/expired app is recoverable mid-run — connecting
            # it in App Vault and retrying fixes it — so this pauses the
            # workflow the same way a missing parameter does (reusing the
            # exact same clarification popup, see orchestrator.py) instead
            # of hard-failing the whole run. "reconnect_app" lets the
            # frontend show a "Connect {app}" action instead of a bare text
            # box, though answering with anything and retrying also works
            # once the app is actually reconnected elsewhere.
            return {
                "status": "needs_input",
                "question": f"{app} isn't connected right now. Connect it in App Vault, then answer here (anything) to retry.",
                "error": _friendly_auth_message(app),
                "missing_field": None,
                "reconnect_app": app,
            }
        error_message = str(e)
        return {"status": "error", "error": error_message, "message": error_message}


def list_composio_apps(search: str | None = None, cursor: str | None = None, limit: int = 30) -> dict:
    """Dynamically fetches Composio's real toolkit catalog (1000+ apps)
    instead of a hardcoded subset. Uses the raw client directly — the
    high-level `composio.toolkits.list()` wrapper doesn't expose `search`,
    but the underlying REST resource it wraps does."""
    if not composio:
        return {"apps": [], "next_cursor": None, "total_items": 0}

    kwargs = {"limit": limit}
    if search:
        kwargs["search"] = search
    if cursor:
        kwargs["cursor"] = cursor

    response = composio.toolkits._client.toolkits.list(**kwargs)
    items = list(getattr(response, "items", response) or [])

    apps = []
    for item in items:
        meta = getattr(item, "meta", None)
        categories = getattr(meta, "categories", None) if meta else None
        category = categories[0].name if categories else "Other"
        logo = getattr(meta, "logo", None) if meta else None
        apps.append({
            "slug": item.slug,
            "name": item.name,
            "category": category,
            "logo": logo or f"https://logos.composio.dev/api/{item.slug}",
        })

    return {
        "apps": apps,
        "next_cursor": getattr(response, "next_cursor", None),
        "total_items": getattr(response, "total_items", len(apps)),
    }


def list_composio_connected_accounts(user_id: str) -> list[dict]:
    """The source of truth for "is this app connected" for the dynamic
    Composio catalog: reads ACTIVE connected accounts directly from
    Composio's own API rather than our local `connected_apps` table.

    That table is only ever written by the legacy session-cookie/API-key
    save flow (WhatsApp QR, save-session) — the OAuth flow used by the
    App Vault's "Connect (1-Click)" button never persisted anything
    locally, so a page refresh always showed "Not Connected" even though
    the account was genuinely active on Composio's side. Querying
    Composio directly makes the UI correct regardless of any local sync
    gap, and also checks both identities a guest session may have been
    connected under (see `_candidate_user_ids`).
    """
    if not composio:
        return []

    candidates = _candidate_user_ids(user_id)
    try:
        response = composio.connected_accounts.list(user_ids=candidates, statuses=["ACTIVE"])
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to list connected accounts for {candidates}: {e}")
        return []

    items = list(getattr(response, "items", response) or [])

    # Multiple active accounts can exist for the same toolkit (e.g. after a
    # "change account" reconnect that didn't clean up the old one) — keep
    # only the most recently created one per slug so the UI reflects
    # whichever account executions would actually pick.
    by_slug: dict[str, dict] = {}
    for item in items:
        slug = getattr(getattr(item, "toolkit", None), "slug", None)
        if not slug:
            continue
        created_at = getattr(item, "created_at", "") or ""
        existing = by_slug.get(slug)
        if existing is None or created_at > existing["created_at"]:
            by_slug[slug] = {
                "slug": slug,
                "connected_account_id": item.id,
                "status": getattr(item, "status", "ACTIVE"),
                "created_at": created_at,
            }

    return list(by_slug.values())


def disconnect_composio_account(connected_account_id: str) -> None:
    """Deletes a Composio connected account outright (used by "change
    account" — the old connection is removed before the OAuth flow for a
    new one starts, so there's never more than one active account per
    toolkit to be ambiguous about at execution time)."""
    if not composio:
        raise Exception("Composio client not initialized")
    composio.connected_accounts.delete(connected_account_id)


def get_toolkit_connect_requirements(app_slug: str) -> dict:
    """Determines how `app_slug` can be connected: Composio-managed OAuth
    (the existing 1-click redirect/popup flow) or a manual credential — an
    API key, bot token, etc. — the user has to type in themselves.

    Not every toolkit has Composio-managed OAuth (Telegram is API-key-only,
    for example — its bot token comes from @BotFather, there's nothing to
    redirect to). Calling `get_app_connect_url` for one of those 404s with
    "Default auth config not found for toolkit ... Composio does not have
    managed credentials for this toolkit." This lets the caller check first
    and route to the right flow instead of hitting that error.
    """
    if not composio:
        raise Exception("Composio client not initialized")

    toolkit = composio.toolkits.get(slug=app_slug)
    if list(getattr(toolkit, "composio_managed_auth_schemes", None) or []):
        return {"mode": "oauth", "auth_scheme": None, "fields": []}

    details = list(getattr(toolkit, "auth_config_details", None) or [])
    if not details:
        raise Exception(f"Composio has no auth configuration available for '{app_slug}' yet.")

    detail = details[0]
    auth_scheme = getattr(detail, "mode", None) or "API_KEY"
    initiation = getattr(detail.fields, "connected_account_initiation", None)
    required = list(getattr(initiation, "required", None) or []) if initiation else []
    fields = [
        {
            "name": f.name,
            "display_name": f.display_name,
            "description": f.description,
            "is_secret": bool(getattr(f, "is_secret", True)),
        }
        for f in required
    ]
    return {"mode": "credentials", "auth_scheme": auth_scheme, "fields": fields}


class NoAuthRequiredError(Exception):
    """Raised when Composio rejects creating an auth config for a toolkit
    because that toolkit's tools work without any connected account at all
    (e.g. Gemini) — a *positive* signal ("nothing to connect"), not a real
    failure, so callers should present it to the user as such instead of a
    generic "failed to connect" error."""

    def __init__(self, app_slug: str):
        self.app_slug = app_slug
        super().__init__(f"'{app_slug}' works without any connected account — there's nothing to connect.")


_NO_AUTH_TOOLKIT_HINTS = (
    "auth_config_noauthapp",
    "does not require authentication",
    "does not require auth",
)


def _looks_like_no_auth_toolkit_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in _NO_AUTH_TOOLKIT_HINTS)


def _get_or_create_auth_config(app_slug: str, mode: str, auth_scheme: str | None = None) -> str:
    """Shared by the OAuth and manual-credential connect paths: reuses the
    toolkit's existing auth config if one was already created, otherwise
    creates one with whichever auth type this toolkit actually supports."""
    configs = composio.auth_configs.list(toolkit_slug=app_slug)
    items = list(getattr(configs, "items", configs) or [])
    if items:
        (latest, *_) = sorted(items, key=lambda c: getattr(c, "created_at", ""), reverse=True)
        return latest.id

    try:
        if mode == "oauth":
            created = composio.auth_configs.create(
                app_slug,
                {
                    "type": "use_composio_managed_auth",
                    "tool_access_config": {"tools_for_connected_account_creation": []},
                },
            )
        else:
            created = composio.auth_configs.create(
                app_slug,
                {"type": "use_custom_auth", "auth_scheme": auth_scheme or "API_KEY"},
            )
    except Exception as e:
        # Composio's toolkit metadata can advertise an OAuth/credentials auth
        # scheme for a toolkit whose tools actually run with no auth at all
        # (observed with "gemini") — the real signal only surfaces here, when
        # actually trying to create the config. Surface it distinctly so the
        # caller can tell the user "nothing to connect" instead of "failed".
        if _looks_like_no_auth_toolkit_error(e):
            raise NoAuthRequiredError(app_slug) from e
        raise
    return created.id


def get_app_connect_url(user_id: str, app_slug: str) -> str:
    if not composio:
        raise Exception("Composio client not initialized")

    try:
        requirements = get_toolkit_connect_requirements(app_slug)
        if requirements["mode"] != "oauth":
            raise Exception(
                f"'{app_slug}' has no Composio-managed OAuth — it needs a manual credential "
                "(e.g. an API key or bot token) instead of the 1-click redirect flow."
            )

        resolved_user_id = resolve_connected_user_id(user_id, app_slug)
        config_id = _get_or_create_auth_config(app_slug, mode="oauth")

        # connected_accounts.initiate() (and the toolkits.authorize() helper that
        # wraps it) is retired for Composio-managed OAuth as of Composio's 2026
        # cutover. .link() is the current supported endpoint for this and
        # returns the same ConnectionRequest shape with a .redirect_url.
        connection_request = composio.connected_accounts.link(user_id=resolved_user_id, auth_config_id=config_id)
        url = getattr(connection_request, "redirect_url", None)
    except NoAuthRequiredError:
        raise
    except Exception as e:
        traceback.print_exc()
        raise Exception(f"Failed to generate redirect URL for {app_slug}: {str(e)}") from e

    if not url:
        raise Exception(f"Failed to generate redirect URL for {app_slug}")

    return url


def connect_app_with_credentials(user_id: str, app_slug: str, credentials: dict) -> dict:
    """Connects a non-OAuth toolkit (API key, bot token, ...) directly with
    the credential value(s) the user typed in — there's no redirect to send
    them to, so this creates the connected account synchronously instead of
    returning a URL."""
    if not composio:
        raise Exception("Composio client not initialized")

    requirements = get_toolkit_connect_requirements(app_slug)
    if requirements["mode"] != "credentials":
        raise Exception(f"'{app_slug}' uses OAuth — connect it via the 1-click flow instead.")

    missing = [f["name"] for f in requirements["fields"] if not (credentials or {}).get(f["name"])]
    if missing:
        raise Exception(f"Missing required field(s) for {app_slug}: {', '.join(missing)}")

    try:
        resolved_user_id = resolve_connected_user_id(user_id, app_slug)
        config_id = _get_or_create_auth_config(app_slug, mode="credentials", auth_scheme=requirements["auth_scheme"])
        connection_request = composio.connected_accounts.initiate(
            user_id=resolved_user_id,
            auth_config_id=config_id,
            config={"auth_scheme": requirements["auth_scheme"], "val": credentials},
        )
    except NoAuthRequiredError:
        raise
    except Exception as e:
        traceback.print_exc()
        raise Exception(f"Failed to connect {app_slug}: {str(e)}") from e

    return {"connected_account_id": connection_request.id, "connection_status": connection_request.status}
