import os
from groq import Groq
from app.config import settings

if settings.GROQ_API_KEY:
    client = Groq(api_key=settings.GROQ_API_KEY)
else:
    client = None

def transcribe_audio(file_bytes: bytes, filename: str) -> str:
    if not client:
        raise ValueError("GROQ_API_KEY is not configured.")
        
    # Groq's whisper requires a file-like object with a filename.
    # The SDK supports passing a tuple: (filename, file_bytes)
    file_tuple = (filename, file_bytes)
    
    transcription = client.audio.transcriptions.create(
        file=file_tuple,
        model="whisper-large-v3",
        response_format="json"
    )
    
    return transcription.text
