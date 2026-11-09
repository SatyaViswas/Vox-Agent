"""Text-to-Speech and Voice Intelligence Router.

Powered by Gnani Timbre v3.0 and Gnani Voice Cloning.
"""

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.gnani_service import (
    create_voice_clone_embedding,
    is_gnani_configured,
    stream_speech_timbre,
    synthesize_cloned_voice,
    synthesize_speech_timbre,
)

router = APIRouter(prefix="/tts", tags=["tts"])


class SynthesizeRequest(BaseModel):
    text: str = Field(..., description="Text to synthesize with optional audio tags (e.g. <excited>, <pauses>)")
    voice: str = Field(default="Shivani", description="Timbre v3.0 voice name (Shivani, Shubham, Avinash, etc.)")
    language: str = Field(default="hi-IN", description="Language code (e.g. hi-IN, en-IN, ta-IN, te-IN)")
    model: str = Field(default="timbre-v3.0", description="Model name")
    speed: float = Field(default=1.0, ge=0.85, le=1.15, description="Playback speed")
    container: str = Field(default="mp3", description="Audio container format (wav, mp3)")


class ClonedSynthesizeRequest(BaseModel):
    text: str = Field(..., description="Text to synthesize in cloned voice")
    speaker_embedding: Dict[str, Any] = Field(..., description="Voice clone embedding object")
    language: str = Field(default="hi-IN", description="Language code (e.g. hi-IN, en-IN, ta-IN)")
    sample_rate: int = Field(default=44100, description="Sample rate in Hz")
    container: str = Field(default="wav", description="Container format")


# Pre-indexed Timbre v3.0 catalog for UI voice pickers
TIMBRE_VOICES = [
    {"name": "Shivani", "gender": "Female", "persona": "Warm, empathetic", "description": "Warm, patient, empathy-first voice for support and assistance"},
    {"name": "Shubham", "gender": "Male", "persona": "Expressive, energetic", "description": "Energetic, confident voice for action updates and workflows"},
    {"name": "Avinash", "gender": "Male", "persona": "Professional", "description": "Deliberate, authoritative voice for reports and execution status"},
    {"name": "Devansh", "gender": "Male", "persona": "Conversational", "description": "Young, energetic conversational tone"},
    {"name": "Kalpana", "gender": "Female", "persona": "Warm, composed", "description": "Empathetic, clear voice for guidance and instructions"},
    {"name": "Lakshmi", "gender": "Female", "persona": "Expressive, storytelling", "description": "Expressive narration voice"},
    {"name": "Prakash", "gender": "Male", "persona": "Professional", "description": "Steady, deliberate professional voice"},
    {"name": "Riyaa", "gender": "Female", "persona": "Confident, authoritative", "description": "Confident, lively voice for proactive agents"},
    {"name": "Tarika", "gender": "Female", "persona": "Reassuring", "description": "Warm, reassuring voice for task confirmation"},
    {"name": "Vasudha", "gender": "Female", "persona": "Composed", "description": "Composed voice for narration"},
    {"name": "Yashraj", "gender": "Male", "persona": "Narrative", "description": "Warm narrative voice"},
    {"name": "Harshad", "gender": "Male", "persona": "Firm", "description": "Firm corporate voice"},
    {"name": "Chetana", "gender": "Female", "persona": "Empathetic", "description": "Gentle, helpful voice"},
]


@router.get("/voices")
def list_voices():
    """List supported Gnani Timbre voices and available audio tags."""
    return {
        "status": "success",
        "model": "timbre-v3.0",
        "voices": TIMBRE_VOICES,
        "supported_tags": [
            "<excited>",
            "<laugh>",
            "<giggle>",
            "<sigh>",
            "<pauses>",
            "<whispers>",
            "<clears throat>",
            "<coughs>",
            "<exhales>",
            "<shouting>",
            "<slow>",
            "<sniffles>",
            "<yawns>",
        ],
    }


@router.post("/synthesize")
def synthesize(request: SynthesizeRequest):
    """Synthesize speech audio from text using Gnani Timbre v3.0."""
    if not is_gnani_configured():
        raise HTTPException(
            status_code=503,
            detail="Gnani AI is not configured. Please set GNANI_API_KEY in backend/.env",
        )

    try:
        audio_bytes = synthesize_speech_timbre(
            text=request.text,
            voice=request.voice,
            language=request.language,
            model=request.model,
            speed=request.speed,
            container=request.container,
        )
        media_type = "audio/mpeg" if request.container == "mp3" else "audio/wav"
        return Response(content=audio_bytes, media_type=media_type)
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"[TTS Synthesize] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/stream")
def stream_synthesize_post(request: SynthesizeRequest):
    """Sub-400ms streaming speech synthesis chunked over HTTP/SSE via Gnani Timbre."""
    if not is_gnani_configured():
        raise HTTPException(
            status_code=503,
            detail="Gnani AI is not configured. Please set GNANI_API_KEY in backend/.env",
        )

    media_type = "audio/mpeg" if request.container == "mp3" else "audio/wav"
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }

    return StreamingResponse(
        stream_speech_timbre(
            text=request.text,
            voice=request.voice,
            language=request.language,
            model=request.model,
            speed=request.speed,
            container=request.container,
        ),
        media_type=media_type,
        headers=headers,
    )


@router.get("/stream")
def stream_synthesize_get(
    text: str,
    voice: str = "Shivani",
    language: str = "hi-IN",
    model: str = "timbre-v3.0",
    speed: float = 1.0,
    container: str = "mp3",
):
    """Direct URL streaming speech synthesis for HTML5 <audio> elements (TTFA <400ms)."""
    if not is_gnani_configured():
        raise HTTPException(
            status_code=503,
            detail="Gnani AI is not configured. Please set GNANI_API_KEY in backend/.env",
        )

    media_type = "audio/mpeg" if container == "mp3" else "audio/wav"
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }

    return StreamingResponse(
        stream_speech_timbre(
            text=text,
            voice=voice,
            language=language,
            model=model,
            speed=speed,
            container=container,
        ),
        media_type=media_type,
        headers=headers,
    )


@router.post("/voice-clone/embeddings")
async def extract_voice_embedding(audio_file: UploadFile = File(...)):
    """Extract a 768-dimensional speaker embedding from a reference audio file."""
    if not is_gnani_configured():
        raise HTTPException(
            status_code=503,
            detail="Gnani AI is not configured. Please set GNANI_API_KEY in backend/.env",
        )

    try:
        file_bytes = await audio_file.read()
        embedding = create_voice_clone_embedding(
            file_bytes=file_bytes, filename=audio_file.filename or "sample.wav"
        )
        return {"status": "success", "voice_clone_embedding": embedding}
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"[Voice Clone Embedding] Extraction error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/voice-clone/synthesize")
def synthesize_cloned(request: ClonedSynthesizeRequest):
    """Synthesize audio using the user's cloned voice embedding."""
    if not is_gnani_configured():
        raise HTTPException(
            status_code=503,
            detail="Gnani AI is not configured. Please set GNANI_API_KEY in backend/.env",
        )

    try:
        audio_bytes = synthesize_cloned_voice(
            text=request.text,
            speaker_embedding=request.speaker_embedding,
            language=request.language,
            sample_rate=request.sample_rate,
            container=request.container,
        )
        return Response(content=audio_bytes, media_type="audio/wav")
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"[Voice Clone Embedding] Extraction error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

