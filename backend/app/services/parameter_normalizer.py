"""Universal SaaS & App Action Parameter Normalizer.

Translates human conversational input (spoken or typed) into the exact
technical syntax and formats required by SaaS tools and Composio actions.
Handles Google Sheets ranges, Slack/Discord channels, emails, dates, and 500+ apps.
"""

import json
import logging
import re
from typing import Any, Dict, Optional

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
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
]

# Fast regex patterns
_EMAIL_PATTERN = re.compile(r"([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)")
_A1_DASH_PATTERN = re.compile(r"^[a-zA-Z]+[0-9]+\s*[-–—]\s*[a-zA-Z]+[0-9]+$")
_FROM_A1_TO_B2_PATTERN = re.compile(r"from\s+([a-zA-Z]+[0-9]+)\s+to\s+([a-zA-Z]+[0-9]+)", re.I)


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
    if raw_value is None:
        return raw_value

    raw_str = str(raw_value).strip()
    if not raw_str:
        return raw_str

    # 1. Fast regex path (0ms latency)
    fast_result = _fast_rule_normalize(app, action, parameter_key, raw_str)
    if fast_result:
        logger.info(f"[ParameterNormalizer] Fast normalized '{raw_str}' -> '{fast_result}' for {app}.{parameter_key}")
        return fast_result

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
