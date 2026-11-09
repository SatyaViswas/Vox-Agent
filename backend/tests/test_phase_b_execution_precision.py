import unittest
import asyncio
from unittest.mock import patch, MagicMock

from app.services.orchestrator import (
    _clean_operand,
    _compare_values,
    _evaluate_condition_expression,
    _referenced_step_numbers,
    _is_empty_or_no_action,
    _evaluate_step_condition,
    _execute_steps,
)
from app.services.composio_engine import (
    introspect_app_resources,
    enrich_blueprint_with_connected_resources,
)


class TestPhaseBConditionEvaluation(unittest.TestCase):
    def test_clean_operand(self):
        self.assertEqual(_clean_operand("'YES'"), "YES")
        self.assertEqual(_clean_operand('"hello"'), "hello")
        self.assertEqual(_clean_operand("true"), True)
        self.assertEqual(_clean_operand("FALSE"), False)
        self.assertEqual(_clean_operand("null"), None)
        self.assertEqual(_clean_operand("None"), None)
        self.assertEqual(_clean_operand("42"), 42)
        self.assertEqual(_clean_operand("3.14"), 3.14)
        self.assertEqual(_clean_operand("plain text"), "plain text")

    def test_compare_values(self):
        # Equality
        self.assertTrue(_compare_values("YES", "yes", "=="))
        self.assertTrue(_compare_values("true", True, "=="))
        self.assertTrue(_compare_values(100, "100", "=="))
        self.assertFalse(_compare_values("YES", "NO", "=="))

        # Inequality
        self.assertTrue(_compare_values("YES", "NO", "!="))
        self.assertFalse(_compare_values("NO_ACTION", "no_action", "!="))

        # Numeric
        self.assertTrue(_compare_values("50", 10, ">"))
        self.assertTrue(_compare_values("5", "10", "<"))
        self.assertTrue(_compare_values(20, "20", ">="))
        self.assertTrue(_compare_values("15", 15, "<="))

        # Contains & In
        self.assertTrue(_compare_values("Refund request for order 99", "refund", " contains "))
        self.assertTrue(_compare_values(["alpha", "beta"], "alpha", " contains "))
        self.assertTrue(_compare_values("urgent", "This is an urgent matter", " in "))

    def test_evaluate_condition_expression(self):
        step_results = {
            1: "YES",
            2: "NO_ACTION",
            3: 45,
            4: {"status": "approved", "count": 12},
        }

        # Step 1 is YES
        self.assertTrue(_evaluate_condition_expression("{{step_1_result}} == 'YES'", step_results))
        self.assertFalse(_evaluate_condition_expression("{{step_1_result}} == 'NO'", step_results))

        # Step 2 is NO_ACTION
        self.assertFalse(_evaluate_condition_expression("{{step_2_result}} != 'NO_ACTION'", step_results))

        # Step 3 numeric
        self.assertTrue(_evaluate_condition_expression("{{step_3_result}} > 40", step_results))
        self.assertFalse(_evaluate_condition_expression("{{step_3_result}} < 20", step_results))

        # Step 4 property access
        self.assertTrue(_evaluate_condition_expression("{{step_4_result.status}} == 'approved'", step_results))
        self.assertTrue(_evaluate_condition_expression("{{step_4_result.count}} > 10", step_results))

    def test_upstream_skip_cascade(self):
        step_results = {1: None, 2: "Some Data"}
        skipped_step_numbers = {1}

        # Step 3 references step 1 in its parameters
        raw_parameters = {"text": "Process this: {{step_1_result}}"}
        should_skip, reason = _evaluate_step_condition(
            condition=None,
            skip_if_empty=False,
            raw_parameters=raw_parameters,
            for_each_spec=None,
            step_results=step_results,
            skipped_step_numbers=skipped_step_numbers,
        )
        self.assertTrue(should_skip)
        self.assertIn("Upstream Step 1 was skipped", reason)

        # Step 4 references step 2 in parameters, which was NOT skipped
        raw_parameters_2 = {"text": "Process this: {{step_2_result}}"}
        should_skip, reason = _evaluate_step_condition(
            condition=None,
            skip_if_empty=False,
            raw_parameters=raw_parameters_2,
            for_each_spec=None,
            step_results=step_results,
            skipped_step_numbers=skipped_step_numbers,
        )
        self.assertFalse(should_skip)

    def test_skip_if_empty(self):
        # Case A: for_each source is empty
        step_results = {1: []}
        should_skip, reason = _evaluate_step_condition(
            condition=None,
            skip_if_empty=True,
            raw_parameters={},
            for_each_spec="{{step_1_result}}",
            step_results=step_results,
            skipped_step_numbers=set(),
        )
        self.assertTrue(should_skip)
        self.assertIn("For-each source items list is empty", reason)

        # Case B: referenced data is NO_ACTION
        step_results = {1: "NO_ACTION"}
        should_skip, reason = _evaluate_step_condition(
            condition=None,
            skip_if_empty=True,
            raw_parameters={"message": "{{step_1_result}}"},
            for_each_spec=None,
            step_results=step_results,
            skipped_step_numbers=set(),
        )
        self.assertTrue(should_skip)
        self.assertIn("empty or NO_ACTION", reason)


class TestPhaseBOrchestratorExecution(unittest.TestCase):
    def test_workflow_steps_skip_cleanly(self):
        steps = [
            {
                "step_number": 1,
                "route": "ai_generate",
                "app": "VoxAgent AI",
                "action": "CLASSIFY",
                "parameters": {"prompt": "Is this a refund? Output NO."},
            },
            {
                "step_number": 2,
                "route": "telegram_client",
                "app": "Telegram Bot",
                "action": "SEND_MESSAGE",
                "condition": "{{step_1_result}} == 'YES'",
                "parameters": {"message": "Alert: Refund requested!"},
            },
            {
                "step_number": 3,
                "route": "http_webhook",
                "app": "Custom Webhook",
                "action": "POST",
                "parameters": {"result": "{{step_2_result}}"},
            },
        ]

        step_results = {1: "NO"}  # Step 1 classified as NO
        step_logs = []

        # Mock telemetry to avoid network calls
        with patch("app.services.telemetry.telemetry_manager.send_log", new_callable=unittest.mock.AsyncMock):
            # Running steps starting at index 1 (Step 2)
            outcome = asyncio.run(_execute_steps(
                agent_id="test_agent",
                user_id="test_user",
                blueprint={"title": "Conditional Workflow", "steps": steps},
                steps=steps,
                step_results=step_results,
                step_logs=step_logs,
                start_index=1,
            ))

            self.assertEqual(outcome, "success")
            # Step 2 was skipped because condition was not met
            self.assertEqual(step_results.get(2), None)
            # Step 3 was skipped because upstream Step 2 was skipped
            self.assertEqual(step_results.get(3), None)

            # Check logs
            self.assertEqual(len(step_logs), 2)
            self.assertEqual(step_logs[0]["result"]["status"], "skipped")
            self.assertIn("Condition", step_logs[0]["result"]["reason"])
            self.assertEqual(step_logs[1]["result"]["status"], "skipped")
            self.assertIn("Upstream Step 2", step_logs[1]["result"]["reason"])


class TestPhaseBResourceIntrospection(unittest.TestCase):
    def test_enrich_blueprint_with_connected_resources(self):
        blueprint = {
            "title": "Sync Leads to Telegram",
            "trigger": {"type": "manual", "details": "Manual"},
            "required_apps": ["Google Sheets", "Telegram Bot"],
            "steps": [
                {
                    "step_number": 1,
                    "route": "composio_api",
                    "app": "Google Sheets",
                    "action": "GOOGLESHEETS_GET_SPREADSHEET_VALUES",
                    "parameters": {},
                },
                {
                    "step_number": 2,
                    "route": "telegram_client",
                    "app": "Telegram Bot",
                    "action": "SEND_MESSAGE",
                    "parameters": {"message": "{{step_1_result}}"},
                },
            ],
            "missing_parameters": [
                {
                    "step_number": 1,
                    "parameter_key": "spreadsheet_name",
                    "label": "Spreadsheet Name",
                    "description": "Which spreadsheet?",
                    "suggested_type": "text",
                    "options": None,
                },
                {
                    "step_number": 2,
                    "parameter_key": "telegram_account_type",
                    "label": "Telegram Account Type",
                    "description": "Select bot or personal account",
                    "suggested_type": "text",
                    "options": None,
                },
            ],
        }

        async def fake_introspect(user_id, app, parameter_key=""):
            if "sheet" in app.lower():
                return ["Sales Q4", "Marketing Leads", "Inventory 2026"]
            if "telegram" in app.lower():
                return ["Telegram Bot", "Telegram Personal Account"]
            return []

        with patch("app.services.composio_engine.introspect_app_resources", side_effect=fake_introspect):
            enriched = asyncio.run(enrich_blueprint_with_connected_resources(blueprint, user_id="user_123"))

            params = enriched["missing_parameters"]
            self.assertEqual(len(params), 2)

            # Step 1 spreadsheet_name enriched with sheets
            p1 = next(p for p in params if p["parameter_key"] == "spreadsheet_name")
            self.assertEqual(p1["suggested_type"], "select")
            self.assertEqual(p1["options"], ["Sales Q4", "Marketing Leads", "Inventory 2026"])

            # Step 2 telegram_account_type enriched
            p2 = next(p for p in params if p["parameter_key"] == "telegram_account_type")
            self.assertEqual(p2["suggested_type"], "select")
            self.assertEqual(p2["options"], ["Telegram Bot", "Telegram Personal Account"])

    def test_gmail_recipient_and_freeform_params_never_get_options_or_select(self):
        """Verifies that freeform fields like recipient email, message body, and subject
        are NEVER introspected or turned into select dropdowns (e.g. CHAT, SENT)."""
        from app.services.composio_engine import is_introspectable_resource_param, enrich_blueprint_with_connected_resources

        # Direct function checks
        self.assertFalse(is_introspectable_resource_param("recipient", "Gmail"))
        self.assertFalse(is_introspectable_resource_param("recipient_email", "Gmail"))
        self.assertFalse(is_introspectable_resource_param("to", "Gmail"))
        self.assertFalse(is_introspectable_resource_param("subject", "Gmail"))
        self.assertFalse(is_introspectable_resource_param("body", "Gmail"))
        self.assertFalse(is_introspectable_resource_param("message", "Slack"))
        self.assertFalse(is_introspectable_resource_param("phone_number", "WhatsApp"))
        self.assertTrue(is_introspectable_resource_param("spreadsheet_name", "Google Sheets"))
        self.assertTrue(is_introspectable_resource_param("channel", "Slack"))

        blueprint = {
            "title": "Email and Sheet Workflow",
            "trigger": {"type": "manual", "details": "Manual"},
            "required_apps": ["Gmail"],
            "steps": [
                {
                    "step_number": 1,
                    "route": "composio_api",
                    "app": "Gmail",
                    "action": "GMAIL_SEND_EMAIL",
                    "parameters": {},
                },
            ],
            "missing_parameters": [
                {
                    "step_number": 1,
                    "parameter_key": "recipient",
                    "label": "Recipient Email",
                    "description": "Who should receive the email?",
                    "suggested_type": "text",
                    "options": None,
                },
                {
                    "step_number": 1,
                    "parameter_key": "subject",
                    "label": "Email Subject",
                    "description": "Subject of the email",
                    "suggested_type": "text",
                    "options": None,
                },
            ],
        }

        async def fake_introspect(user_id, app, parameter_key=""):
            # Simulate Composio returning labels like CHAT, SENT if called erroneously
            return ["CHAT", "SENT", "INBOX", "DRAFT", "TRASH"]

        with patch("app.services.composio_engine.introspect_app_resources", side_effect=fake_introspect):
            enriched = asyncio.run(enrich_blueprint_with_connected_resources(blueprint, user_id="user_123"))

            params = enriched["missing_parameters"]
            p_recip = next(p for p in params if p["parameter_key"] == "recipient")
            p_subj = next(p for p in params if p["parameter_key"] == "subject")

            # Must NOT be 'select' and must NOT have options
            self.assertNotEqual(p_recip["suggested_type"], "select")
            self.assertIsNone(p_recip.get("options"))
            self.assertNotEqual(p_subj["suggested_type"], "select")
            self.assertIsNone(p_subj.get("options"))


if __name__ == "__main__":
    unittest.main()
