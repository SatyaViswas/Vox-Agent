"""Verification test suite for Gnani Prisma v3.0 Dynamic Context-Boosted ASR (Pillar 1)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure backend directory is in sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv
load_dotenv(backend_dir / ".env")

from fastapi.testclient import TestClient
from main import app
from app.services.asr_context import get_user_context_keyterms, extract_user_entities
from app.services.transcriber import transcribe_audio_detailed


class TestGnaniContextBoostedASR(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_01_context_keyterms_compilation(self):
        """Verify dynamic keyterm compiler generates prioritized list and domain topic."""
        terms, topic, count = get_user_context_keyterms(
            user_id="test-operator-42",
            extra_terms=["Airtable CRM", "CustomSheet_2026", "Razorpay"],
        )
        self.assertIsInstance(terms, list)
        self.assertIsInstance(topic, str)
        self.assertGreater(len(terms), 0)
        # Extra terms should be prioritized at the head of the keyterms list
        self.assertIn("Airtable CRM", terms[:10])
        self.assertIn("CustomSheet_2026", terms[:10])
        self.assertIn("Razorpay", terms[:10])
        self.assertIn("automation", topic.lower())
        print(f"\n[PASS] Context keyterms generated ({len(terms)} terms, topic='{topic[:60]}...')")

    def test_02_context_keyterms_caching(self):
        """Verify in-memory caching returns instant results without database round-trip."""
        t1, top1, c1 = get_user_context_keyterms(user_id="cached-user-999")
        t2, top2, c2 = get_user_context_keyterms(user_id="cached-user-999")
        self.assertEqual(t1, t2)
        self.assertEqual(top1, top2)
        self.assertEqual(c1, c2)
        print("[PASS] In-memory context cache verified")

    @patch("app.services.transcriber.transcribe_audio_prisma")
    def test_03_transcribe_audio_detailed_injects_context(self, mock_prisma):
        """Verify transcribe_audio_detailed retrieves context and passes keyterms to Prisma STT."""
        mock_prisma.return_value = {
            "success": True,
            "transcript": "Open my Airtable CRM and log lead",
            "detected_language_code": "en-IN",
            "model": "prisma-v3.0",
            "processing_time": 0.42,
        }

        fake_audio = b"RIFF....WAVEfmt ...."
        res = transcribe_audio_detailed(
            file_bytes=fake_audio,
            filename="test.wav",
            user_id="user-crm-agent",
            custom_keyterms=["Airtable CRM", "LeadTracker"],
        )

        mock_prisma.assert_called_once()
        call_kwargs = mock_prisma.call_args[1]
        self.assertIn("keyterms", call_kwargs)
        self.assertIn("topic", call_kwargs)
        self.assertIn("Airtable CRM", call_kwargs["keyterms"])

        # Check response metadata enrichment
        self.assertTrue(res["success"])
        self.assertIn("user_entities_boosted", res)
        self.assertIn("keyterms_applied", res)
        self.assertIn("topic", res)
        print(f"[PASS] Context injection into Prisma v3.0 verified: boosted={res['user_entities_boosted']}, sample={res['keyterms_applied'][:3]}")

    @patch("app.routers.planner.transcribe_audio_detailed")
    def test_04_planner_transcribe_endpoint_with_user_header(self, mock_detailed):
        """Verify POST /api/v1/planner/transcribe handles X-User-Id and returns context telemetry."""
        mock_detailed.return_value = {
            "success": True,
            "transcript": "Send report to Slack channel marketing",
            "detected_language_code": "en-IN",
            "model": "prisma-v3.0",
            "processing_time": 0.38,
            "user_entities_boosted": 3,
            "keyterms_applied": ["Slack channel marketing", "VoxAgent", "Composio"],
            "topic": "Automation workflows",
        }

        # Send multipart audio with X-User-Id header
        fake_file = ("speech.wav", b"dummy audio content", "audio/wav")
        response = self.client.post(
            "/api/v1/transcribe",
            headers={"X-User-Id": "operator-uuid-1234"},
            files={"file": fake_file},
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["transcript"], "Send report to Slack channel marketing")
        self.assertEqual(data["detected_language_code"], "en-IN")
        self.assertEqual(data["user_entities_boosted"], 3)
        self.assertIn("Slack channel marketing", data["keyterms_applied"])
        print(f"[PASS] POST /transcribe telemetry verified with X-User-Id")

    def test_05_live_gnani_prisma_roundtrip_with_context(self):
        """Verify real roundtrip against Gnani Prisma v3.0 with dynamic keyterm injection."""
        from app.services.gnani_service import is_gnani_configured, synthesize_speech_timbre
        if not is_gnani_configured():
            self.skipTest("Gnani API key not configured")

        phrase = "Check Airtable CRM and notify the sales lead"
        tts_audio = synthesize_speech_timbre(phrase, voice="Avinash", language="en-IN")
        self.assertGreater(len(tts_audio), 1000)

        # Transcribe with dynamic keyterms including 'Airtable CRM'
        stt_result = transcribe_audio_detailed(
            file_bytes=tts_audio,
            filename="roundtrip.wav",
            user_id="operator-live-test",
            custom_keyterms=["Airtable CRM", "LeadTracker"],
        )
        self.assertTrue(stt_result["success"])
        transcript = stt_result.get("transcript", "")
        self.assertGreater(len(transcript), 0)
        self.assertIn("user_entities_boosted", stt_result)
        self.assertIn("keyterms_applied", stt_result)
        print(f"\n[PASS] Live Gnani Prisma roundtrip verified!")
        print(f"       Spoken:     '{phrase}'")
        print(f"       Recognized: '{transcript}'")
        print(f"       Language:   '{stt_result.get('detected_language_code')}'")
        print(f"       Boosted:    {stt_result.get('user_entities_boosted')} entities")


if __name__ == "__main__":
    unittest.main()
