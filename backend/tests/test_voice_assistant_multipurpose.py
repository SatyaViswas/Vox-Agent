"""Unit tests for Multipurpose Voice Assistant Intent Resolution."""

import unittest
from app.services.voice_assistant import (
    VoiceAssistantContext,
    resolve_voice_intent,
)


class TestVoiceAssistantMultipurpose(unittest.TestCase):
    def test_navigate_intent(self):
        ctx = VoiceAssistantContext()
        res = resolve_voice_intent("open vault", ctx)
        self.assertEqual(res.intent, "navigate")
        self.assertEqual(res.route, "/vault")

        res_agents = resolve_voice_intent("go to agents", ctx)
        self.assertEqual(res_agents.intent, "navigate")
        self.assertEqual(res_agents.route, "/agents")

        res_studio = resolve_voice_intent("go to studio", ctx)
        self.assertEqual(res_studio.intent, "navigate")
        self.assertEqual(res_studio.route, "/studio")

    def test_theme_and_help_intent(self):
        ctx = VoiceAssistantContext()
        res_dark = resolve_voice_intent("switch to dark mode", ctx)
        self.assertEqual(res_dark.intent, "change_theme")
        self.assertEqual(res_dark.action, "dark")

        res_light = resolve_voice_intent("switch to light mode", ctx)
        self.assertEqual(res_light.intent, "change_theme")
        self.assertEqual(res_light.action, "light")

        res_help = resolve_voice_intent("what can you do", ctx)
        self.assertEqual(res_help.intent, "general")

        res_settings = resolve_voice_intent("open settings", ctx)
        self.assertEqual(res_settings.intent, "open_settings")

        res_voice_settings = resolve_voice_intent("change voice", ctx)
        self.assertEqual(res_voice_settings.intent, "open_settings")
        self.assertEqual(res_voice_settings.action, "voice")

    def test_resume_paused_approval(self):
        ctx = VoiceAssistantContext(
            has_live_clarification=True,
            live_question="Approve sending 25 emails",
            live_input_type="confirmation",
            live_agent_id="test-agent-1",
        )
        res = resolve_voice_intent("yes proceed with sending", ctx)
        self.assertEqual(res.intent, "resume_paused")
        self.assertEqual(res.action, "approve")
        self.assertEqual(res.agent_id, "test-agent-1")

        res_no = resolve_voice_intent("no cancel it", ctx)
        self.assertEqual(res_no.intent, "resume_paused")
        self.assertEqual(res_no.action, "reject")

    def test_resume_paused_parameter_normalization(self):
        ctx = VoiceAssistantContext(
            has_live_clarification=True,
            live_question="Which sheet range would you like to extract?",
            live_input_type="range",
            live_agent_id="test-agent-2",
        )
        res = resolve_voice_intent("extract full sheet", ctx)
        self.assertEqual(res.intent, "resume_paused")
        self.assertEqual(res.action, "resume")
        self.assertEqual(res.answer, "A:Z")

        res_range = resolve_voice_intent("A1 to B10", ctx)
        self.assertEqual(res_range.intent, "resume_paused")
        self.assertEqual(res_range.action, "resume")
        self.assertEqual(res_range.answer, "A1:B10")

    def test_update_blueprint_disambiguation(self):
        ctx = VoiceAssistantContext(
            has_blueprint=True,
            missing_parameters=[
                {
                    "step_number": 1,
                    "parameter_key": "recipient",
                    "description": "Recipient email address",
                }
            ],
            existing_disambig_values={},
        )
        res = resolve_voice_intent("mvsviswas@gmail.com", ctx)
        self.assertEqual(res.intent, "update_blueprint")
        self.assertIn("1::recipient", res.resolved_values)
        self.assertEqual(res.resolved_values["1::recipient"], "mvsviswas@gmail.com")

    def test_create_workflow(self):
        ctx = VoiceAssistantContext()
        res = resolve_voice_intent(
            "create an agent to monitor hacker news front page and email daily summary", ctx
        )
        self.assertEqual(res.intent, "create_workflow")
        self.assertIn("monitor hacker news", res.prompt.lower())
        self.assertEqual(res.route, "/studio")


if __name__ == "__main__":
    unittest.main()

