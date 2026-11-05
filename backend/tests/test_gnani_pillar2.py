"""Verification test suite for Pillar 2: Hands-Free Conversational Disambiguation Loop.

Tests:
1. Rule-based option matching for fast disambiguation.
2. LLM-powered disambiguation resolution with Hinglish / Indian language input.
3. Disambiguation API endpoint (/api/v1/disambiguate/resolve).
4. Full two-way voice roundtrip with Gnani Timbre TTS & Prisma STT.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add backend directory to sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv
load_dotenv(backend_dir / ".env")

from fastapi.testclient import TestClient
from main import app
from app.services.disambiguation import resolve_disambiguation, _rule_based_option_match


class TestConversationalDisambiguation(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_01_rule_based_option_matching(self):
        """Verify keyword and substring matching for common ambiguous options."""
        options = ["Telegram Bot", "Telegram Personal Account"]

        # Substring / keyword matches
        self.assertEqual(_rule_based_option_match("use personal account", options), "Telegram Personal Account")
        self.assertEqual(_rule_based_option_match("mera personal account", options), "Telegram Personal Account")
        self.assertEqual(_rule_based_option_match("bot se bhejo", options), "Telegram Bot")
        self.assertEqual(_rule_based_option_match("Telegram Bot", options), "Telegram Bot")
        print("\n[PASS] Rule-based option matching verified")

    def test_02_gemini_disambiguation_extraction_hinglish(self):
        """Verify LLM extracts exact parameter values and strips conversational Hinglish filler."""
        missing = [
            {
                "step_number": 1,
                "parameter_key": "spreadsheet_name",
                "label": "Spreadsheet Name",
                "description": "Name of the target Google Sheet",
            }
        ]
        q = "Which Google Sheet should I save the leads to?"
        spoken = "Outreach Leads 2026 sheet me daal do"

        res = resolve_disambiguation(
            clarification_question=q,
            missing_parameters=missing,
            spoken_answer=spoken,
        )

        self.assertTrue(res["success"])
        resolved = res.get("resolved_values", {})
        self.assertIn("1::spreadsheet_name", resolved)
        extracted = resolved["1::spreadsheet_name"]
        self.assertIn("Outreach Leads 2026", extracted)
        self.assertTrue(res["all_resolved"])
        self.assertIsInstance(res.get("spoken_acknowledgement"), str)
        print(f"[PASS] Hinglish extraction verified: '{spoken}' -> '{extracted}'")
        print(f"       Spoken acknowledgement: '{res['spoken_acknowledgement']}'")

    def test_03_gemini_select_option_disambiguation(self):
        """Verify LLM picks exact allowed option when prompted in natural speech."""
        missing = [
            {
                "step_number": 1,
                "parameter_key": "telegram_account_type",
                "label": "Telegram Account Type",
                "description": "Bot or personal account",
                "suggested_type": "select",
                "options": ["Telegram Bot", "Telegram Personal Account"],
            }
        ]
        q = "Should this run on your personal Telegram account, or your connected Telegram Bot?"
        spoken = "Personal account se bhejna hai"

        res = resolve_disambiguation(
            clarification_question=q,
            missing_parameters=missing,
            spoken_answer=spoken,
        )

        self.assertTrue(res["success"])
        resolved = res.get("resolved_values", {})
        self.assertEqual(resolved.get("1::telegram_account_type"), "Telegram Personal Account")
        self.assertTrue(res["all_resolved"])
        print(f"[PASS] Select option mapping verified: '{spoken}' -> '{resolved.get('1::telegram_account_type')}'")

    def test_04_disambiguate_api_endpoint(self):
        """Verify POST /api/v1/disambiguate/resolve endpoint returns proper schema."""
        payload = {
            "clarification_question": "Which channel should notifications be sent to?",
            "missing_parameters": [
                {
                    "step_number": 2,
                    "parameter_key": "channel_name",
                    "label": "Slack Channel",
                    "description": "Channel name",
                }
            ],
            "spoken_answer": "Send it to the general channel",
        }

        response = self.client.post("/api/v1/disambiguate/resolve", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIn("2::channel_name", data["resolved_values"])
        self.assertTrue(data["all_resolved"])
        self.assertIn("spoken_acknowledgement", data)
        print(f"[PASS] POST /api/v1/disambiguate/resolve returned: {data['resolved_values']}")

    def test_05_live_voice_disambiguation_loop(self):
        """End-to-End: Timbre TTS -> Prisma STT -> Disambiguation Engine -> Timbre Confirmation."""
        from app.services.gnani_service import is_gnani_configured, synthesize_speech_timbre
        from app.services.transcriber import transcribe_audio_detailed

        if not is_gnani_configured():
            self.skipTest("Gnani API is not configured")

        # 1. VoxAgent speaks clarification question
        question = "Should this run on your personal Telegram account, or your connected Telegram Bot?"
        q_audio = synthesize_speech_timbre(question, voice="Shivani", language="en-IN")
        self.assertGreater(len(q_audio), 1000)

        # 2. Operator speaks the answer
        operator_speech = "Personal account"
        answer_audio = synthesize_speech_timbre(operator_speech, voice="Avinash", language="en-IN")
        self.assertGreater(len(answer_audio), 1000)

        # 3. Prisma v3.0 transcribes operator speech
        stt_res = transcribe_audio_detailed(
            file_bytes=answer_audio,
            filename="user_answer.wav",
            user_id="operator-disambig-test",
            custom_keyterms=["Telegram Personal Account", "Telegram Bot"],
        )
        self.assertTrue(stt_res["success"])
        transcribed_answer = stt_res.get("transcript", "")
        self.assertGreater(len(transcribed_answer), 0)

        # 4. Disambiguation engine resolves parameter
        missing = [
            {
                "step_number": 1,
                "parameter_key": "telegram_account_type",
                "label": "Telegram Account Type",
                "suggested_type": "select",
                "options": ["Telegram Bot", "Telegram Personal Account"],
            }
        ]
        res = resolve_disambiguation(
            clarification_question=question,
            missing_parameters=missing,
            spoken_answer=transcribed_answer,
        )
        self.assertTrue(res["success"])
        self.assertEqual(res["resolved_values"].get("1::telegram_account_type"), "Telegram Personal Account")

        # 5. VoxAgent speaks acknowledgement
        ack_text = res.get("spoken_acknowledgement") or "Got it. Running on personal account."
        ack_audio = synthesize_speech_timbre(ack_text, voice="Shivani", language="en-IN")
        self.assertGreater(len(ack_audio), 1000)

        print(f"\n[PASS] Full Conversational Loop Verified!")
        print(f"       VoxAgent Asked:     '{question}'")
        print(f"       Operator Spoke:     '{operator_speech}'")
        print(f"       Prisma Transcribed: '{transcribed_answer}'")
        print(f"       Resolved Parameter: {res['resolved_values']}")
        print(f"       VoxAgent Spoke Back:'{ack_text}'")


if __name__ == "__main__":
    unittest.main()

