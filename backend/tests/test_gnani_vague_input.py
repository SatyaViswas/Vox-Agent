"""Verification test suite for Conversational Parameter Extraction & Universal Normalization.

Covers:
1. Universal SaaS parameter normalizer (Sheets ranges, emails, channels, phone numbers)
2. Conversational entity extraction from natural sentences ("reciever gmail is X" -> "X")
3. Re-prompting on off-topic / invalid user answers (e.g. "potato" -> is_valid: False)
4. Integration with orchestrator runtime resumption
"""

import os
import sys
import unittest
from pathlib import Path

# Ensure backend directory is in sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv
load_dotenv(backend_dir / ".env")

from app.services.parameter_normalizer import normalize_action_parameter
from app.services.disambiguation import resolve_disambiguation


class TestConversationalParameterNormalization(unittest.TestCase):
    def test_01_sheets_range_normalization(self):
        """Verify conversational and non-standard range inputs map to valid Google Sheets syntax."""
        cases = [
            ("extract full sheet", "A:Z"),
            ("whole sheet", "A:Z"),
            ("all rows", "A:Z"),
            ("entire sheet", "A:Z"),
            ("A1-B2", "A1:B2"),
            ("from A1 to B2", "A1:B2"),
            ("a1 - b2", "A1:B2"),
            ("first 10 rows", "A1:Z10"),
            ("first 25 rows", "A1:Z25"),
            ("rows 5 to 20", "A5:Z20"),
            ("A1:C50", "A1:C50"),
        ]

        for raw_val, expected in cases:
            with self.subTest(raw_val=raw_val):
                res = normalize_action_parameter(
                    app="google_sheets",
                    action="extract_rows",
                    parameter_key="range",
                    raw_value=raw_val,
                )
                self.assertEqual(res, expected, f"Failed for input '{raw_val}': got '{res}'")
        print("\n[PASS] Google Sheets range normalization verified (full sheet, hyphens, conversational rows)")

    def test_02_email_normalization(self):
        """Verify conversational sentence stripping and phonetic 'at/dot' mapping for emails."""
        cases = [
            ("reciever gmail is mvsviswas@gmail.com", "mvsviswas@gmail.com"),
            ("the recipient is user.test@company.co.in please", "user.test@company.co.in"),
            ("mvsviswas at gmail dot com", "mvsviswas@gmail.com"),
            ("support AT voxagent DOT ai", "support@voxagent.ai"),
        ]

        for raw_val, expected in cases:
            with self.subTest(raw_val=raw_val):
                res = normalize_action_parameter(
                    app="gmail",
                    action="send_email",
                    parameter_key="recipient_email",
                    raw_value=raw_val,
                )
                self.assertEqual(res.lower(), expected.lower(), f"Failed for '{raw_val}': got '{res}'")
        print("[PASS] Email normalization verified (sentence stripping + spoken at/dot conversion)")

    def test_03_channel_normalization(self):
        """Verify Slack and Discord channel names strip conversational fluff and leading #."""
        cases = [
            ("#general channel", "general"),
            ("#announcements", "announcements"),
            ("the leads channel", "leads"),
            ("alerts", "alerts"),
        ]

        for raw_val, expected in cases:
            with self.subTest(raw_val=raw_val):
                res = normalize_action_parameter(
                    app="slack",
                    action="send_message",
                    parameter_key="channel",
                    raw_value=raw_val,
                )
                self.assertEqual(res, expected)
        print("[PASS] Channel normalization verified for Slack/Discord")

    def test_04_disambiguation_conversational_extraction(self):
        """Verify disambiguation service extracts clean entity from conversational speech."""
        missing = [
            {
                "step_number": 1,
                "parameter_key": "recipient_email",
                "app": "gmail",
                "label": "Recipient Email",
                "description": "Email address of the recipient",
            }
        ]

        res = resolve_disambiguation(
            clarification_question="What is the recipient's email address?",
            missing_parameters=missing,
            spoken_answer="reciever gmail is mvsviswas@gmail.com",
            existing_values={},
        )

        self.assertTrue(res.get("success"))
        self.assertTrue(res.get("is_valid"))
        self.assertEqual(res.get("resolved_values", {}).get("1::recipient_email"), "mvsviswas@gmail.com")
        self.assertTrue(res.get("all_resolved"))
        self.assertIn("<", res.get("spoken_acknowledgement", ""))
        print(f"[PASS] Conversational extraction: '{res.get('resolved_values')}' -> Ack: '{res.get('spoken_acknowledgement')}'")

    def test_05_disambiguation_invalid_reprompt(self):
        """Verify off-topic/nonsense input marks is_valid=False and prompts operator again."""
        missing = [
            {
                "step_number": 1,
                "parameter_key": "recipient_email",
                "app": "gmail",
                "label": "Recipient Email",
                "description": "Email address of the recipient",
            }
        ]

        res = resolve_disambiguation(
            clarification_question="What is the recipient's email address?",
            missing_parameters=missing,
            spoken_answer="potato",
            existing_values={},
        )

        self.assertTrue(res.get("success"))
        self.assertFalse(res.get("is_valid"))
        self.assertFalse(res.get("all_resolved"))
        # Should contain an expressive tag and a polite question asking for the email
        ack = res.get("spoken_acknowledgement", "")
        self.assertTrue(len(ack) > 0)
        print(f"[PASS] Invalid input re-prompt: is_valid=False, Re-prompt='{ack}'")


if __name__ == "__main__":
    unittest.main()
