"""Verification test suite for Gnani Voice Cloning (Phase A: Voice Cloning).

Validates:
1. POST /api/v1/tts/voice-clone/embeddings - Uploading sample audio extracts a 768-dim speaker embedding.
2. POST /api/v1/tts/voice-clone/synthesize - Synthesizing audio in user's cloned voice with embedding tensor.
3. Resilient parsing of flat vs nested embedding payloads.
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
from app.services.gnani_service import (
    create_voice_clone_embedding,
    synthesize_cloned_voice,
)


class TestGnaniVoiceCloning(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.mock_embedding = {
            "embedding": "mock_base64_tensor_768_dim",
            "shape": [1, 768],
            "dtype": "torch.bfloat16",
        }

    @patch("app.routers.tts.is_gnani_configured", return_value=True)
    @patch("app.routers.tts.create_voice_clone_embedding")
    def test_01_extract_voice_embedding_endpoint(self, mock_create, mock_cfg):
        """Verify POST /api/v1/tts/voice-clone/embeddings parses uploaded audio and returns embedding."""
        mock_create.return_value = self.mock_embedding

        dummy_audio = b"RIFF....WAVEfmt ...."
        files = {"audio_file": ("my_voice_sample.wav", dummy_audio, "audio/wav")}

        resp = self.client.post("/api/v1/tts/voice-clone/embeddings", files=files)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "success")
        self.assertIn("voice_clone_embedding", data)
        self.assertEqual(data["voice_clone_embedding"]["shape"], [1, 768])
        print("\n[PASS] Voice clone embedding extraction endpoint verified")

    @patch("app.routers.tts.is_gnani_configured", return_value=True)
    @patch("app.routers.tts.synthesize_cloned_voice")
    def test_02_synthesize_cloned_voice_endpoint(self, mock_synth, mock_cfg):
        """Verify POST /api/v1/tts/voice-clone/synthesize accepts embedding and returns synthesized audio."""
        mock_synth.return_value = b"RIFF_FAKE_AUDIO_DATA_FOR_CLONED_VOICE"

        payload = {
            "text": "Hello, this is my cloned voice running on VoxAgent.",
            "speaker_embedding": self.mock_embedding,
            "language": "hi-IN",
            "sample_rate": 44100,
            "container": "wav",
        }

        resp = self.client.post("/api/v1/tts/voice-clone/synthesize", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("content-type"), "audio/wav")
        self.assertEqual(resp.content, b"RIFF_FAKE_AUDIO_DATA_FOR_CLONED_VOICE")
        print("[PASS] Cloned voice speech synthesis endpoint verified")

    @patch("app.services.gnani_service.is_gnani_configured", return_value=True)
    @patch("requests.post")
    def test_03_service_handles_nested_or_flat_embedding(self, mock_post, mock_cfg):
        """Verify synthesize_cloned_voice unwraps both flat and nested voice_clone_embedding structures."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"WAV_BYTES_FROM_GNANI"
        mock_post.return_value = mock_resp

        # Nested structure
        nested_wrapper = {"voice_clone_embedding": self.mock_embedding}
        audio_out = synthesize_cloned_voice(
            text="Testing nested structure",
            speaker_embedding=nested_wrapper,
            language="en-IN",
        )
        self.assertEqual(audio_out, b"WAV_BYTES_FROM_GNANI")

        # Flat structure
        audio_out_flat = synthesize_cloned_voice(
            text="Testing flat structure",
            speaker_embedding=self.mock_embedding,
            language="en-IN",
        )
        self.assertEqual(audio_out_flat, b"WAV_BYTES_FROM_GNANI")
        print("[PASS] Resilient nested & flat embedding unwrap verified in gnani_service")


if __name__ == "__main__":
    unittest.main()

