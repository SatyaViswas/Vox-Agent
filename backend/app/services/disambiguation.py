"""Disambiguation & Conversational Parameter Resolution Service.

Resolves natural language or speech answers from operators into structured
blueprint parameters using fast LLM extraction + rule-based fuzzy matching.
Powers the Hands-Free Disambiguation Loop with Gnani Prisma STT & Timbre TTS.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Initialize Gemini Client if available
_gemini_client = None
if settings.GEMINI_API_KEY:
    try:
        from google import genai
        _gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY)
    except Exception as e:
        logger.warning(f"[Disambiguation] Could not initialize Gemini client: {e}")


def _format_param_key(param: Dict[str, Any]) -> str:
    step = param.get("step_number")
    key = param.get("parameter_key")
    return f"{step}::{key}"


def _rule_based_option_match(spoken_text: str, options: List[str]) -> Optional[str]:
    """Fuzzy/substring match spoken text against allowed option strings."""
    if not options or not spoken_text:
        return None
    spoken_low = spoken_text.lower().strip()

    # Exact or contained match
    for opt in options:
        opt_low = opt.lower()
        if opt_low in spoken_low or spoken_low in opt_low:
            return opt

    # Keyword heuristics for Telegram
    if "personal" in spoken_low or "khud" in spoken_low or "mera" in spoken_low:
        for opt in options:
            if "personal" in opt.lower():
                return opt
    if "bot" in spoken_low:
        for opt in options:
            if "bot" in opt.lower():
                return opt

    return None


def _find_matching_param_key(missing_parameters: List[Dict[str, Any]], raw_key: str) -> Optional[str]:
    """Resolve an LLM output key (with or without step prefix) to the canonical step::key format."""
    for p in missing_parameters:
        canonical = _format_param_key(p)
        if raw_key == canonical:
            return canonical
        if raw_key == p.get("parameter_key"):
            return canonical
        if raw_key.endswith(f"::{p.get('parameter_key')}"):
            return canonical
    return None


def resolve_disambiguation(
    clarification_question: Optional[str],
    missing_parameters: List[Dict[str, Any]],
    spoken_answer: str,
    existing_values: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Resolve spoken natural language answers into blueprint parameters.

    Returns:
        {
            "success": bool,
            "resolved_values": Dict[str, str], # {"<step>::<key>": "<value>"}
            "all_resolved": bool,
            "is_valid": bool,
            "spoken_acknowledgement": str, # Expressive Timbre text with audio tags
        }
    """
    from app.services.parameter_normalizer import normalize_action_parameter

    resolved_values: Dict[str, str] = dict(existing_values or {})
    spoken_clean = spoken_answer.strip()

    if not spoken_clean or not missing_parameters:
        return {
            "success": False,
            "resolved_values": resolved_values,
            "all_resolved": False,
            "is_valid": False,
            "spoken_acknowledgement": "<curious> I did not catch that. Could you please repeat your answer? </curious>",
        }

    # 1. Try LLM extraction (Gemini) for high accuracy, validation, and conversational extraction
    if _gemini_client:
        try:
            from google.genai import types

            system_instruction = (
                "You are VoxAgent's Intelligent Disambiguation Engine. "
                "The user was asked a clarification question to fill missing details for a software workflow. "
                "Your job is to parse their spoken answer (which may be in conversational English, Hindi, or Hinglish) "
                "and extract the clean, intended value for each missing parameter.\n\n"
                "Extraction Rules:\n"
                "- Strip all conversational phrasing (e.g. 'receiver gmail is X' -> 'X', 'sheet name is Y' -> 'Y').\n"
                "- For emails: extract valid email address. Convert spoken forms like 'satya at gmail dot com' -> 'satya@gmail.com'.\n"
                "- For Google Sheets ranges: 'extract full sheet' or 'all rows' -> 'A:Z'; 'A1-B2' -> 'A1:B2'.\n"
                "- For Telegram options: map 'personal' -> 'Telegram Personal Account', 'bot' -> 'Telegram Bot'.\n"
                "- For channels: strip leading '#' and 'channel'.\n"
                "- Validate the answer: if the operator answered with something off-topic (e.g. asked for email, user said 'potato' or 'coffee'), "
                "set is_valid to false and provide a polite spoken re-prompt asking for the specific information needed.\n"
                "- Provide a short, warm spoken confirmation (under 15 words) with an expressive Gnani audio tag (<happy>, <excited>, or <curious>)."
            )

            prompt = f"""Clarification Question: "{clarification_question or 'Please provide the missing details.'}"
Missing Parameters:
{json.dumps(missing_parameters, indent=2)}

Operator's Spoken Answer:
"{spoken_clean}"

Output a strict JSON object:
{{
  "resolved_values": {{
    "<step_number>::<parameter_key>": "<extracted_value>"
  }},
  "is_valid": true,
  "spoken_acknowledgement": "<voice response>"
}}
"""

            for model_name in [
                "gemini-3.5-flash-lite",
                "gemini-3.5-flash",
                "gemini-3.6-flash",
                "gemini-3-flash-preview",
            ]:
                try:
                    response = _gemini_client.models.generate_content(
                        model=model_name,
                        contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
                        config=types.GenerateContentConfig(
                            system_instruction=system_instruction,
                            response_mime_type="application/json",
                            temperature=0.1,
                        ),
                    )

                    raw_text = response.text.strip()
                    data = json.loads(raw_text)
                    is_valid = data.get("is_valid", True)
                    spoken_ack = data.get("spoken_acknowledgement") or "<happy> Got it, updated the workflow settings. </happy>"

                    if not is_valid:
                        # User gave an off-topic or invalid answer — ask again politely
                        logger.info(f"[Disambiguation] Input '{spoken_clean}' judged invalid, prompting user again.")
                        return {
                            "success": True,
                            "resolved_values": resolved_values,
                            "all_resolved": False,
                            "is_valid": False,
                            "spoken_acknowledgement": spoken_ack,
                        }

                    newly_resolved = data.get("resolved_values", {})
                    for raw_k, val in newly_resolved.items():
                        canonical_k = _find_matching_param_key(missing_parameters, raw_k)
                        if canonical_k and val:
                            # Find param definition
                            param_def = next((p for p in missing_parameters if _format_param_key(p) == canonical_k), None)
                            param_key_name = param_def.get("parameter_key", "") if param_def else raw_k
                            
                            # If parameter has explicit select options, map to the exact allowed option
                            if param_def and param_def.get("options"):
                                opt_match = _rule_based_option_match(str(val), param_def["options"])
                                normalized_val = opt_match if opt_match else val
                            else:
                                normalized_val = normalize_action_parameter(
                                    app=param_def.get("app", "") if param_def else "",
                                    action="",
                                    parameter_key=param_key_name,
                                    raw_value=val,
                                    parameter_description=param_def.get("description", "") if param_def else None,
                                )
                            resolved_values[canonical_k] = str(normalized_val).strip()

                    all_resolved = all(
                        _format_param_key(p) in resolved_values and bool(resolved_values[_format_param_key(p)].strip())
                        for p in missing_parameters
                    )

                    return {
                        "success": True,
                        "resolved_values": resolved_values,
                        "all_resolved": all_resolved,
                        "is_valid": True,
                        "spoken_acknowledgement": spoken_ack,
                    }
                except Exception as model_err:
                    logger.warning(f"[Disambiguation] {model_name} attempt failed ({model_err}), trying fallback...")
                    continue
        except Exception as e:
            logger.warning(f"[Disambiguation] LLM extraction failed ({e}), falling back to heuristic matching...")

    # 2. Rule-based fallback
    for param in missing_parameters:
        pkey = _format_param_key(param)
        if pkey in resolved_values:
            continue

        options = param.get("options")
        if options:
            match = _rule_based_option_match(spoken_clean, options)
            if match:
                resolved_values[pkey] = match
        else:
            # Normalize with fast rule extractor
            norm_val = normalize_action_parameter(
                app=param.get("app", ""),
                action="",
                parameter_key=param.get("parameter_key", ""),
                raw_value=spoken_clean,
                parameter_description=param.get("description"),
            )
            resolved_values[pkey] = str(norm_val).strip()

    all_resolved = all(
        _format_param_key(p) in resolved_values and bool(resolved_values[_format_param_key(p)].strip())
        for p in missing_parameters
    )

    sample_val = next(iter(resolved_values.values()), spoken_clean)
    spoken_ack = f"<happy> Got it. Configured with {sample_val}. </happy>"

    return {
        "success": True,
        "resolved_values": resolved_values,
        "all_resolved": all_resolved,
        "is_valid": True,
        "spoken_acknowledgement": spoken_ack,
    }
