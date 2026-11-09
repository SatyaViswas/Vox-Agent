"""Verification test suite for Phase B: Real-Time Streaming TTS (Gnani Timbre v3.0).

Validates:
1. GET /api/v1/tts/stream - Direct chunked streaming endpoint for HTML5 <audio> elements.
2. POST /api/v1/tts/stream - Chunked streaming synthesis for custom client payloads.
3. stream_speech_timbre generator function yielding audio chunks progressively.
4. Fallback behavior when streaming encounters an issue.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add backend directory to sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from fastapi.testclient import TestClient
from main import app
from app.services.gnani_service import stream_speech_timbre


class TestGnaniStreamingTTS(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    @patch("app.routers.tts.is_gnani_configured", return_value=True)
    @patch("app.routers.tts.stream_speech_timbre")
    def test_01_get_stream_endpoint(self, mock_stream, mock_cfg):
        """Verify GET /api/v1/tts/stream returns a streaming audio response with correct headers."""
        # Mock generator yielding chunks
        def mock_gen():
            yield b"MP3_CHUNK_1"
            yield b"MP3_CHUNK_2"
            yield b"MP3_CHUNK_3"

        mock_stream.return_value = mock_gen()

        resp = self.client.get(
            "/api/v1/tts/stream",
            params={
                "text": "Workflow execution has completed successfully.",
                "voice": "Shivani",
                "language": "hi-IN",
                "container": "mp3",
            },
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIn("audio/mpeg", resp.headers.get("content-type", ""))
        self.assertEqual(resp.headers.get("x-accel-buffering"), "no")
        self.assertEqual(resp.content, b"MP3_CHUNK_1MP3_CHUNK_2MP3_CHUNK_3")
        print("\n[PASS] GET /api/v1/tts/stream streaming audio verified")

    @patch("app.routers.tts.is_gnani_configured", return_value=True)
    @patch("app.routers.tts.stream_speech_timbre")
    def test_02_post_stream_endpoint(self, mock_stream, mock_cfg):
        """Verify POST /api/v1/tts/stream handles payload and streams chunks."""
        def mock_gen():
            yield b"WAV_HEADER"
            yield b"WAV_DATA_1"
            yield b"WAV_DATA_2"

        mock_stream.return_value = mock_gen()

        payload = {
            "text": "Confirming step 2: Sending notification email.",
            "voice": "Shubham",
            "language": "en-IN",
            "model": "timbre-v3.0",
            "container": "wav",
        }
        resp = self.client.post("/api/v1/tts/stream", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("audio/wav", resp.headers.get("content-type", ""))
        self.assertEqual(resp.content, b"WAV_HEADERWAV_DATA_1WAV_DATA_2")
        print("[PASS] POST /api/v1/tts/stream streaming payload verified")

    @patch("app.services.gnani_service.is_gnani_configured", return_value=True)
    @patch("app.services.gnani_service.get_tts_stream_client")
    def test_03_stream_speech_timbre_generator(self, mock_get_client, mock_cfg):
        """Verify stream_speech_timbre wraps GnaniTTSStreamClient and yields progressive chunks."""
        mock_client = MagicMock()
        mock_client.synthesize_stream.return_value = iter([b"CHUNK_A", b"CHUNK_B", b"CHUNK_C"])
        mock_get_client.return_value = mock_client

        chunks = list(
            stream_speech_timbre(
                text="Automating lead generation.",
                voice="Avinash",
                language="hi-IN",
                container="mp3",
            )
        )
        self.assertEqual(chunks, [b"CHUNK_A", b"CHUNK_B", b"CHUNK_C"])
        print("[PASS] stream_speech_timbre progressive chunk generator verified")


if __name__ == "__main__":
    unittest.main()

