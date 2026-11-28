import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.orchestrator import _dispatch_action
from app.services.planner import _apply_route_fallback_and_required_apps
from app.services.telegram_client_engine import (
    TELEGRAM_BOT_APP_NAME,
    TELEGRAM_PERSONAL_APP_NAME,
    execute_telegram_client_action,
)


class TestTelegramReplyRouting(unittest.IsolatedAsyncioTestCase):
    def test_planner_enforces_bot_app_when_replying_to_bot_trigger(self):
        plan = {
            "trigger": {"type": "webhook", "event_app": "Telegram Bot"},
            "steps": [
                {
                    "step_number": 1,
                    "route": "telegram_client",
                    "app": "Telegram Personal Account",
                    "action": "SEND_MESSAGE",
                    "parameters": {"target": "{{trigger_chat_id}}", "text": "Hello!"},
                }
            ],
            "required_apps": [],
        }
        _apply_route_fallback_and_required_apps(plan, "When bot gets message reply back")
        self.assertEqual(plan["steps"][0]["app"], TELEGRAM_BOT_APP_NAME)
        self.assertIn(TELEGRAM_BOT_APP_NAME, plan["required_apps"])
        self.assertNotIn(TELEGRAM_PERSONAL_APP_NAME, plan["required_apps"])

    async def test_orchestrator_routes_bot_trigger_reply_via_bot(self):
        mock_exec = AsyncMock(return_value={"status": "success", "output": {"message_id": 1}})
        with patch("app.services.orchestrator.execute_telegram_client_action", mock_exec):
            blueprint = {"trigger": {"type": "webhook", "event_app": "Telegram Bot"}}
            steps = [
                {
                    "step_number": 1,
                    "route": "telegram_client",
                    "app": "Telegram Personal Account",
                    "action": "SEND_MESSAGE",
                    "parameters": {"target": "{{trigger_chat_id}}", "text": "Hi"},
                }
            ]
            await _dispatch_action(
                agent_id="a1",
                user_id="u1",
                blueprint=blueprint,
                steps=steps,
                index=0,
                step_number=1,
                step_results={},
                app="Telegram Personal Account",
                action="SEND_MESSAGE",
                route="telegram_client",
                parameters={"target": "123456", "text": "Hi"},
            )
        self.assertEqual(mock_exec.call_args.kwargs["app_name"], TELEGRAM_BOT_APP_NAME)

    async def test_execute_telegram_normalizes_bot_app_name(self):
        mock_client = MagicMock()
        mock_sent = MagicMock(id=42, date=None)
        mock_client.send_message = AsyncMock(return_value=mock_sent)

        with patch("app.services.telegram_client_engine._get_or_start_live_client", AsyncMock(return_value=mock_client)) as mock_get:
            res = await execute_telegram_client_action(
                user_id="u1",
                action="SEND_MESSAGE",
                parameters={"target": "98765", "text": "Bot response"},
                app_name="telegram bot",
            )
        self.assertEqual(res["status"], "success")
        mock_get.assert_awaited_once_with("u1", TELEGRAM_BOT_APP_NAME)


if __name__ == "__main__":
    unittest.main()
