"""Transcription service for VoxAgent.

Defaults to Gnani Prisma v3.0 with Automatic Language Identification (Auto-LID)
and domain keyterm boosting. Falls back to Groq Whisper if Gnani is not configured.
"""

from typing import List, Optional
import logging
from app.config import settings
from app.services.asr_context import get_user_context_keyterms
from app.services.gnani_service import is_gnani_configured, transcribe_audio_prisma

logger = logging.getLogger(__name__)

# Optional fallback to Groq if configured
_groq_client = None
if settings.GROQ_API_KEY:
    try:
        from groq import Groq
        _groq_client = Groq(api_key=settings.GROQ_API_KEY)
    except ImportError:
        _groq_client = None


def transcribe_audio(
    file_bytes: bytes,
    filename: str = "audio.wav",
    language_code: str = "indic-auto",
    format_style: str = "codemix",
    user_id: Optional[str] = None,
    custom_keyterms: Optional[List[str]] = None,
) -> str:
    """Transcribe speech audio, preferring Gnani Prisma v3.0 with context boosting.
    
    Returns the transcript string.
    """
    res = transcribe_audio_detailed(
        file_bytes=file_bytes,
        filename=filename,
        language_code=language_code,
        format_style=format_style,
        user_id=user_id,
        custom_keyterms=custom_keyterms,
    )
    return res.get("transcript", "")


def transcribe_audio_detailed(
    file_bytes: bytes,
    filename: str = "audio.wav",
    language_code: str = "indic-auto",
    format_style: str = "codemix",
    user_id: Optional[str] = None,
    custom_keyterms: Optional[List[str]] = None,
) -> dict:
    """Transcribe speech audio and return full metadata (transcript, language, latency, context boosting)."""
    # 1. Compile personalized context keyterms and topic
    keyterms, topic, user_count = get_user_context_keyterms(
        user_id=user_id,
        extra_terms=custom_keyterms,
    )

    # 2. Try Gnani Prisma v3.0 first
    if is_gnani_configured():
        try:
            gnani_result = transcribe_audio_prisma(
                file_bytes=file_bytes,
                filename=filename,
                language_code=language_code,
                format_style=format_style,
                keyterms=keyterms,
                topic=topic,
            )
            # Enrich with dynamic context boosting telemetry
            gnani_result["user_entities_boosted"] = user_count
            gnani_result["keyterms_applied"] = keyterms[:15]
            gnani_result["topic"] = topic
            return gnani_result
        except Exception as e:
            logger.warning(
                f"[Transcriber] Gnani Prisma v3.0 transcription failed ({e}). Checking Groq fallback..."
            )

    # 3. Fallback to Groq Whisper if available
    if _groq_client:
        try:
            logger.info("[Transcriber] Using Groq whisper-large-v3 fallback...")
            file_tuple = (filename or "audio.wav", file_bytes)
            transcription = _groq_client.audio.transcriptions.create(
                file=file_tuple,
                model="whisper-large-v3",
                response_format="json",
            )
            return {
                "success": True,
                "transcript": transcription.text,
                "detected_language_code": "unknown",
                "model": "groq/whisper-large-v3",
                "user_entities_boosted": 0,
                "keyterms_applied": [],
            }
        except Exception as groq_err:
            logger.error(f"[Transcriber] Groq fallback failed: {groq_err}")

    raise RuntimeError(
        "No transcription engine available. Please ensure GNANI_API_KEY or GROQ_API_KEY is configured."
    )
