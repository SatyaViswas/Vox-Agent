import unittest
from fastapi.testclient import TestClient
from main import app
from app.services.gnani_service import normalize_gnani_language
from app.services.voice_assistant import resolve_voice_intent, VoiceAssistantContext


class TestMultilingualVoiceContinuity(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_language_normalization(self):
        self.assertEqual(normalize_gnani_language("te"), "te-IN")
        self.assertEqual(normalize_gnani_language("hi"), "hi-IN")
        self.assertEqual(normalize_gnani_language("ta"), "ta-IN")
        self.assertEqual(normalize_gnani_language("kn"), "kn-IN")
        self.assertEqual(normalize_gnani_language("en-US"), "en-IN")
        self.assertEqual(normalize_gnani_language("en"), "en-IN")
        self.assertEqual(normalize_gnani_language("te-IN"), "te-IN")

    def test_telugu_voice_intent_resolution(self):
        ctx = VoiceAssistantContext()
        res_dark = resolve_voice_intent("switch to dark mode", ctx, language="te")
        self.assertEqual(res_dark.intent, "change_theme")
        self.assertIn("డార్క్", res_dark.spoken_acknowledgement)

        res_settings = resolve_voice_intent("open settings", ctx, language="te")
        self.assertEqual(res_settings.intent, "open_settings")
        self.assertIn("సెట్టింగ్‌లు", res_settings.spoken_acknowledgement)

        res_studio = resolve_voice_intent("go to studio", ctx, language="te")
        self.assertEqual(res_studio.intent, "navigate")
        self.assertIn("స్టూడియో", res_studio.spoken_acknowledgement)

        res_vault = resolve_voice_intent("open vault", ctx, language="te")
        self.assertEqual(res_vault.intent, "navigate")
        self.assertIn("వాల్ట్", res_vault.spoken_acknowledgement)

        res_new = resolve_voice_intent("email summary every morning", ctx, language="te")
        self.assertEqual(res_new.intent, "create_workflow")
        self.assertIn("వర్క్‌ఫ్లో", res_new.spoken_acknowledgement)

    def test_hindi_voice_intent_resolution(self):
        ctx = VoiceAssistantContext()
        res_dark = resolve_voice_intent("switch to dark mode", ctx, language="hi")
        self.assertEqual(res_dark.intent, "change_theme")
        self.assertIn("डार्क", res_dark.spoken_acknowledgement)

        res_settings = resolve_voice_intent("open settings", ctx, language="hi")
        self.assertEqual(res_settings.intent, "open_settings")
        self.assertIn("सेटिंग्स", res_settings.spoken_acknowledgement)

        res_new = resolve_voice_intent("create an agent to email team", ctx, language="hi")
        self.assertEqual(res_new.intent, "create_workflow")
        self.assertIn("तैयार कर रहे हैं", res_new.spoken_acknowledgement)

    def test_english_voice_intent_fallback(self):
        ctx = VoiceAssistantContext()
        res_dark = resolve_voice_intent("switch to dark mode", ctx, language="en")
        self.assertEqual(res_dark.intent, "change_theme")
        self.assertIn("Switched to dark mode", res_dark.spoken_acknowledgement)

    def test_voice_assistant_intent_endpoint_with_language(self):
        payload = {
            "spoken_text": "open settings",
            "language": "te-IN",
            "context": {
                "current_route": "/studio",
            },
        }
        resp = self.client.post("/api/v1/voice-assistant/intent", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["intent"], "open_settings")
        self.assertIn("సెట్టింగ్‌లు", data["spoken_acknowledgement"])

    def test_translate_endpoint_bidirectional(self):
        # 1. Translate clarification question to Telugu
        payload_te = {
            "text": "Please specify the Google Sheet name.",
            "target_lang": "te",
            "source_lang": "en",
        }
        resp_te = self.client.post("/api/v1/translate", json=payload_te)
        self.assertEqual(resp_te.status_code, 200)
        data_te = resp_te.json()
        self.assertIn("Google Sheet", data_te["translated_text"])
        self.assertTrue(any(ord(c) >= 0x0C00 and ord(c) <= 0x0C7F for c in data_te["translated_text"]))

        # 2. Translate clarification question to Hindi
        payload_hi = {
            "text": "Please specify the Google Sheet name.",
            "target_lang": "hi",
            "source_lang": "en",
        }
        resp_hi = self.client.post("/api/v1/translate", json=payload_hi)
        self.assertEqual(resp_hi.status_code, 200)
        data_hi = resp_hi.json()
        self.assertIn("Google Sheet", data_hi["translated_text"])
        self.assertTrue(any(ord(c) >= 0x0900 and ord(c) <= 0x097F for c in data_hi["translated_text"]))


if __name__ == "__main__":
    unittest.main()
