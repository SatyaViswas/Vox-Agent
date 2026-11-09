"""Gnani AI Sovereign Voice Intelligence Service.

Provides unified, production-grade access to:
- Gnani Prisma v3.0: Speech-to-Text (STT) with Auto-LID and Code-Mix
- Gnani Timbre v3.0: Text-to-Speech (TTS) with Expressive Audio Tags
- Gnani Voice Cloning: 768-dim Speaker Embeddings & Cloned Synthesis
- Gnani Batch STT: Asynchronous multi-file transcription
"""

import io
import logging
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterator, List, Optional, Tuple, Union

import requests
from app.config import settings

# Attempt import of gnani SDK
try:
    from gnani.stt import GnaniSTTClient, GnaniSTTBatchClient
    from gnani.tts import GnaniTTSClient, GnaniTTSStreamClient, AudioConfig
    _GNANI_SDK_AVAILABLE = True
except ImportError:
    _GNANI_SDK_AVAILABLE = False

logger = logging.getLogger(__name__)

# Default domain keyterms passed to Prisma v3.0 to prevent phonetic degradation of SaaS and automation tool names
DEFAULT_AUTOMATION_KEYTERMS = [
    "VoxAgent",
    "Composio",
    "Playwright",
    "Gmail",
    "Google Sheets",
    "Google Calendar",
    "Google Docs",
    "Slack",
    "Notion",
    "Airtable",
    "Telegram",
    "WhatsApp",
    "GitHub",
    "Trello",
    "Supabase",
    "FastAPI",
    "webhook",
    "workflow",
    "blueprint",
]

_stt_client: Optional[Any] = None
_tts_client: Optional[Any] = None
_tts_stream_client: Optional[Any] = None
_batch_stt_client: Optional[Any] = None


def is_gnani_configured() -> bool:
    """Check if a valid Gnani API key is configured in settings."""
    return bool(settings.GNANI_API_KEY and settings.GNANI_API_KEY.strip())


def get_stt_client() -> Any:
    """Lazy-load and return singleton GnaniSTTClient."""
    global _stt_client
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")
    if _stt_client is None:
        _stt_client = GnaniSTTClient(
            api_key=settings.GNANI_API_KEY,
            base_url=settings.GNANI_BASE_URL or "https://api.vachana.ai",
        )
    return _stt_client


def get_tts_client() -> Any:
    """Lazy-load and return singleton GnaniTTSClient."""
    global _tts_client
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")
    if _tts_client is None:
        _tts_client = GnaniTTSClient(
            api_key=settings.GNANI_API_KEY,
            base_url=settings.GNANI_BASE_URL or "https://api.vachana.ai",
        )
    return _tts_client


def get_tts_stream_client() -> Any:
    """Lazy-load and return singleton GnaniTTSStreamClient for low-latency chunked synthesis."""
    global _tts_stream_client
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")
    if _tts_stream_client is None:
        _tts_stream_client = GnaniTTSStreamClient(
            api_key=settings.GNANI_API_KEY,
            base_url=settings.GNANI_BASE_URL or "https://api.vachana.ai",
        )
    return _tts_stream_client


def get_batch_stt_client() -> Any:
    """Lazy-load and return singleton GnaniSTTBatchClient."""
    global _batch_stt_client
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")
    if _batch_stt_client is None:
        _batch_stt_client = GnaniSTTBatchClient(
            api_key=settings.GNANI_API_KEY,
            base_url=settings.GNANI_BASE_URL or "https://api.vachana.ai",
        )
    return _batch_stt_client


def ensure_supported_audio(
    file_bytes: bytes, filename: str
) -> Tuple[bytes, str]:
    """Ensure audio data is in a format Gnani Prisma/VC accepts (WAV, MP3, etc.).
    If WebM, M4A, or non-PCM audio is provided, converts to 16kHz mono 16-bit WAV via ffmpeg.
    """
    is_true_wav = (
        len(file_bytes) >= 12
        and file_bytes[:4] == b"RIFF"
        and file_bytes[8:12] == b"WAVE"
    )

    # If it is already a genuine RIFF WAVE file, pass directly
    if is_true_wav and Path(filename).suffix.lower() == ".wav":
        return file_bytes, filename

    # Resolve ffmpeg binary from standard locations
    ffmpeg_cmd = "ffmpeg"
    for candidate in ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]:
        import shutil
        if shutil.which(candidate):
            ffmpeg_cmd = candidate
            break

    ext = Path(filename).suffix.lower() or ".webm"
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as in_f:
            in_f.write(file_bytes)
            in_path = in_f.name

        out_path = in_path + "_converted.wav"

        cmd = [
            ffmpeg_cmd,
            "-y",
            "-i",
            in_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            out_path,
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

        with open(out_path, "rb") as out_f:
            converted_bytes = out_f.read()

        # Clean up temp files
        for p in [in_path, out_path]:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

        return converted_bytes, "converted_audio.wav"
    except Exception as e:
        logger.warning(
            f"FFmpeg conversion failed ({e}), falling back to original audio format."
        )
        return file_bytes, filename


# =========================================================================
# 1. Speech-to-Text (Gnani Prisma v3.0)
# =========================================================================

def transcribe_audio_prisma(
    file_bytes: bytes,
    filename: str = "audio.wav",
    language_code: str = "indic-auto",
    format_style: str = "codemix",
    keyterms: Optional[List[str]] = None,
    topic: Optional[str] = "automation workflows and software tools",
) -> Dict[str, Any]:
    """Transcribe speech using Gnani Prisma v3.0.
    
    Supports:
    - Automatic Language Identification (`indic-auto`)
    - Code-mixed output (`codemix` / `transcribe` / `verbatim` / `transliterate`)
    - Context hints via keyterms to recognize technical software names
    """
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")

    audio_data, clean_filename = ensure_supported_audio(file_bytes, filename)
    # Preserve order of keyterms so dynamic user entities stay at the top
    merged_keyterms = list(dict.fromkeys((keyterms or []) + DEFAULT_AUTOMATION_KEYTERMS))

    # Write to a named temporary file to pass to SDK / REST client
    suffix = Path(clean_filename).suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_audio:
        temp_audio.write(audio_data)
        temp_path = temp_audio.name

    try:
        client = get_stt_client()
        result = client.transcribe(
            audio=temp_path,
            language_code=language_code,
            model="prisma-v3.0",
            format=format_style,
            keywords=merged_keyterms,
            topic=topic,
        )

        transcript = result.get("transcript", "")
        detected_lang = result.get("detected_language_code") or result.get("language_code") or language_code

        logger.info(
            f"[Gnani Prisma STT] Transcribed successfully: len={len(transcript)}, lang={detected_lang}, model={result.get('model')}"
        )

        return {
            "success": True,
            "transcript": transcript,
            "detected_language_code": detected_lang,
            "model": result.get("model", "prisma-v3.0"),
            "processing_time": result.get("processing_time"),
            "raw": result,
        }
    except Exception as e:
        logger.error(f"[Gnani Prisma STT] Direct SDK call failed: {e}. Trying REST direct fallback...")
        # Direct REST fallback in case of SDK-level connection mismatch
        return _transcribe_rest_fallback(
            audio_data=audio_data,
            filename=clean_filename,
            language_code=language_code,
            format_style=format_style,
            keyterms=merged_keyterms,
            topic=topic,
        )
    finally:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass


def _transcribe_rest_fallback(
    audio_data: bytes,
    filename: str,
    language_code: str,
    format_style: str,
    keyterms: List[str],
    topic: Optional[str],
) -> Dict[str, Any]:
    """Direct HTTP fallback to POST https://api.vachana.ai/stt/v3."""
    url = f"{settings.GNANI_BASE_URL.rstrip('/')}/stt/v3"
    headers = {"X-API-Key-ID": settings.GNANI_API_KEY}

    files = {"audio_file": (filename, audio_data, "application/octet-stream")}
    data = {
        "model": "prisma-v3.0",
        "language_code": language_code,
        "format": format_style,
    }
    if keyterms:
        data["keywords"] = json.dumps(keyterms[:100], ensure_ascii=False)
        data["keyterms"] = ",".join(keyterms[:50])
    if topic:
        data["topic"] = topic[:1000]

    resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"Gnani STT REST failed ({resp.status_code}): {resp.text}")

    res_json = resp.json()
    return {
        "success": True,
        "transcript": res_json.get("transcript", ""),
        "detected_language_code": res_json.get("detected_language_code", language_code),
        "model": res_json.get("model", "prisma-v3.0"),
        "processing_time": res_json.get("processing_time"),
        "raw": res_json,
    }


# =========================================================================
# 2. Text-to-Speech (Gnani Timbre v3.0)
# =========================================================================

GNANI_LANGUAGE_MAP = {
    "te": "te-IN",
    "te-in": "te-IN",
    "hi": "hi-IN",
    "hi-in": "hi-IN",
    "ta": "ta-IN",
    "ta-in": "ta-IN",
    "kn": "kn-IN",
    "kn-in": "kn-IN",
    "bn": "bn-IN",
    "bn-in": "bn-IN",
    "mr": "mr-IN",
    "mr-in": "mr-IN",
    "gu": "gu-IN",
    "gu-in": "gu-IN",
    "pa": "pa-IN",
    "pa-in": "pa-IN",
    "ml": "ml-IN",
    "ml-in": "ml-IN",
    "en": "en-IN",
    "en-us": "en-IN",
    "en-in": "en-IN",
}


def normalize_gnani_language(lang: Optional[str]) -> str:
    """Normalize any language code (e.g. 'te', 'hi', 'en-US') to Gnani's BCP-47 tag."""
    if not lang:
        return "hi-IN"
    return GNANI_LANGUAGE_MAP.get(lang.strip().lower(), lang)


# Global re-entrant lock to prevent Gnani 429 concurrency errors ("Only 1 active request is allowed at a time")
import threading
import time
_gnani_tts_lock = threading.RLock()

def synthesize_speech_timbre(
    text: str,
    voice: str = "Shivani",
    language: str = "hi-IN",
    model: str = "timbre-v3.0",
    speed: float = 1.0,
    container: str = "mp3",
    output_file: Optional[Union[str, Path]] = None,
) -> bytes:
    """Synthesize expressive speech using Gnani Timbre.
    
    Supports:
    - 13 Timbre v3.0 voices (Shivani, Shubham, Avinash, Devansh, Kalpana, Lakshmi, Prakash, Riyaa, Tarika, Vasudha, Yashraj, Harshad, Chetana)
    - All 10 Indic languages per voice
    - Inline expressive tags: `<excited>`, `<laugh>`, `<pauses>`, `<whispers>`, `<giggle>`, `<sigh>`
    """
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")

    if not text or not text.strip():
        return b""

    # Clamping speed within Gnani valid range (0.85 to 1.15)
    clamped_speed = max(0.85, min(1.15, float(speed)))
    resolved_lang = normalize_gnani_language(language)

    with _gnani_tts_lock:
        try:
            client = get_tts_client()
            audio_bytes = client.synthesize(
                text=text.strip(),
                voice=voice,
                model=model,
                language=resolved_lang,
                speed=clamped_speed,
                output_file=output_file,
            )
            logger.info(
                f"[Gnani Timbre TTS] Synthesized audio ({len(audio_bytes)} bytes) | voice={voice} | lang={resolved_lang}"
            )
            return audio_bytes
        except Exception as e:
            logger.error(f"[Gnani Timbre TTS] SDK call error: {e}. Trying REST direct fallback...")
            return _synthesize_rest_fallback(
                text=text,
                voice=voice,
                language=resolved_lang,
                model=model,
                speed=clamped_speed,
                container=container,
                output_file=output_file,
            )


def _synthesize_rest_fallback(
    text: str,
    voice: str,
    language: str,
    model: str,
    speed: float,
    container: str,
    output_file: Optional[Union[str, Path]] = None,
) -> bytes:
    """Direct HTTP fallback to POST https://api.vachana.ai/api/v1/tts/inference."""
    url = f"{settings.GNANI_BASE_URL.rstrip('/')}/api/v1/tts/inference"
    headers = {
        "X-API-Key-ID": settings.GNANI_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text.strip(),
        "voice": voice,
        "model": model,
        "language": language,
        "speed": speed,
        "audio_config": {
            "sample_rate": 48000,
            "encoding": "linear_pcm",
            "container": container,
        },
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=45)
    if resp.status_code == 429:
        logger.warning("[Gnani TTS REST] 429 Rate limited. Waiting 0.5s for previous request to clear...")
        time.sleep(0.5)
        resp = requests.post(url, headers=headers, json=payload, timeout=45)

    if resp.status_code != 200:
        raise RuntimeError(f"Gnani TTS REST failed ({resp.status_code}): {resp.text}")

    audio_bytes = resp.content
    if output_file:
        with open(output_file, "wb") as f:
            f.write(audio_bytes)

    return audio_bytes


def stream_speech_timbre(
    text: str,
    voice: str = "Shivani",
    language: str = "hi-IN",
    model: str = "timbre-v3.0",
    speed: float = 1.0,
    container: str = "mp3",
    sample_rate: int = 48000,
) -> Iterator[bytes]:
    """Progressively stream synthesized audio chunks using Gnani Timbre SSE streaming.
    
    Time-To-First-Audio (TTFA) is sub-400ms, streaming audio chunks to client immediately.
    """
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")

    if not text or not text.strip():
        return

    clamped_speed = max(0.85, min(1.15, float(speed)))
    resolved_lang = normalize_gnani_language(language)

    # Serialize streaming with lock acquisition to respect Gnani 1-active-request limit
    with _gnani_tts_lock:
        try:
            client = get_tts_stream_client()
            audio_cfg = AudioConfig(
                container=container,
                sample_rate=sample_rate,
            )
            stream = client.synthesize_stream(
                text=text.strip(),
                voice=voice,
                model=model,
                language=resolved_lang,
                speed=clamped_speed,
                audio_config=audio_cfg,
            )
            for chunk in stream:
                if chunk:
                    yield chunk
        except Exception as e:
            logger.error(f"[Gnani Timbre Stream] Streaming exception ({e}). Falling back to full synthesis.")
            full_audio = synthesize_speech_timbre(
                text=text,
                voice=voice,
                language=resolved_lang,
                model=model,
                speed=speed,
                container=container,
            )
            if full_audio:
                yield full_audio


# =========================================================================
# 3. Voice Cloning (Gnani VC Embeddings & Cloned Synthesis)
# =========================================================================

def create_voice_clone_embedding(
    file_bytes: bytes, filename: str = "voice_sample.wav"
) -> Dict[str, Any]:
    """Generate a 768-dimensional speaker embedding from 5-30s reference voice audio.
    
    API: POST https://api.vachana.ai/api/v1/tts/voice-clone/embeddings
    Returns:
        dict: {"embedding": "<base64_tensor>", "shape": [1, 768], "dtype": "torch.bfloat16"}
    """
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")

    audio_data, clean_filename = ensure_supported_audio(file_bytes, filename)
    url = f"{settings.GNANI_BASE_URL.rstrip('/')}/api/v1/tts/voice-clone/embeddings"
    headers = {"X-API-Key-ID": settings.GNANI_API_KEY}
    mime_type = "audio/wav" if clean_filename.endswith(".wav") else "audio/mpeg"
    files = {"audio_file": (clean_filename, audio_data, mime_type)}

    resp = requests.post(url, headers=headers, files=files, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"Gnani Voice Clone Embedding failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    # Response structure: data -> voice_clone_embedding or top-level embedding
    embedding_obj = (
        data.get("data", {}).get("voice_clone_embedding")
        or data.get("voice_clone_embedding")
        or data
    )

    logger.info("[Gnani Voice Clone] Speaker embedding successfully generated.")
    return embedding_obj


def synthesize_cloned_voice(
    text: str,
    speaker_embedding: Dict[str, Any],
    language: str = "hi-IN",
    sample_rate: int = 44100,
    container: str = "wav",
) -> bytes:
    """Synthesize audio in the user's cloned voice using a saved speaker embedding.
    
    API: POST https://api.vachana.ai/api/v1/tts/inference with model 'vachana-vc-v1'
    """
    if not is_gnani_configured():
        raise ValueError("GNANI_API_KEY is not configured in backend/.env")

    emb_data = speaker_embedding.get("voice_clone_embedding") or speaker_embedding

    resolved_lang = normalize_gnani_language(language)

    url = f"{settings.GNANI_BASE_URL.rstrip('/')}/api/v1/tts/inference"
    headers = {
        "X-API-Key-ID": settings.GNANI_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text.strip(),
        "model": "vachana-vc-v1",
        "language": resolved_lang,
        "audio_config": {
            "sample_rate": sample_rate,
            "encoding": "linear_pcm",
            "container": container,
        },
        "speaker_embedding": {
            "embedding": emb_data.get("embedding"),
            "shape": emb_data.get("shape", [1, 768]),
            "dtype": emb_data.get("dtype", "torch.bfloat16"),
        },
    }

    with _gnani_tts_lock:
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
        if resp.status_code == 429:
            logger.warning("[Gnani Cloned Voice] 429 Rate limited. Waiting 0.5s for previous request to clear...")
            time.sleep(0.5)
            resp = requests.post(url, headers=headers, json=payload, timeout=60)

        if resp.status_code != 200:
            raise RuntimeError(f"Gnani Cloned Voice TTS failed ({resp.status_code}): {resp.text}")

        return resp.content


# =========================================================================
# 4. Batch Speech-to-Text (Knowledge Hub Audio Ingestion)
# =========================================================================

def create_batch_stt_job(
    file_paths: List[Union[str, Path]],
    language_code: str = "indic-auto",
) -> Any:
    """Submit a batch transcription job for long recordings / meeting audio."""
    client = get_batch_stt_client()
    str_paths = [str(p) for p in file_paths]
    job = client.create_job(
        str_paths,
        language_code=language_code,
        start=True,
    )
    logger.info(f"[Gnani Batch STT] Created batch job: {job.id}")
    return job

