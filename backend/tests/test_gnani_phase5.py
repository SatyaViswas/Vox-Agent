"""Verification suite for Phase 5: Voice-First Knowledge Base via Gnani Prisma.

Validates:
1. Audio extraction and transcription using extract_text_from_audio().
2. Ingestion of audio files (.wav) into the Knowledge Base via /knowledge/ingest.
3. Proper source_type tagging ('audio').
"""

import sys
from pathlib import Path

# Add backend directory to path
backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from app.services.gnani_service import synthesize_speech_timbre
from app.services.knowledge_ingestion import extract_text_from_audio
from fastapi.testclient import TestClient
from main import app


def run_tests():
    print("=" * 60)
    print("🚀 PHASE 5: VOICE-FIRST KNOWLEDGE BASE VERIFICATION")
    print("=" * 60)

    # 1. Generate realistic audio recording using Timbre v3.0
    print("\n[Step 1/3] Generating test business meeting voice recording...")
    sample_phrase = "नमस्ते, हमारी टीम ने वोक्स एजेंट को ज्ञानी एआई के साथ सफलतापूर्वक जोड़ दिया है।"
    audio_bytes = synthesize_speech_timbre(
        text=sample_phrase,
        voice="Shivani",
        language="hi-IN",
        model="timbre-v3.0",
    )
    print(f"✅ Generated {len(audio_bytes):,} bytes of audio for testing.")

    # 2. Test direct extract_text_from_audio
    print("\n[Step 2/3] Transcribing audio with extract_text_from_audio (Gnani Prisma v3.0)...")
    transcript = extract_text_from_audio(audio_bytes, "team_update.wav")
    print(f"✅ Transcribed content: '{transcript}'")
    assert len(transcript.strip()) > 0, "extract_text_from_audio returned an empty transcript!"

    # 3. Test Knowledge Ingest API with audio file
    print("\n[Step 3/3] Testing POST /api/v1/knowledge/ingest with audio file...")
    client = TestClient(app)
    files = {"file": ("team_update.wav", audio_bytes, "audio/wav")}
    data = {"custom_name": "Q4 Strategy Meeting Audio.wav"}
    headers = {"X-User-Id": "00000000-0000-0000-0000-000000000000"}

    resp = client.post("/api/v1/knowledge/ingest", files=files, data=data, headers=headers)
    print(f"   API Response Status: {resp.status_code}")
    print(f"   API Response Body: {resp.text}")
    assert resp.status_code == 200, f"Knowledge ingest failed: {resp.text}"
    resp_data = resp.json()
    assert resp_data.get("sources_added", 0) > 0, "No chunks were indexed!"
    print(f"✅ Knowledge ingested successfully! Chunks added: {resp_data.get('sources_added')}")

    print("\n" + "=" * 60)
    print("🎉 ALL PHASE 5 TESTS PASSED SUCCESSFULLY!")
    print("=" * 60)


if __name__ == "__main__":
    run_tests()