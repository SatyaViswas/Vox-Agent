import os
import asyncio
import json
import re
import traceback
from app.config import settings

from composio import Composio
from google import genai
from google.genai import types as genai_types
from app.services.resource_matcher import (
    calculate_resource_similarity,
    find_closest_resource_match,
    find_closest_resource_item,
)
from app.services.parameter_normalizer import (
    normalize_datetime_value,
    unwrap_dict_for_field,
    _DATETIME_PARAM_KEYWORDS,
)

# Initialize Composio safely
composio = None
if settings.COMPOSIO_API_KEY:
    try:
        composio = Composio(api_key=settings.COMPOSIO_API_KEY)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to initialize Composio: {e}")

async def _execute_composio_with_timeout(*args, **kwargs):
    return await asyncio.wait_for(
        asyncio.to_thread(composio.tools.execute, *args, **kwargs),
        timeout=120
    )


def toolkit_exists(app_slug: str) -> bool:
    """Whether `app_slug` is a real Composio toolkit at all — as opposed to
    an app name the planner or user typed that Composio simply doesn't have
    (e.g. "zomato"). Used to decide, at plan time, whether a step can
    actually use the 'composio_api' route or must fall back to
    'browser_agent' — and to avoid ever offering a Composio "Connect"
    button for an app that can only 500 when clicked."""
    if not composio:
        return False
    try:
        composio.toolkits.get(slug=app_slug)
        return True
    except Exception:
        return False

# A separate, minimal Gemini client used only to disambiguate a guessed
# action slug against a shortlist of an app's real tools (see
# _pick_best_action_via_ai) — kept local to this module rather than shared
# with planner.py's client since the two have no other coupling.
_gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

FALLBACK_GEMINI_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
]

def _gemini_generate_with_fallback(contents, config=None):
    if not _gemini_client:
        return None
    last_err = None
    for model_name in FALLBACK_GEMINI_MODELS:
        try:
            return _gemini_client.models.generate_content(
                model=model_name,
                contents=contents,
                config=config,
            )
        except Exception as e:
            last_err = e
            continue
    if last_err:
        raise last_err
    return None

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
    "GET_MESSAGE": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GET_MESSAGE_CONTENT": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_GET_MESSAGE_CONTENT": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_GET_MESSAGE": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
}

COMMON_ACTION_ALIASES = {
    # Gmail
    **GMAIL_ACTION_ALIASES,
    "GMAIL_SEND_AN_EMAIL": "GMAIL_SEND_EMAIL",

    # GitHub
    "GITHUB_LIST_NOTIFICATIONS": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_LIST_NOTIFICATIONS_FOR_AUTHENTICATED_USER": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_GET_NOTIFICATIONS": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_CHECK_NOTIFICATIONS": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_FETCH_NOTIFICATIONS": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_LIST_USER_NOTIFICATIONS": "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_LIST_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_GET_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_FETCH_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_SEARCH_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_FIND_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_CHECK_ISSUES": "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_LIST_REPOS": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    "GITHUB_LIST_REPOSITORIES": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    "GITHUB_GET_REPOSITORIES": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    "GITHUB_GET_USER_REPOSITORIES": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    "GITHUB_CREATE_ISSUE": "GITHUB_CREATE_AN_ISSUE",
    "GITHUB_POST_ISSUE": "GITHUB_CREATE_AN_ISSUE",
    "GITHUB_CREATE_ISSUE_COMMENT": "GITHUB_CREATE_AN_ISSUE_COMMENT",
    "GITHUB_ADD_COMMENT": "GITHUB_CREATE_AN_ISSUE_COMMENT",
    "GITHUB_GET_ABOUT_THE_AUTHENTICATED_USER": "GITHUB_GET_THE_AUTHENTICATED_USER",

    # Google Calendar
    "GOOGLECALENDAR_GET_SCHEDULE": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_CHECK_SCHEDULE": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_LIST_EVENTS": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_GET_EVENTS": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_GET_TOMORROW_SCHEDULE": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_GET_TODAY_SCHEDULE": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_FETCH_EVENTS": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_SEARCH_EVENTS": "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_SCHEDULE_EVENT": "GOOGLECALENDAR_CREATE_EVENT",
    "GOOGLECALENDAR_ADD_EVENT": "GOOGLECALENDAR_CREATE_EVENT",

    # Google Sheets
    "GOOGLESHEETS_APPEND_ROW": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_ADD_ROW": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_ADD_ROWS": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_APPEND_ROWS": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_INSERT_ROW": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_VALUES_APPEND": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    "GOOGLESHEETS_GET_ROW": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_GET_ROWS": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_READ_SHEET": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_READ_ROWS": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_GET_SPREADSHEET_VALUES": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_GET_SHEET_VALUES": "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_FIND_ROW": "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",
    "GOOGLESHEETS_SEARCH_ROW": "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",

    # Slack
    "SLACK_POST_MESSAGE": "SLACK_SEND_MESSAGE",
    "SLACK_SEND_MSG": "SLACK_SEND_MESSAGE",
    "SLACK_WRITE_MESSAGE": "SLACK_SEND_MESSAGE",

    # Notion
    "NOTION_ADD_PAGE": "NOTION_CREATE_NOTION_PAGE",
    "NOTION_CREATE_PAGE": "NOTION_CREATE_NOTION_PAGE",
    "NOTION_SEARCH_PAGES": "NOTION_SEARCH_NOTION_PAGE",
    "NOTION_FIND_PAGE": "NOTION_SEARCH_NOTION_PAGE",

    # Google Drive
    "GOOGLEDRIVE_SEARCH_FILES": "GOOGLEDRIVE_FIND_FILE",
    "GOOGLEDRIVE_SEARCH_FILE": "GOOGLEDRIVE_FIND_FILE",
    "GOOGLEDRIVE_GET_FILES": "GOOGLEDRIVE_LIST_FILES",
    "GOOGLEDRIVE_SEARCH": "GOOGLEDRIVE_FIND_FILE",

    # YouTube
    "YOUTUBE_SEARCH_VIDEOS": "YOUTUBE_SEARCH_YOU_TUBE",
    "YOUTUBE_SEARCH_VIDEO": "YOUTUBE_SEARCH_YOU_TUBE",
    "YOUTUBE_FIND_VIDEOS": "YOUTUBE_SEARCH_YOU_TUBE",
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
    {"query", "q", "search", "search_query", "filter", "search_term"},
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


def _coerce_value_type(value, prop_schema: dict, prop_name: str = ""):
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
            if is_nested_array and value and not any(isinstance(v, list) for v in value):
                if any(isinstance(v, dict) for v in value):
                    return [list(v.values()) if isinstance(v, dict) else [v] for v in value]
                return [value]
            return value

        if isinstance(value, dict):
            cells = list(value.values())
            return [cells] if is_nested_array else cells
        if is_nested_array:
            return [[value]]
        return [value]

    # Handle dictionary passed to scalar/string field (e.g. {{trigger_data}} mapped to recipient_email)
    if isinstance(value, dict) and "array" not in types:
        unwrapped = unwrap_dict_for_field(prop_name, value)
        if unwrapped is not None:
            value = unwrapped
        elif "string" in types or not types or types == [None]:
            value = json.dumps(value)

    if not isinstance(value, str):
        return value

    # Datetime normalization for date/time schema properties (Google Calendar, Tasks, Notion, Linear, etc.)
    prop_k_clean = re.sub(r"[^a-z0-9_]", "", prop_name.lower())
    desc = str(prop_schema.get("description") or "").lower()
    if (
        prop_k_clean in _DATETIME_PARAM_KEYWORDS
        or any(k in prop_k_clean for k in ("time", "date", "due", "since", "until", "timestamp"))
        or any(w in desc for w in ("rfc3339", "iso 8601", "iso8601", "date-time", "datetime"))
    ):
        is_end = any(term in prop_k_clean for term in ("max", "end", "until", "before", "to"))
        norm_dt = normalize_datetime_value(value, is_end_bound=is_end)
        if norm_dt:
            return norm_dt

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
            exact_matches = [p for p in candidates if p in bucket or _normalize_key_token(p) in bucket]
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
        normalized[final_key] = _coerce_value_type(value, properties.get(final_key, {}), prop_name=final_key)

    # Smart parameter normalization & defaults for common SaaS tools
    act_upper = (action_name or "").upper()

    # 1. GitHub Issue Searches & Queries
    if "GITHUB" in act_upper and "SEARCH_ISSUES" in act_upper:
        if "q" not in normalized or not str(normalized.get("q") or "").strip():
            q_parts = ["is:issue"]
            state = parameters.get("state") or parameters.get("status")
            if state and str(state).lower() in ("open", "closed"):
                q_parts.append(f"state:{str(state).lower()}")
            else:
                q_parts.append("state:open")

            custom_query = parameters.get("query") or parameters.get("filter") or parameters.get("search")
            if custom_query and isinstance(custom_query, str) and custom_query.strip():
                q_parts.append(custom_query.strip())
            else:
                q_parts.append("involves:@me")

            normalized["q"] = " ".join(q_parts)

        if "sort" in properties and "sort" not in normalized:
            normalized["sort"] = "updated"
        if "order" in properties and "order" not in normalized:
            normalized["order"] = "desc"

    # 2. Google Sheets Appends & Reads
    if "GOOGLESHEETS" in act_upper:
        if "spreadsheetId" in properties and "spreadsheetId" not in normalized:
            for alt_k in ("spreadsheet_name", "spreadsheet_id", "sheet_id", "spreadsheet", "sheet_name", "doc_id", "file_id"):
                if alt_k in parameters:
                    val = parameters[alt_k]
                    if isinstance(val, dict):
                        unwrapped_val = unwrap_dict_for_field("spreadsheetId", val) or val.get("spreadsheetId") or val.get("id")
                        if unwrapped_val:
                            val = unwrapped_val
                    if val and str(val).strip():
                        normalized["spreadsheetId"] = val
                        break
        if "CREATE" in act_upper:
            if "title" in properties and "title" not in normalized:
                for alt_k in ("spreadsheet_name", "sheet_name", "name", "spreadsheet_title", "title", "filename"):
                    if alt_k in parameters and str(parameters[alt_k]).strip():
                        normalized["title"] = parameters[alt_k]
                        break
        if "APPEND" in act_upper:
            if "valueInputOption" in properties and "valueInputOption" not in normalized:
                normalized["valueInputOption"] = "USER_ENTERED"
            if "range" in properties and "range" not in normalized:
                normalized["range"] = "A1"
            # Ensure row/data mapped to values
            if "values" not in normalized:
                for alt_k in ("row", "rows", "data", "row_data", "items"):
                    if alt_k in parameters:
                        normalized["values"] = _coerce_value_type(parameters[alt_k], properties.get("values", {}), prop_name="values")
                        break

    # 3. Google Calendar
    if "GOOGLECALENDAR" in act_upper:
        if "calendarId" in properties and "calendarId" not in normalized and "calendar_id" not in normalized:
            normalized["calendarId"] = "primary"
        elif "calendar_id" in properties and "calendar_id" not in normalized and "calendarId" not in normalized:
            normalized["calendar_id"] = "primary"

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
    clean = (action_name or "").upper().strip()
    return COMMON_ACTION_ALIASES.get(clean, GMAIL_ACTION_ALIASES.get(clean, clean))


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
    clean_action = (action_name or "").upper().strip()
    if clean_action in _resolved_action_cache:
        return _resolved_action_cache[clean_action]

    # 1. Check comprehensive alias registry first (0ms, 100% deterministic)
    if clean_action in COMMON_ACTION_ALIASES:
        resolved = COMMON_ACTION_ALIASES[clean_action]
        _resolved_action_cache[clean_action] = resolved
        return resolved

    if not composio:
        return clean_action

    if _get_action_schema(clean_action):
        # The guess is already a real tool — nothing to resolve.
        _resolved_action_cache[clean_action] = clean_action
        return clean_action

    toolkit_slug = slugify_app_name(app)

    # 2. Search tools in toolkit without the app prefix
    # e.g. "GITHUB_LIST_NOTIFICATIONS_FOR_USER" -> search="LIST NOTIFICATIONS FOR USER"
    prefix = toolkit_slug.replace("-", "").replace("_", "").lower()
    parts = clean_action.split("_")
    if parts and parts[0].lower() == prefix:
        search_words = " ".join(parts[1:]).strip()
    else:
        search_words = clean_action.replace("_", " ").strip()

    try:
        candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], search=search_words, limit=10)
        if not candidates and " " in search_words:
            # Fall back to searching significant words (excluding filler verbs)
            core_words = [w for w in parts[1:] if w.lower() not in ("get", "list", "fetch", "check", "the", "a", "an")]
            if core_words:
                candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], search=" ".join(core_words), limit=10)
        if not candidates:
            candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], limit=40)
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to search tools for toolkit '{toolkit_slug}' while resolving '{clean_action}': {e}")
        _resolved_action_cache[clean_action] = clean_action
        return clean_action

    if not candidates:
        _resolved_action_cache[clean_action] = clean_action
        return clean_action

    # 3. Disambiguate via AI by intent from real tool descriptions
    resolved_name = _pick_best_action_via_ai(clean_action, candidates)
    if not resolved_name:
        # Check if any candidate has word overlap before arbitrarily falling back to candidates[0]
        action_words = set(w.lower() for w in parts if len(w) > 2)
        best_cand = None
        best_overlap = 0
        for c in candidates:
            c_words = set(w.lower() for w in c.slug.split("_") if len(w) > 2)
            overlap = len(action_words & c_words)
            if overlap > best_overlap:
                best_overlap = overlap
                best_cand = c.slug
        resolved_name = best_cand or candidates[0].slug

    if resolved_name != clean_action:
        print(f"Info: Resolved guessed action '{clean_action}' to real tool '{resolved_name}' for toolkit '{toolkit_slug}'.")
    _resolved_action_cache[clean_action] = resolved_name
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
        response = _gemini_generate_with_fallback(
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        picked = (response.text or "").strip().strip('"').strip() if response else None
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
        response = _gemini_generate_with_fallback(
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        picked = (response.text or "").strip().strip('"').strip() if response else None
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
        response = _gemini_generate_with_fallback(
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        answer = (response.text or "").strip().upper() if response else ""
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
        response = _gemini_generate_with_fallback(
            contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])],
            config=genai_types.GenerateContentConfig(response_mime_type="application/json", temperature=0.6),
        )
        data = json.loads(response.text) if response else fallback
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to generate a sample trigger payload, using a generic placeholder instead: {e}")
        return fallback

    message_text = data.get("message_text") or fallback["message_text"]
    sender = data.get("sender") or fallback["sender"]

    # Guarantee the sender is always a well-formed address for test runs so
    # Gmail and other email actions never reject it with "invalid string".
    # We replace any AI-invented fictional email (e.g. "sarah.j@creativepulse.io")
    # with a known-safe placeholder — the message_text body can still carry
    # realistic synthetic content for extraction steps to work on.
    TEST_EMAIL = "test-voxagent@example.com"
    steps = blueprint.get("steps") or []
    has_email_send = any(
        "SEND_EMAIL" in (s.get("action") or "").upper() or "SEND_MAIL" in (s.get("action") or "").upper()
        for s in steps
    )
    if has_email_send:
        # Inject the guaranteed test email into the message body so that
        # any "extract the prospect_email from this data" AI step finds it.
        if "prospect_email" not in message_text.lower() and "@" not in message_text:
            message_text = f"{message_text}\nProspect Email: {TEST_EMAIL}"
        elif "@" in message_text:
            # Replace any fictional email address in the body with the safe test one
            import re as _re
            message_text = _re.sub(
                r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
                TEST_EMAIL,
                message_text,
            )
        sender = TEST_EMAIL

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


def slugify_app_name(app: str) -> str:
    """Composio toolkit slug for a plain app display name — strip
    everything but alphanumerics, matching Composio's own slug convention.
    The single shared implementation (previously duplicated three ways:
    here, plus vault.py's `_slugify_app` and execution.py's `_slugify_app`,
    both now importing this one instead)."""
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


def _is_google_sheets_append_action(app: str, action_name: str) -> bool:
    is_gsheet = "sheet" in (app or "").lower() or "sheet" in (action_name or "").lower()
    is_append = any(w in (action_name or "").upper() for w in ("APPEND", "WRITE", "ADD", "INSERT", "ROW"))
    return is_gsheet and is_append


def _is_google_sheets_create_action(app: str, action_name: str) -> bool:
    is_gsheet = "sheet" in (app or "").lower() or "sheet" in (action_name or "").lower()
    is_create = "CREATE" in (action_name or "").upper() and not ("ROW" in (action_name or "").upper() and "CREATE" in (action_name or "").upper())
    return is_gsheet and is_create


def _extract_spreadsheet_id_from_result(result) -> str | None:
    if not result:
        return None
    data = result.get("data") if isinstance(result, dict) else getattr(result, "data", None)
    if isinstance(data, dict):
        for k in ("spreadsheetId", "spreadsheet_id", "id", "file_id", "fileId"):
            if data.get(k):
                return str(data[k]).strip()
        for sub_v in data.values():
            if isinstance(sub_v, dict):
                for k in ("spreadsheetId", "spreadsheet_id", "id", "file_id"):
                    if sub_v.get(k):
                        return str(sub_v[k]).strip()
    if isinstance(result, dict):
        for k in ("spreadsheetId", "spreadsheet_id", "id", "file_id"):
            if result.get(k):
                return str(result[k]).strip()
    res_str = str(result)
    m = re.search(r"docs\.google\.com/spreadsheets/d/([a-zA-Z0-9-_]+)", res_str)
    if m:
        return m.group(1).strip()
    return None


def _extract_named_id(result, name: str, threshold: float = 0.55) -> str | None:
    """Picks whichever search result's name/title best matches `name`
    using high-precision exact and fuzzy matching.
    
    If the closest match has confidence >= threshold (0.55), returns its id.
    If the best match is below threshold (irrelevant detail), returns None
    rather than blindly picking an arbitrary resource.
    """
    items = _list_search_tool_items(result)
    if not items or not name:
        return None

    lowered_name = name.strip().lower()

    # Pass 1: Exact case-insensitive match (highest priority - never let a partial match preempt an exact one)
    for item in items:
        item_title = str(item.get("name") or item.get("title") or item.get("summary") or "").strip().lower()
        if item_title and item_title == lowered_name:
            item_id = _item_id(item)
            if item_id:
                return item_id

    # Pass 2: Query as full prefix or contained substring in item title (e.g. "Trending" in "Trending Laptops")
    for item in items:
        item_title = str(item.get("name") or item.get("title") or item.get("summary") or "").strip().lower()
        if item_title and lowered_name in item_title:
            item_id = _item_id(item)
            if item_id:
                return item_id

    # Pass 3: Fuzzy closest-resource resolution
    best_item, best_score = find_closest_resource_item(name, items, threshold=threshold)
    if best_item:
        item_id = _item_id(best_item)
        if item_id:
            matched_title = str(best_item.get("name") or best_item.get("title") or best_item.get("summary") or "")
            print(f"Info: Closest match found for '{name}' -> '{matched_title}' (confidence: {best_score:.2f})")
            return item_id

    # Pass 4: If only one item exists and name is non-empty, check if it's plausible (>= 0.40)
    if len(items) == 1:
        single_item = items[0]
        _, single_score = find_closest_resource_item(name, [single_item], threshold=0.40)
        if single_score >= 0.40:
            return _item_id(single_item)

    return None


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

    # If any parameter holds a dictionary from an earlier step (e.g. {{step_1_result}}), unwrap it!
    for k, v in list(parameters.items()):
        if isinstance(v, dict):
            unwrapped = unwrap_dict_for_field(k, v)
            if unwrapped:
                parameters[k] = unwrapped

    # If any required id field is missing or empty, check if another parameter holds an opaque ID
    for r in required:
        if _looks_like_id_field(r) and (r not in parameters or not str(parameters.get(r) or "").strip()):
            for alt_k, alt_v in list(parameters.items()):
                if alt_k != r and isinstance(alt_v, str) and _looks_like_opaque_id(alt_v):
                    print(f"Info: Mapping opaque ID from '{alt_k}' to required field '{r}': {alt_v}")
                    parameters[r] = alt_v
                    break

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

    toolkit_slug = slugify_app_name(app)
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
            listing = await _execute_composio_with_timeout(
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
        result = await _execute_composio_with_timeout(
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
        # Fallback: if search with exact query yielded nothing (common with API server filters on typos),
        # list available resources and perform closest-match resolution
        try:
            listing_result = await _execute_composio_with_timeout(
                slug=search_tool.slug,
                arguments={query_param: ""} if query_param else {},
                user_id=entity_id,
                dangerously_skip_version_check=True,
            )
            resolved_id = _extract_named_id(listing_result, name_value, threshold=0.55)
        except Exception:
            pass

    if not resolved_id:
        if _is_google_sheets_append_action(app, action_name) and name_value and not _looks_like_opaque_id(name_value):
            # SELF-HEALING: User/planner intended to append to a sheet named `name_value`,
            # but it was not found in Google Drive. Automatically create it and proceed!
            print(f"Self-Healing: Google Sheet '{name_value}' not found in Drive. Automatically creating new spreadsheet '{name_value}'...")
            try:
                create_res = await _execute_composio_with_timeout(
                    slug="GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    arguments={"title": name_value},
                    user_id=entity_id,
                    dangerously_skip_version_check=True,
                )
                new_sheet_id = _extract_spreadsheet_id_from_result(create_res)
                if new_sheet_id:
                    print(f"Self-Healing Success: Created new Google Sheet '{name_value}' (ID: {new_sheet_id}). Continuing append.")
                    updated = dict(parameters)
                    updated[target_field] = new_sheet_id
                    return updated, None
            except Exception as e:
                print(f"Self-Healing Warning: Failed to auto-create Google Sheet '{name_value}': {e}")

        print(f"Info: Searched for '{app}' item named \"{name_value}\" via '{search_tool.slug}' — found nothing matching sufficiently.")
        updated = dict(parameters)
        updated.pop(target_field, None)
        return updated, {"field": target_field, "name": name_value}

    print(f"Info: Auto-resolved '{target_field}' to '{resolved_id}' via '{search_tool.slug}' for \"{name_value}\".")
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

    slug = slugify_app_name(app)
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


# --- Thin-reference-list enrichment ------------------------------------
#
# Many toolkits' "list" actions return bare references (IDs) rather than
# content — e.g. HACKERNEWS_GET_TOP_STORIES returns up to 500 integer
# story_ids, and its own output schema says outright: "Use these IDs with
# the get_item_with_id action to retrieve full story details." A blueprint
# step built around one such action hands a downstream ai_generate step
# (or any {{step_N_result}} reference) a list of numbers with nothing to
# summarize — the model then either correctly refuses or hallucinates.
#
# This is not a Hacker News problem specifically: the same "list returns
# references, a sibling action resolves one reference into full content"
# shape recurs across many REST-ish APIs Composio wraps. Rather than
# hardcode per-app fixes, detect the SHAPE generically and resolve the
# matching detail action within the same toolkit — via Composio's own
# schema-hint text first (free), falling back to the same AI-assisted
# action-disambiguation `_resolve_action_slug` already uses elsewhere in
# this file. Every step here is deliberately conservative and fails open:
# any ambiguity, missing data, or error just leaves the original result
# untouched — this must never turn a working call into a broken one.

_ENRICHMENT_CAP = 10  # hard ceiling on per-item detail calls, independent of how many references came back
_ENRICHMENT_CONCURRENCY = 5
_RICH_CONTENT_HINT_KEYS = {"title", "text", "content", "body", "description", "name", "summary", "message", "caption"}


def _find_thin_reference_field(output) -> tuple[str, list] | None:
    """Looks for a field in a composio_api result that is a non-empty array
    of bare scalars (int/str) with no sibling field that already looks like
    real content — Composio's shape for "list of references, no inline
    detail". Returns (field_name, values) or None. Deliberately narrow: an
    array of objects, or one sitting next to a title/text/body/etc. field,
    is left alone rather than guessed at."""
    if not isinstance(output, dict):
        return None
    candidates = output.get("data") if isinstance(output.get("data"), dict) else output
    if not isinstance(candidates, dict):
        return None

    other_keys = set(candidates.keys())
    for key, value in candidates.items():
        if not isinstance(value, list) or not value:
            continue
        if not all(isinstance(v, (int, str)) and not isinstance(v, bool) for v in value):
            continue
        if (other_keys - {key}) & _RICH_CONTENT_HINT_KEYS:
            continue
        return key, value
    return None


_ACTION_NAME_HINT_RE = re.compile(r"(?:use|with|via|call)\s+(?:the\s+)?([a-z][a-z0-9_]{3,})\s+action", re.IGNORECASE)


def _resolve_detail_action(toolkit_slug: str, list_action_name: str, field_name: str, field_description: str | None) -> tuple[str, str] | None:
    """Finds (action_slug, id_param_name) for the action that resolves ONE
    reference from `field_name` into full content, within the same
    toolkit. Returns None if nothing suitable can be found — callers treat
    that as "leave the data as-is", never as an error."""
    try:
        candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], limit=60)
    except Exception:
        return None
    if not candidates:
        return None

    resolved_slug = None

    # Fast, free pass: Composio's own schema descriptions sometimes name the
    # follow-up action outright (confirmed for Hacker News). No API/LLM cost
    # if this matches.
    hint_match = _ACTION_NAME_HINT_RE.search(field_description or "")
    if hint_match:
        hinted = hint_match.group(1).replace("_", "")
        for c in candidates:
            if hinted.lower() in c.slug.replace("_", "").lower():
                resolved_slug = c.slug
                break

    # Fallback: ask the existing AI-disambiguation helper to pick from this
    # toolkit's own action list by intent, same mechanism _resolve_action_slug
    # already relies on for a different guess-vs-real-tool gap.
    if not resolved_slug:
        narrowed = [c for c in candidates if c.slug != list_action_name] or candidates
        resolved_slug = ai_pick_best_match(
            f"An automation needs to resolve ONE reference (a single '{field_name}' value returned by "
            f"{list_action_name}) into its full details/content.",
            [(c.slug, getattr(c, "description", None)) for c in narrowed],
        )

    if not resolved_slug or resolved_slug == list_action_name:
        return None

    schema = _get_action_schema(resolved_slug)
    required = (schema or {}).get("required") or []
    if len(required) == 1:
        return resolved_slug, required[0]
    id_candidates = [r for r in required if _looks_like_id_field(r)]
    if len(id_candidates) == 1:
        return resolved_slug, id_candidates[0]
    # More than one required field and no unambiguous id-shaped one — can't
    # safely guess which one the reference value belongs in.
    return None


async def _enrich_thin_composio_result(app: str, action_name: str, output: dict, entity_id: str, result_limit: int | None) -> dict:
    """Best-effort, additive enrichment — never raises, never removes
    anything from `output`. On success, adds `<field>_resolved: [...]`
    alongside the original bare reference list so anything already
    depending on that original shape keeps working unchanged."""
    try:
        found = _find_thin_reference_field(output)
        if not found:
            return output
        field_name, values = found

        schema = _get_action_schema(action_name)
        field_description = ((schema or {}).get("properties") or {}).get(field_name, {}).get("description")

        toolkit_slug = slugify_app_name(app)
        resolved = _resolve_detail_action(toolkit_slug, action_name, field_name, field_description)
        if not resolved:
            return output
        detail_action, id_param = resolved

        cap = min(result_limit, _ENRICHMENT_CAP) if result_limit else _ENRICHMENT_CAP
        targets = values[:cap]

        semaphore = asyncio.Semaphore(_ENRICHMENT_CONCURRENCY)

        async def _fetch_one(ref_value):
            async with semaphore:
                try:
                    detail = await _execute_composio_with_timeout(
                        slug=detail_action,
                        arguments={id_param: ref_value},
                        user_id=entity_id,
                        dangerously_skip_version_check=True,
                    )
                except Exception:
                    return None
                if _tool_result_unsuccessful(detail):
                    return None
                return detail.get("data") if isinstance(detail, dict) else getattr(detail, "data", None)

        enriched = await asyncio.gather(*(_fetch_one(v) for v in targets))
        enriched = [item for item in enriched if item is not None]
        if not enriched:
            return output

        container = output["data"] if isinstance(output.get("data"), dict) else output
        container[f"{field_name}_resolved"] = enriched
        return output
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: thin-result enrichment skipped for {app}/{action_name}: {e}")
        return output


def _is_payload_too_large_error(e: Exception) -> bool:
    s = str(e).lower()
    return "413" in s or "payloadtoolarge" in s or "payload is too large" in s or "upstream_payloadtoolarge" in s


def _clean_html_text(html_content: str) -> str:
    if not isinstance(html_content, str):
        return str(html_content or "")
    if "<html" in html_content.lower() or "<body" in html_content.lower() or "<div" in html_content.lower():
        cleaned = re.sub(r'<(style|script)[^>]*>.*?</\1>', '', html_content, flags=re.DOTALL | re.IGNORECASE)
        cleaned = re.sub(r'<[^>]+>', ' ', cleaned)
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()
        return cleaned[:8000]
    return html_content[:8000]


_LIMIT_PARAMETER_KEYS = (
    "max_results", "maxResults", "limit", "pageSize", "page_size",
    "per_page", "perPage", "count", "maxRecords", "top", "first",
)


def _apply_intelligent_data_extraction_limits(
    app: str,
    action_name: str,
    parameters: dict,
    result_limit: int | None = None,
) -> dict:
    """Intelligently enforces safe data extraction bounds across all SaaS apps.
    
    1. If the user/prompt specified an explicit count (or result_limit is passed),
       clamps to a safe operational envelope [1, 50].
    2. If the user did NOT specify how much data to extract, chooses an optimal,
       safe default tailored to that app category (e.g. 5 for chat/email/calendar,
       10 for CRM/drive/databases, bounded range for Google Sheets) so requests
       never overwhelm the tool or throw 413 PayloadTooLarge errors.
    """
    updated_params = dict(parameters or {})
    schema = _get_action_schema(action_name)
    properties = (schema or {}).get("properties") or {}

    # Check if this tool accepts any pagination/limit parameters
    supported_limit_keys = [k for k in _LIMIT_PARAMETER_KEYS if k in properties]

    app_lower = (app or "").lower()
    act_lower = action_name.lower()

    # Determine if action is a listing/fetching action
    is_listing = bool(supported_limit_keys) or any(
        w in act_lower for w in (
            "fetch", "list", "get_all", "search", "query", "find", "read",
            "get_messages", "get_spreadsheet_values", "get_rows", "history",
            "records", "issues", "commits", "events", "cards", "tickets", "posts"
        )
    )

    # 1. Detect if single/latest is requested
    query_text = " ".join(str(v) for k, v in updated_params.items() if isinstance(v, (str, int))).lower()
    is_latest_single = any(k in query_text for k in ("latest", "last", "newest", "recent single", "most recent", "newest single"))

    # 2. Check if a limit parameter is already present
    existing_limit_key = next((k for k in _LIMIT_PARAMETER_KEYS if k in updated_params and updated_params[k] is not None), None)

    if existing_limit_key:
        try:
            val = int(updated_params[existing_limit_key])
            # If user specified, honor up to safe ceiling of 50
            updated_params[existing_limit_key] = max(1, min(val, 50))
        except (ValueError, TypeError):
            updated_params[existing_limit_key] = 5
    elif result_limit:
        # User specified limit via planner hint
        target_key = supported_limit_keys[0] if supported_limit_keys else ("max_results" if "gmail" in app_lower else "limit")
        updated_params[target_key] = max(1, min(int(result_limit), 50))
    elif is_listing and (supported_limit_keys or "gmail" in app_lower):
        # User did not specify: select intelligent default by app category
        target_key = supported_limit_keys[0] if supported_limit_keys else "max_results"
        if is_latest_single:
            default_val = 1
        elif any(k in app_lower for k in ("gmail", "outlook", "mail")):
            default_val = 5
        elif any(k in app_lower for k in ("slack", "discord", "teams", "chat", "telegram")):
            default_val = 5
        elif any(k in app_lower for k in ("calendar", "event")):
            default_val = 5
        elif any(k in app_lower for k in ("github", "gitlab", "jira", "trello", "linear", "asana", "clickup")):
            default_val = 5
        elif any(k in app_lower for k in ("sheet", "airtable", "notion", "supabase", "database")):
            default_val = 10
        elif any(k in app_lower for k in ("hubspot", "salesforce", "zoho", "crm")):
            default_val = 10
        elif any(k in app_lower for k in ("drive", "dropbox", "onedrive", "box")):
            default_val = 10
        elif any(k in app_lower for k in ("twitter", "x", "linkedin")):
            default_val = 5
        else:
            default_val = 5

        updated_params[target_key] = default_val

    # 3. Special handling for Google Sheets reading
    if "sheet" in app_lower and ("range" in properties or "range" in updated_params or "get" in act_lower):
        current_range = str(updated_params.get("range") or "").strip()
        if not current_range or current_range in ("A:Z", "A1:Z"):
            updated_params["range"] = "A1:Z30"
        elif current_range.endswith("!"):
            updated_params["range"] = f"{current_range}A1:Z30"
        elif not re.search(r"[A-Za-z]{1,3}\d*:[A-Za-z]{0,3}\d*", current_range) and not re.fullmatch(r"^[A-Za-z]{1,3}\d+$", current_range):
            # Only sheet title provided, e.g. "Sheet1" -> "Sheet1!A1:Z30"
            updated_params["range"] = f"{current_range}!A1:Z30"

    # 4. Special handling for Google Calendar reading & finding
    if "calendar" in app_lower or "calendar" in act_lower:
        if "calendar_id" not in updated_params and "calendarId" not in updated_params:
            if "calendarId" in properties:
                updated_params["calendarId"] = "primary"
            else:
                updated_params["calendar_id"] = "primary"
        # If time_min is set (e.g. tomorrow start 00:00:00Z) and time_max is not set:
        t_min = updated_params.get("time_min") or updated_params.get("timeMin")
        if t_min and isinstance(t_min, str) and ("time_max" not in updated_params and "timeMax" not in updated_params):
            if "T00:00:00Z" in t_min:
                day_part = t_min.split("T")[0]
                t_max_k = "timeMax" if "timeMax" in properties else "time_max"
                updated_params[t_max_k] = f"{day_part}T23:59:59Z"
        if "single_events" not in updated_params and "singleEvents" not in updated_params:
            if "singleEvents" in properties:
                updated_params["singleEvents"] = True
            elif "single_events" in properties:
                updated_params["single_events"] = True
        if "order_by" not in updated_params and "orderBy" not in updated_params:
            if "orderBy" in properties:
                updated_params["orderBy"] = "startTime"
            elif "order_by" in properties:
                updated_params["order_by"] = "startTime"

    return updated_params


_user_email_cache: dict = {}


async def resolve_user_primary_email(user_id: str) -> str | None:
    """Discovers the connected user's primary email address so actions like
    'email me a digest' resolve to their real inbox without failing on 'me'."""
    if not user_id:
        return None
    if user_id in _user_email_cache:
        return _user_email_cache[user_id]

    # 1. Try GMAIL_GET_PROFILE if Gmail is connected
    try:
        res = await _execute_composio_with_timeout(
            slug="GMAIL_GET_PROFILE",
            arguments={"user_id": "me"},
            user_id=user_id,
            dangerously_skip_version_check=True,
        )
        if isinstance(res, dict):
            data = res.get("data") or {}
            email = data.get("emailAddress") or data.get("email")
            if email and "@" in email:
                _user_email_cache[user_id] = email
                return email
    except Exception:
        pass

    # 2. Try Supabase users table
    try:
        from app.database import supabase
        if supabase:
            u = supabase.table("users").select("email").eq("id", user_id).execute()
            if u.data and u.data[0].get("email"):
                email = u.data[0]["email"]
                if "@" in email and not email.endswith("@example.com"):
                    _user_email_cache[user_id] = email
                    return email
    except Exception:
        pass

    return None


async def execute_composio_action(app: str, action: str, parameters: dict, entity_id: str = "default") -> dict:
    if not composio:
        return {"status": "error", "error": "COMPOSIO_API_KEY is not configured or Composio client is uninitialized.", "message": "COMPOSIO_API_KEY is not configured or Composio client is uninitialized."}

    parameters = dict(parameters or {})
    # Strip internal orchestrator flags before tool dispatch
    parameters.pop("_is_test_run", None)
    parameters.pop("_as_list", None)

    # An internal-only hint the planner may set when the user's prompt names
    # a count ("top 5", "latest 10") — stripped before real params reach the
    # target action, same convention as `_is_test_run`/`_as_list` elsewhere.
    # Enrichment always applies its own hard cap regardless of whether this
    # is set, so its absence changes nothing about safety, only precision.
    result_limit = parameters.pop("_result_limit", None)
    if not isinstance(result_limit, int) or result_limit <= 0:
        result_limit = None

    action_name = action.upper().strip()
    if action_name == "GITHUB_GET_ABOUT_THE_AUTHENTICATED_USER":
        action_name = "GITHUB_GET_THE_AUTHENTICATED_USER"
    action_name = _normalize_gmail_action(action_name)
    action_name = _resolve_action_slug(app, action_name)

    parameters = _normalize_parameters_via_schema(action_name, parameters)
    entity_id = resolve_connected_user_id(entity_id, app)
    parameters, not_found_hint = await _auto_resolve_missing_ids(app, action_name, parameters, entity_id)

    # Auto-resolve self-recipient for email actions (e.g. 'email me a digest')
    if "gmail" in app.lower() or "mail" in action_name.lower():
        recip = parameters.get("recipient_email") or parameters.get("to")
        if not recip or str(recip).strip().lower() in ("me", "myself", "self", "user", "{{me}}"):
            resolved_email = await resolve_user_primary_email(entity_id)
            if resolved_email:
                parameters["recipient_email"] = resolved_email

    # Intelligently apply data extraction bounds across all apps
    parameters = _apply_intelligent_data_extraction_limits(app, action_name, parameters, result_limit=result_limit)
    parameters = _normalize_parameters_via_schema(action_name, parameters)

    if _is_google_sheets_create_action(app, action_name):
        duplicate_choice = parameters.pop("_duplicate_sheet_action", None) or parameters.get("clarification_answer")
        existing_sheet_id = parameters.pop("_existing_sheet_id", None)
        title = parameters.get("title") or parameters.get("spreadsheet_name") or parameters.get("name")

        if duplicate_choice:
            choice_str = str(duplicate_choice).lower().strip()
            # If user chose to add to existing spreadsheet
            if any(w in choice_str for w in ("add", "append", "existing", "update", "current", "use existing")):
                if not existing_sheet_id and title:
                    toolkit_slug = slugify_app_name(app)
                    search_tool = _find_search_tool(toolkit_slug)
                    if search_tool:
                        query_param = _search_tool_query_param(search_tool)
                        try:
                            s_res = await _execute_composio_with_timeout(
                                slug=search_tool.slug,
                                arguments={query_param: title} if query_param else {},
                                user_id=entity_id,
                                dangerously_skip_version_check=True,
                            )
                            existing_sheet_id = _extract_named_id(s_res, title, threshold=0.75)
                        except Exception:
                            pass

                if existing_sheet_id:
                    print(f"Info: User chose to add to existing Google Sheet '{title}' ({existing_sheet_id}).")
                    if parameters.get("values"):
                        try:
                            append_params = {"spreadsheet_id": existing_sheet_id, "values": parameters["values"]}
                            if parameters.get("range"):
                                append_params["range"] = parameters["range"]
                            append_res = await _execute_composio_with_timeout(
                                slug="GOOGLESHEETS_APPEND_ROW",
                                arguments=append_params,
                                user_id=entity_id,
                                dangerously_skip_version_check=True,
                            )
                            return _build_execution_result(append_res, app, "GOOGLESHEETS_APPEND_ROW", append_params)
                        except Exception as e:
                            print(f"Warning: Failed to append to existing sheet: {e}")

                    return {
                        "status": "success",
                        "output": {
                            "spreadsheetId": existing_sheet_id,
                            "spreadsheet_id": existing_sheet_id,
                            "id": existing_sheet_id,
                            "title": title,
                            "reused_existing": True,
                            "data": {
                                "spreadsheetId": existing_sheet_id,
                                "spreadsheet_id": existing_sheet_id,
                                "id": existing_sheet_id,
                                "title": title,
                            },
                            "message": f"Using existing Google Spreadsheet '{title}' ({existing_sheet_id}).",
                        },
                    }
            elif any(w in choice_str for w in ("create", "new", "fresh", "make new", "separate")):
                # User chose to create a new spreadsheet with almost the same name
                m = re.search(r"^(.*?)(?:\s*\((?:New|\d+)\))?$", str(title or ""), re.I)
                base_title = m.group(1).strip() if (m and m.group(1).strip()) else (title or "Spreadsheet")
                toolkit_slug = slugify_app_name(app)
                search_tool = _find_search_tool(toolkit_slug)
                existing_titles = set()
                if search_tool:
                    query_param = _search_tool_query_param(search_tool)
                    try:
                        listing = await _execute_composio_with_timeout(
                            slug=search_tool.slug,
                            arguments={query_param: ""} if query_param else {},
                            user_id=entity_id,
                            dangerously_skip_version_check=True,
                        )
                        for it in _list_search_tool_items(listing):
                            it_name = str(it.get("name") or it.get("title") or "").strip().lower()
                            if it_name:
                                existing_titles.add(it_name)
                    except Exception:
                        pass

                cand_title = f"{base_title} (New)"
                if cand_title.lower() in existing_titles:
                    idx = 2
                    while f"{base_title} ({idx})".lower() in existing_titles:
                        idx += 1
                    cand_title = f"{base_title} ({idx})"

                print(f"Info: User chose 'Create New'. Creating with unique name: '{cand_title}'")
                parameters["title"] = cand_title
        elif title and not _looks_like_opaque_id(title) and not str(title).startswith("{{"):
            toolkit_slug = slugify_app_name(app)
            search_tool = _find_search_tool(toolkit_slug)
            if search_tool:
                query_param = _search_tool_query_param(search_tool)
                try:
                    s_res = await _execute_composio_with_timeout(
                        slug=search_tool.slug,
                        arguments={query_param: title} if query_param else {},
                        user_id=entity_id,
                        dangerously_skip_version_check=True,
                    )
                    found_id = _extract_named_id(s_res, title, threshold=0.85)
                    if found_id:
                        print(f"Duplicate sheet detected: Found existing spreadsheet named '{title}' ({found_id}). Asking user.")
                        return {
                            "status": "needs_input",
                            "question": f"A Google Spreadsheet named '{title}' already exists in your Google Drive. Would you like to create a new spreadsheet, or add to the existing one?",
                            "missing_field": "_duplicate_sheet_action",
                            "options": ["Create New Spreadsheet", "Add to Existing Spreadsheet"],
                            "_existing_sheet_id": found_id,
                        }
                except Exception as e:
                    print(f"Warning: Checking duplicate sheet existence failed: {e}")

    if action_name in ("LINKEDIN_CREATE_POST", "LINKEDIN_CREATE_LINKED_IN_POST") and "author" not in (parameters or {}):
        try:
            profile = await _execute_composio_with_timeout(
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
        result = await _execute_composio_with_timeout(
            slug=action_name,
            arguments=parameters or {},
            user_id=entity_id,
            dangerously_skip_version_check=True
        )
    except Exception as e:
        if _is_payload_too_large_error(e):
            print(f"Warning: PayloadTooLarge (413) on {action_name}. Attempting auto-healing by reducing limit...")
            recovered_params = dict(parameters or {})
            reduced = False
            for k in _LIMIT_PARAMETER_KEYS:
                if k in recovered_params and isinstance(recovered_params[k], (int, str)):
                    try:
                        v = int(recovered_params[k])
                        if v > 1:
                            recovered_params[k] = 1 if v <= 5 else max(1, v // 2)
                            reduced = True
                    except (ValueError, TypeError):
                        pass

            if "range" in recovered_params and isinstance(recovered_params["range"], str):
                r = recovered_params["range"]
                if "Z" in r:
                    recovered_params["range"] = re.sub(r'Z\d+', 'Z10', r)
                    reduced = True

            if "gmail" in app.lower() or action_name == "GMAIL_FETCH_EMAILS":
                recovered_params["max_results"] = 1
                reduced = True

            if reduced:
                try:
                    result = await _execute_composio_with_timeout(
                        slug=action_name,
                        arguments=recovered_params,
                        user_id=entity_id,
                        dangerously_skip_version_check=True
                    )
                    parameters = recovered_params
                except Exception as retry_err:
                    try:
                        recovered_params["include_payload"] = False
                        recovered_params["verbose"] = False
                        result = await _execute_composio_with_timeout(
                            slug=action_name,
                            arguments=recovered_params,
                            user_id=entity_id,
                            dangerously_skip_version_check=True
                        )
                        parameters = recovered_params
                    except Exception:
                        traceback.print_exc()
                        return {"status": "error", "error": str(retry_err), "message": str(retry_err)}
            else:
                traceback.print_exc()
                return {"status": "error", "error": str(e), "message": str(e)}
        else:
            traceback.print_exc()
            if _looks_like_api_key_permission_error(e):
                error_message = _friendly_permission_message(action_name)
                return {"status": "error", "error": error_message, "message": error_message}
            if _looks_like_auth_error(e):
                return {
                    "status": "needs_input",
                    "question": f"{app} isn't connected right now. Connect it in App Vault, then answer here (anything) to retry.",
                    "error": _friendly_auth_message(app),
                    "missing_field": None,
                    "reconnect_app": app,
                }
            error_message = str(e)
            return {"status": "error", "error": error_message, "message": error_message}

    if action_name == "GMAIL_FETCH_EMAILS":
        if isinstance(result, dict) and "data" in result and isinstance(result["data"], dict):
            messages = result["data"].get("messages", [])
            if isinstance(messages, list):
                for msg in messages:
                    if isinstance(msg, dict):
                        # Remove the massive raw payload to save tokens (we already have messageText)
                        msg.pop("payload", None)
                        msg.pop("raw", None)
                        if "messageText" in msg and isinstance(msg["messageText"], str):
                            msg["messageText"] = _clean_html_text(msg["messageText"])

    if _tool_result_unsuccessful(result) and _is_google_sheets_append_action(app, action_name):
        err_msg = _tool_error_message(result).lower()
        if any(w in err_msg for w in ("not found", "404", "unable to parse range", "does not exist")):
            sheet_title = parameters.get("spreadsheet_name") or parameters.get("title") or "Untitled Spreadsheet"
            print(f"Self-Healing: Append failed with '{err_msg}'. Auto-creating spreadsheet '{sheet_title}' and retrying...")
            try:
                c_res = await _execute_composio_with_timeout(
                    slug="GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    arguments={"title": str(sheet_title)},
                    user_id=entity_id,
                    dangerously_skip_version_check=True,
                )
                new_id = _extract_spreadsheet_id_from_result(c_res)
                if new_id:
                    for id_f in ("spreadsheet_id", "spreadsheetId", "file_id"):
                        if id_f in parameters:
                            parameters[id_f] = new_id
                    result = await _execute_composio_with_timeout(
                        slug=action_name,
                        arguments=parameters or {},
                        user_id=entity_id,
                        dangerously_skip_version_check=True,
                    )
            except Exception as e:
                print(f"Self-Healing Warning: Retry after auto-creating sheet failed: {e}")

    execution_result = _build_execution_result(result, app, action_name, parameters, not_found_hint)
    if execution_result.get("status") == "success":
        if _is_google_sheets_create_action(app, action_name):
            new_id = _extract_spreadsheet_id_from_result(result)
            if new_id and isinstance(execution_result.get("output"), dict):
                execution_result["output"]["spreadsheetId"] = new_id
                execution_result["output"]["spreadsheet_id"] = new_id
                execution_result["output"]["id"] = new_id
                sheet_title = parameters.get("title") or parameters.get("spreadsheet_name")
                if sheet_title:
                    execution_result["output"]["title"] = sheet_title
        execution_result["output"] = await _enrich_thin_composio_result(
            app, action_name, execution_result["output"], entity_id, result_limit
        )
    return execution_result


def _derive_auth_mode(item) -> str:
    """Classifies a toolkit's connection requirement straight from Composio's
    own bulk catalog metadata (`no_auth` / `composio_managed_auth_schemes` /
    `auth_schemes`) — no per-app detail call needed, since the bulk listing
    already carries this. Three modes:
    - "none": the toolkit's tools work with no connected account at all
      (e.g. Hacker News's public read API) — nothing to connect, ever.
    - "oauth": Composio manages the OAuth flow itself — the existing
      1-click redirect/popup.
    - "credentials": everything else — a manual API key/token, or (for the
      `oauth2_self_managed` subset) the user's own OAuth2 client
      credentials. See `get_toolkit_connect_requirements` for the detailed
      field list once a specific app is chosen.
    """
    if getattr(item, "no_auth", False):
        return "none"
    if list(getattr(item, "composio_managed_auth_schemes", None) or []):
        return "oauth"
    return "credentials"


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
        if item.slug == "telegram":
            continue
        meta = getattr(item, "meta", None)
        categories = getattr(meta, "categories", None) if meta else None
        category = categories[0].name if categories else "Other"
        logo = getattr(meta, "logo", None) if meta else None
        apps.append({
            "slug": item.slug,
            "name": item.name,
            "category": category,
            "logo": logo or f"https://logos.composio.dev/api/{item.slug}",
            # Lets the UI proactively render "no connection needed" or the
            # right connect flow straight from the catalog listing, instead
            # of reactively learning it only after a connect attempt (which
            # never persisted past a page refresh) or misrendering a
            # credential form with nothing in it (see auth_mode == "none").
            "auth_mode": _derive_auth_mode(item),
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
    items = []
    cursor = None
    try:
        # Composio paginates (10/page by default) — a user with more than one
        # page of connections would otherwise silently lose their OLDEST
        # connections from this list (whichever falls past page 1), showing
        # as "not connected" in the UI even though the account is genuinely
        # active. Loop until there's no next_cursor rather than assuming
        # everything fits on one page.
        while True:
            response = composio.connected_accounts.list(
                user_ids=candidates, statuses=["ACTIVE"], cursor=cursor
            )
            items.extend(getattr(response, "items", response) or [])
            cursor = getattr(response, "next_cursor", None)
            if not cursor:
                break
    except Exception as e:
        traceback.print_exc()
        print(f"Warning: Failed to list connected accounts for {candidates}: {e}")
        return []

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

    try:
        toolkit = composio.toolkits.get(slug=app_slug)
    except Exception:
        # Not a real Composio toolkit at all (e.g. "zomato") — raise a
        # clean, expected error instead of letting the SDK's raw exception
        # propagate as an opaque 500 (see routers/vault.py's
        # get_connect_requirements, which maps this to a 404).
        raise ValueError(f"'{app_slug}' isn't available as a Composio-connectable app.")
    if list(getattr(toolkit, "composio_managed_auth_schemes", None) or []):
        return {"mode": "oauth", "auth_scheme": None, "fields": []}

    details = list(getattr(toolkit, "auth_config_details", None) or [])
    if not details:
        raise Exception(f"Composio has no auth configuration available for '{app_slug}' yet.")

    detail = details[0]
    auth_scheme = getattr(detail, "mode", None) or "API_KEY"
    if auth_scheme == "NO_AUTH":
        # Composio's bulk catalog already flags these via `no_auth` (see
        # `_derive_auth_mode`), but this per-app detail lookup doesn't
        # expose that field directly — the auth scheme itself is the
        # equivalent signal here. Without this check, a toolkit like
        # Hacker News falls through to the "credentials" branch below with
        # zero required fields, opening a connect form with nothing to
        # fill in.
        return {"mode": "none", "auth_scheme": "NO_AUTH", "fields": []}
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


# --- Phase B: Connected Resource Introspection for Disambiguation -------

_introspection_tool_cache: dict = {}

def is_introspectable_resource_param(parameter_key: str, app: str = "") -> bool:
    """Returns True ONLY if a parameter is genuinely a discoverable resource container
    (like a spreadsheet name, channel name, database, or repository).
    
    Strictly returns False for emails, messages, subjects, usernames, phone numbers,
    queries, and any free-form user inputs across all apps.
    """
    if not parameter_key:
        return False
    
    p = parameter_key.lower().strip()

    # 1. Telegram account type special case
    if "telegram" in (app or "").lower() or "telegram" in p:
        if any(k in p for k in ("type", "account", "identity")):
            return True

    # Tokenize parameter key to avoid substring collisions (e.g. 'cc' in 'account')
    tokens = set(re.split(r"[^a-z0-9]+", p))

    # 2. Non-resource blocklist (emails, messages, subjects, identities, free-form text)
    FREEFORM_TOKENS = {
        "email", "emails", "recipient", "recipients", "to", "cc", "bcc", "from", "sender", "mail",
        "subject", "body", "message", "messages", "content", "text", "prompt", "description",
        "summary", "note", "notes", "caption", "comment", "comments", "title", "query", "search",
        "phone", "mobile", "user", "username", "password", "token", "key",
        "amount", "count", "limit", "date", "time", "price", "url", "link",
        "file_content", "code", "headers", "row_data", "values"
    }
    if any(tok in FREEFORM_TOKENS for tok in tokens):
        return False

    # Substring safety check for key terms that must never be select options
    if any(k in p for k in ("email", "recipient", "phone", "message", "subject", "body")):
        return False

    # 3. Explicit allowed resource container keywords
    ALLOWED_RESOURCE_KEYWORDS = (
        "spreadsheet", "sheet", "channel", "database", "table", "base", "repository", "repo"
    )
    return any(k in p for k in ALLOWED_RESOURCE_KEYWORDS)


def _find_resource_listing_tool(toolkit_slug: str, parameter_key: str = ""):
    if not is_introspectable_resource_param(parameter_key):
        return None

    cache_key = f"{toolkit_slug}::{parameter_key.lower()}"
    if cache_key in _introspection_tool_cache:
        return _introspection_tool_cache[cache_key]
    if not composio:
        return None

    search_terms = []
    p_lower = parameter_key.lower()
    if any(k in p_lower for k in ("channel", "chat")):
        search_terms = ["list channels", "search channels", "get channels"]
    elif any(k in p_lower for k in ("sheet", "spreadsheet")):
        search_terms = ["search spreadsheets", "list spreadsheets", "search by name"]
    elif any(k in p_lower for k in ("database", "table", "base")):
        search_terms = ["list databases", "list bases", "search"]
    elif any(k in p_lower for k in ("repo", "repository")):
        search_terms = ["list repositories", "search repositories"]
    else:
        return None

    candidates = []
    for term in search_terms:
        try:
            candidates = composio.tools.get_raw_composio_tools(toolkits=[toolkit_slug], search=term, limit=10)
            if candidates:
                break
        except Exception:
            continue

    tool = None
    if candidates:
        tool = next((c for c in candidates if any(w in c.slug for w in ("LIST", "SEARCH", "FIND", "GET_ALL"))), candidates[0])

    if not tool:
        tool = _find_search_tool(toolkit_slug)

    _introspection_tool_cache[cache_key] = tool
    return tool


async def introspect_app_resources(user_id: str, app: str, parameter_key: str = "") -> list:
    """Introspects available resource names (spreadsheets, channels, databases, etc.)
    for a user's connected account in `app`. Returns a list of up to 8 clean names."""
    if not app or not is_introspectable_resource_param(parameter_key, app):
        return []

    app_lower = app.lower()
    if "telegram" in app_lower:
        if any(k in parameter_key.lower() for k in ("type", "account", "identity")) or not parameter_key:
            return ["Telegram Bot", "Telegram Personal Account"]

    if not composio:
        return []

    active_user_id = resolve_connected_user_id(user_id, app)
    toolkit_slug = slugify_app_name(app)

    # Check if there is an active connected account for this toolkit
    candidates = _candidate_user_ids(active_user_id)
    try:
        accounts = composio.connected_accounts.list(
            user_ids=candidates,
            toolkit_slugs=[toolkit_slug] if toolkit_slug else None,
            statuses=["ACTIVE"],
        )
        has_active = bool(list(getattr(accounts, "items", accounts) or []))
        if not has_active:
            return []
    except Exception as e:
        print(f"Warning: Failed to check connection for introspection on '{app}': {e}")
        return []

    tool = _find_resource_listing_tool(toolkit_slug, parameter_key)
    if not tool:
        return []

    query_param = _search_tool_query_param(tool)
    args = {query_param: ""} if query_param else {}

    try:
        result = await _execute_composio_with_timeout(
            slug=tool.slug,
            arguments=args,
            user_id=active_user_id,
            dangerously_skip_version_check=True,
        )
    except Exception as e:
        print(f"Warning: Introspection execution '{tool.slug}' failed for '{app}': {e}")
        return []

    items = _list_search_tool_items(result)
    names = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = (
            item.get("name")
            or item.get("title")
            or item.get("summary")
            or item.get("channel_name")
            or item.get("full_name")
            or item.get("label")
        )
        if name and isinstance(name, str):
            clean_name = name.strip()
            if clean_name and not _looks_like_opaque_id(clean_name):
                if clean_name not in names:
                    names.append(clean_name)

    return names[:15]


async def enrich_blueprint_with_connected_resources(blueprint_dict: dict, user_id: str) -> dict:
    """Enriches blueprint with live resources discovered from the user's connected accounts.
    
    1. Inspects step parameters: if the user provided a resource name (like a Google Sheet
       name or channel) that does not match an opaque ID, attempts to match it against
       connected resources using closest-match fuzzy resolution (threshold >= 0.55).
       If a close match is found, updates the parameter to the real resource name and marks
       it resolved. If irrelevant (score < 0.55), leaves it for the user to select.
    2. Enriches missing_parameters with live resource options and auto-assumes closest
       matches if tentative values were provided.
    """
    if not blueprint_dict or not isinstance(blueprint_dict, dict):
        return blueprint_dict

    steps = blueprint_dict.get("steps") or []
    step_app_map = {s.get("step_number"): s.get("app") for s in steps if s.get("step_number") is not None}

    # 1. Inspect existing step parameters for closest-match resolution
    resolved_keys = set()
    for step in steps:
        if not isinstance(step, dict):
            continue
        app = step.get("app")
        params = step.get("parameters")
        s_num = step.get("step_number")
        if not app or not isinstance(params, dict):
            continue

        for param_key, param_val in list(params.items()):
            if any(k in param_key.lower() for k in ("spreadsheet", "sheet", "channel", "database", "repo")):
                if isinstance(param_val, str) and param_val.strip() and not _looks_like_opaque_id(param_val):
                    try:
                        resources = await introspect_app_resources(user_id=user_id, app=app, parameter_key=param_key)
                        if resources:
                            closest_match, score = find_closest_resource_match(param_val, resources, threshold=0.55)
                            if closest_match:
                                print(f"Info: Closest match resolved for step {s_num} '{param_key}': '{param_val}' -> '{closest_match}' (score: {score:.2f})")
                                params[param_key] = closest_match
                                resolved_keys.add((s_num, param_key))
                    except Exception as e:
                        print(f"Warning: Failed resolving closest match for step parameter '{param_key}' on '{app}': {e}")

    missing_params = blueprint_dict.get("missing_parameters")
    if not missing_params or not isinstance(missing_params, list):
        return blueprint_dict

    # Filter out missing parameters that were just resolved by closest-match
    if resolved_keys:
        missing_params = [
            p for p in missing_params
            if not (isinstance(p, dict) and (p.get("step_number"), p.get("parameter_key")) in resolved_keys)
        ]

    updated_params = []

    for param in missing_params:
        if not isinstance(param, dict):
            updated_params.append(param)
            continue

        p_copy = dict(param)
        s_num = p_copy.get("step_number")
        p_key = p_copy.get("parameter_key", "")

        app = None
        if s_num == "trigger":
            app = blueprint_dict.get("trigger", {}).get("event_app")
        elif isinstance(s_num, int):
            app = step_app_map.get(s_num)

        # STRICT FREEFORM GUARD: If parameter is not an introspectable resource container
        # (e.g. recipient email, subject, body, phone, text), strip any stale options
        # and ensure suggested_type is never "select".
        if not is_introspectable_resource_param(p_key, app or ""):
            if "options" in p_copy:
                del p_copy["options"]
            if p_copy.get("suggested_type") == "select":
                p_copy["suggested_type"] = "email" if any(k in p_key.lower() for k in ("email", "recipient", "to")) else "text"
            updated_params.append(p_copy)
            continue

        existing_options = p_copy.get("options")
        if existing_options and len(existing_options) > 0:
            updated_params.append(p_copy)
            continue

        if not app:
            updated_params.append(p_copy)
            continue

        try:
            resources = await introspect_app_resources(user_id=user_id, app=app, parameter_key=p_key)
            if resources:
                p_copy["options"] = resources
                p_copy["suggested_type"] = "select"

                # Check if user had a tentative value (e.g. from prompt or previous edit)
                tentative = p_copy.get("default_value") or p_copy.get("value")
                if tentative and isinstance(tentative, str):
                    closest_opt, opt_score = find_closest_resource_match(tentative, resources, threshold=0.55)
                    if closest_opt:
                        p_copy["default_value"] = closest_opt
        except Exception as e:
            print(f"Warning: Failed enriching missing param '{p_key}' for '{app}': {e}")

        updated_params.append(p_copy)

    blueprint_dict["missing_parameters"] = updated_params
    return blueprint_dict

