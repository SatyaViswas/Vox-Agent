"""Universal SaaS & App Action Parameter Normalizer.

Translates human conversational input (spoken or typed) into the exact
technical syntax and formats required by SaaS tools and Composio actions.
Handles Google Sheets ranges, Slack/Discord channels, emails, dates, and 500+ apps.
"""

import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional
from dateutil import parser as date_parser

from app.config import settings

logger = logging.getLogger(__name__)

# Initialize Gemini Client if available
_gemini_client = None
if settings.GEMINI_API_KEY:
    try:
        from google import genai
        _gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY)
    except Exception as e:
        logger.warning(f"[ParameterNormalizer] Could not initialize Gemini: {e}")

FALLBACK_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
]

# Fast regex patterns
_EMAIL_PATTERN = re.compile(r"([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)")
_A1_DASH_PATTERN = re.compile(r"^[a-zA-Z]+[0-9]+\s*[-–—]\s*[a-zA-Z]+[0-9]+$")
_FROM_A1_TO_B2_PATTERN = re.compile(r"from\s+([a-zA-Z]+[0-9]+)\s+to\s+([a-zA-Z]+[0-9]+)", re.I)

_DATETIME_PARAM_KEYWORDS = {
    "time_min", "timemin", "time_max", "timemax", "start_time", "starttime",
    "end_time", "endtime", "due_date", "duedate", "due", "date", "updated_min",
    "updatedmin", "since", "until", "created_after", "created_before", "after",
    "before", "event_time", "timestamp", "datetime", "schedule_time", "start_date",
    "end_date", "min_date", "max_date", "time", "scheduled_at"
}


def normalize_datetime_value(val_str: str, is_end_bound: bool = False, now: Optional[datetime] = None) -> Optional[str]:
    """Resolves human date/time expressions into RFC3339 UTC format ('YYYY-MM-DDTHH:MM:SSZ').
    
    Accepts:
    - Relative expressions: 'tomorrow', 'today', 'yesterday', 'now', 'tonight', 'next week'
    - Interval expressions: 'in 2 days', 'in 3 hours'
    - Bare dates: '2026-11-09' -> '2026-11-09T00:00:00Z' (or 23:59:59Z if end bound)
    - Date with spaces: '2026-11-09 10:00:00' -> '2026-11-09T10:00:00Z'
    - ISO timestamps with or without timezone
    """
    if not val_str or not isinstance(val_str, (str, int, float)):
        return None
    if not now:
        now = datetime.now(timezone.utc)
    s = str(val_str).strip().lower()

    # Relative day words
    if s == "tomorrow":
        d = now + timedelta(days=1)
        dt = d.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else d.replace(hour=0, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    if s == "today":
        dt = now.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else now.replace(hour=0, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    if s == "yesterday":
        d = now - timedelta(days=1)
        dt = d.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else d.replace(hour=0, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    if s in ("now", "current", "present"):
        return now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if s == "tonight":
        dt = now.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else now.replace(hour=20, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 'in N days'
    in_days_m = re.match(r"^in\s+(\d+)\s+days?$", s)
    if in_days_m:
        d = now + timedelta(days=int(in_days_m.group(1)))
        dt = d.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else d.replace(hour=0, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 'in N hours'
    in_hours_m = re.match(r"^in\s+(\d+)\s+hours?$", s)
    if in_hours_m:
        d = now + timedelta(hours=int(in_hours_m.group(1)))
        return d.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 'next week'
    if s == "next week":
        d = now + timedelta(days=7)
        dt = d.replace(hour=23, minute=59, second=59, microsecond=0) if is_end_bound else d.replace(hour=0, minute=0, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Try standard date parsing with dateutil
    try:
        # Check if already full RFC3339 with explicit offset
        if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$", str(val_str).strip()):
            return str(val_str).strip()
        parsed = date_parser.parse(str(val_str).strip())
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            parsed = parsed.astimezone(timezone.utc)
        if is_end_bound and parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0:
            parsed = parsed.replace(hour=23, minute=59, second=59)
        return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        pass

    return None


def unwrap_dict_for_field(parameter_key: str, val_dict: dict) -> Optional[str]:
    """Extracts the intended scalar field when a dictionary payload (e.g. {{trigger_data}})
    is passed to an action parameter expecting a string."""
    if not isinstance(val_dict, dict):
        return None
    k_lower = parameter_key.lower()

    # Email / recipient field
    if any(term in k_lower for term in ("email", "recipient", "to", "from")):
        for prop in ("sender", "email", "from", "from_email", "recipient", "address", "to"):
            if prop in val_dict and isinstance(val_dict[prop], str) and "@" in val_dict[prop]:
                return val_dict[prop].strip()
        # Scan string values for email pattern
        for v in val_dict.values():
            if isinstance(v, str):
                m = _EMAIL_PATTERN.search(v)
                if m:
                    return m.group(1).strip()
            elif isinstance(v, dict):
                sub = unwrap_dict_for_field(parameter_key, v)
                if sub:
                    return sub

    # Message / body / content field
    if any(term in k_lower for term in ("body", "message", "content", "text", "description", "notes")):
        for prop in ("message_text", "body", "text", "content", "description", "message", "summary"):
            if prop in val_dict and isinstance(val_dict[prop], str) and val_dict[prop].strip():
                return val_dict[prop].strip()

    # Subject / title field
    if any(term in k_lower for term in ("subject", "title", "heading", "summary")):
        for prop in ("subject", "title", "summary", "heading"):
            if prop in val_dict and isinstance(val_dict[prop], str) and val_dict[prop].strip():
                return val_dict[prop].strip()

    # Target / chat_id / phone
    if any(term in k_lower for term in ("target", "chat_id", "chat", "user_id", "phone")):
        for prop in ("sender", "chat_id", "target", "user_id", "phone_number", "phone"):
            if prop in val_dict and str(val_dict[prop]).strip():
                return str(val_dict[prop]).strip()

    # Spreadsheet / Document ID or Name
    if any(term in k_lower for term in ("spreadsheet", "sheet", "document_id", "file_id")):
        for prop in ("spreadsheetId", "spreadsheet_id", "id", "spreadsheetUrl", "title", "name"):
            if prop in val_dict and str(val_dict[prop]).strip():
                return str(val_dict[prop]).strip()
        if "data" in val_dict and isinstance(val_dict["data"], dict):
            sub = unwrap_dict_for_field(parameter_key, val_dict["data"])
            if sub:
                return sub

    return None


def _fast_rule_normalize(
    app: str,
    action: str,
    parameter_key: str,
    raw_str: str,
) -> Optional[str]:
    """Instant regex and heuristic normalization for common patterns."""
    lowered = raw_str.strip().lower()

    # 1. Email normalization (Gmail, Outlook, Notification tools)
    if "email" in parameter_key.lower() or "recipient" in parameter_key.lower():
        # Check if direct email exists inside sentence e.g. "receiver email is foo@bar.com"
        match = _EMAIL_PATTERN.search(raw_str)
        if match:
            return match.group(1).strip()
        # Spoken format: "satya at gmail dot com"
        spoken_email = re.sub(r"\s+at\s+", "@", lowered)
        spoken_email = re.sub(r"\s+dot\s+", ".", spoken_email)
        spoken_match = _EMAIL_PATTERN.search(spoken_email)
        if spoken_match:
            return spoken_match.group(1).strip()

    # 2. Google Sheets range normalization
    if "sheet" in app.lower() or "sheets" in action.lower():
        if "range" in parameter_key.lower():
            # "full sheet", "all rows", "whole sheet", "entire sheet"
            if any(term in lowered for term in ["full sheet", "whole sheet", "all rows", "entire sheet", "everything", "all data"]):
                return "A:Z"
            # "A1-B2" or "A1 - B2" -> "A1:B2"
            if _A1_DASH_PATTERN.match(raw_str.strip()):
                return re.sub(r"\s*[-–—]\s*", ":", raw_str.strip().upper())
            # "from A1 to B2" -> "A1:B2"
            from_to_match = _FROM_A1_TO_B2_PATTERN.search(raw_str)
            if from_to_match:
                return f"{from_to_match.group(1).upper()}:{from_to_match.group(2).upper()}"
            # "first 10 rows" -> "A1:Z10"
            first_n = re.search(r"first\s+(\d+)\s+rows", lowered)
            if first_n:
                return f"A1:Z{first_n.group(1)}"

    # 3. Channel names (Slack, Discord, Telegram)
    if parameter_key.lower() in ["channel", "channel_name", "channel_id"]:
        # Strip leading #, "the ", or "channel" word e.g. "#general channel" -> "general", "the leads channel" -> "leads"
        clean_chan = re.sub(r"^#", "", raw_str.strip())
        clean_chan = re.sub(r"^(the\s+)", "", clean_chan, flags=re.I).strip()
        clean_chan = re.sub(r"\s+channel$", "", clean_chan, flags=re.I).strip()
        if clean_chan:
            return clean_chan

    # 4. Sheet / Spreadsheet names
    if any(k in parameter_key.lower() for k in ("spreadsheet_name", "sheet_name", "spreadsheet_id", "sheet")):
        # Strip conversational wrappers e.g. "sheet named Expenses" -> "Expenses", "use the Budget sheet" -> "Budget"
        clean_sheet = re.sub(r"^(use\s+|open\s+|the\s+)?(sheet|spreadsheet)(\s+named|\s+called)?\s+", "", raw_str, flags=re.I).strip()
        clean_sheet = re.sub(r"\s+(sheet|spreadsheet)$", "", clean_sheet, flags=re.I).strip()
        clean_sheet = clean_sheet.strip("\"' ")
        if clean_sheet:
            return clean_sheet

    # 5. Date / Time normalization (Google Calendar, Tasks, Notion, Linear, Jira, etc.)
    param_k_clean = re.sub(r"[^a-z0-9_]", "", parameter_key.lower())
    is_dt_param = (
        param_k_clean in _DATETIME_PARAM_KEYWORDS
        or any(k in param_k_clean for k in ("time", "date", "due", "since", "until", "timestamp"))
    )
    if is_dt_param:
        is_end = any(term in param_k_clean for term in ("max", "end", "until", "before", "to"))
        norm_dt = normalize_datetime_value(raw_str, is_end_bound=is_end)
        if norm_dt:
            return norm_dt

    # 6. GitHub search queries / q
    if "github" in app.lower() and parameter_key.lower() in ("q", "query"):
        if any(term in lowered for term in ("urgent", "issues", "open issues", "my issues", "action items")):
            return "is:issue state:open involves:@me"

    return None


def normalize_action_parameter(
    app: str,
    action: str,
    parameter_key: str,
    raw_value: Any,
    parameter_description: Optional[str] = None,
) -> Any:
    """Normalize a raw user-provided input into valid technical tool syntax.
    
    Works generically across Google Sheets, Gmail, Slack, and 500+ Composio tools.
    """
    if isinstance(raw_value, dict):
        unwrapped = unwrap_dict_for_field(parameter_key, raw_value)
        if unwrapped is not None:
            raw_value = unwrapped
        else:
            return raw_value

    if raw_value is None or isinstance(raw_value, (bool, int, float, list)):
        return raw_value

    raw_str = str(raw_value).strip()
    if not raw_str:
        return raw_str

    # 1. Fast regex path (0ms latency)
    fast_result = _fast_rule_normalize(app, action, parameter_key, raw_str)
    if fast_result:
        logger.info(f"[ParameterNormalizer] Fast normalized '{raw_str}' -> '{fast_result}' for {app}.{parameter_key}")
        return fast_result

    # Skip expensive LLM normalization for free-form text/content fields, prompts, or long payloads
    _CONTENT_PARAM_KEYS = {
        "prompt", "message", "text", "body", "content", "description", "summary",
        "subject", "note", "instructions", "answer", "reply", "caption", "html",
        "markdown", "values", "data", "rows", "snippet",
    }
    if parameter_key.lower().strip() in _CONTENT_PARAM_KEYS or len(raw_str) > 150 or "\n" in raw_str:
        return raw_str

    # If it's already a clean ID or short technical value without filler, keep as-is
    if len(raw_str.split()) == 1 and not re.search(r"[#]", raw_str):
        return raw_str

    # 2. General-purpose LLM normalizer for 500+ apps
    if _gemini_client:
        try:
            from google.genai import types

            prompt = f"""You are a SaaS Automation Parameter Normalizer.
App: {app}
Action: {action}
Parameter Key: {parameter_key}
Description: {parameter_description or 'Input parameter for this action'}
User's raw conversational input: "{raw_str}"

Task:
Convert the user's natural language input into the exact syntax required by this API tool.
- For Google Sheets 'range': 'extract full sheet' or 'all' -> 'A:Z'; 'A1-B2' -> 'A1:B2'; 'first 50 rows' -> 'A1:Z50'.
- For channels: strip '#' and filler words.
- For emails: extract pure email address (e.g. 'receiver is foo@bar.com' -> 'foo@bar.com').
- For names/titles: strip conversational wrapper ('sheet name is X' -> 'X').
- For dates/times: normalize to ISO 8601 string.
- If the user's answer is already clean, keep it unchanged.

Respond with ONLY a strict JSON object:
{{
  "normalized_value": "<clean_value>"
}}
"""

            for model_name in FALLBACK_MODELS:
                try:
                    response = _gemini_client.models.generate_content(
                        model=model_name,
                        contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                            temperature=0.0,
                        ),
                    )
                    data = json.loads(response.text.strip())
                    norm_val = data.get("normalized_value")
                    if norm_val is not None:
                        logger.info(
                            f"[ParameterNormalizer] LLM normalized '{raw_str}' -> '{norm_val}' for {app}.{parameter_key}"
                        )
                        return norm_val
                except Exception as model_err:
                    logger.warning(f"[ParameterNormalizer] {model_name} failed: {model_err}")
                    continue

        except Exception as e:
            logger.warning(f"[ParameterNormalizer] LLM normalization failed: {e}")

    # Fallback to cleaned raw string
    return raw_str
