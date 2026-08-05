"""MutAgent Phase 4 — LLMRepairMutator: last-resort recovery via an LLM,
used only after Phase 2 (retry) and Phase 3 (mutation_memory) have already
failed to resolve a step. Deliberately uses Groq rather than Gemini — this
project's planner/browser-agent/disambiguation calls all already depend on
Gemini, so routing self-healing's own last line of defense through the
same single vendor would mean a Gemini outage takes down both the
workflow AND its own recovery mechanism at once. Groq's SDK and API key
are already present in this project (used today for voice transcription).

Bounded to one attempt per step per run by the controller, independently
gated by MUTAGENT_LLM_REPAIR_ENABLED, and respects MUTAGENT_SHADOW_MODE.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from app.config import settings

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = (
    "You are a repair assistant for a single failed step in an automation "
    "workflow. You will be given the app and action being called, the "
    "parameters that were sent, and the error or question the target "
    "system returned. Reply with ONLY a JSON object of the exact shape "
    '{"parameters": {...}} containing the FULL corrected parameters dict '
    "(not just the changed keys — include every key that should remain). "
    'If you cannot determine a fix, reply with {"parameters": null}. '
    "Never invent app-specific IDs you were not given or cannot derive "
    "from the provided context."
)


async def propose_repair(
    *,
    app: str,
    action: str,
    parameters: dict[str, Any],
    error_text: str,
) -> Optional[dict[str, Any]]:
    """Returns a corrected parameters dict, or None if Groq is unavailable,
    errors, times out, or can't propose anything usable. Never raises —
    a failed repair attempt should fall back to the normal pause/failure
    path, not break the run."""
    if not settings.GROQ_API_KEY:
        return None
    try:
        from groq import AsyncGroq

        client = AsyncGroq(api_key=settings.GROQ_API_KEY)
        user_content = json.dumps(
            {
                "app": app,
                "action": action,
                "current_parameters": parameters,
                "error_or_question": error_text,
            }
        )
        response = await client.chat.completions.create(
            model=settings.MUTAGENT_REPAIR_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=20,
        )
        raw = response.choices[0].message.content
        parsed = json.loads(raw)
        fixed = parsed.get("parameters")
        return fixed if isinstance(fixed, dict) else None
    except Exception as e:
        logger.warning("LLMRepairMutator: Groq repair call failed for %s.%s: %s", app, action, e)
        return None
