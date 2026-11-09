import unittest
from app.services.planner import (
    _extract_json_candidate,
    _local_heuristic_repair,
    _parse_and_repair_json,
)
from app.schemas.blueprint import WorkflowBlueprint

class TestPlannerJSONRepair(unittest.TestCase):
    def test_extract_json_from_markdown(self):
        markdown_text = """
        Here is your automation blueprint:
        ```json
        {
            "title": "Send Daily Report",
            "trigger": {"type": "manual", "details": "Manual trigger"},
            "steps": [],
            "needs_clarification": false
        }
        ```
        Let me know if you want adjustments.
        """
        extracted = _extract_json_candidate(markdown_text)
        self.assertTrue(extracted.startswith("{"))
        self.assertTrue(extracted.endswith("}"))

    def test_local_heuristic_single_quotes_and_python_literals(self):
        dirty = """{
            'title': 'Test Single Quotes',
            'trigger': {'type': 'manual', 'details': 'Test'},
            'steps': [],
            'needs_clarification': False,
        }"""
        parsed = _local_heuristic_repair(_extract_json_candidate(dirty))
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["title"], "Test Single Quotes")
        self.assertEqual(parsed["needs_clarification"], False)

    def test_local_heuristic_unquoted_keys_and_trailing_commas(self):
        dirty = """{
            title: "Test Unquoted",
            trigger: {type: "manual", details: "Test"},
            steps: [],
            needs_clarification: false,
        }"""
        parsed = _local_heuristic_repair(_extract_json_candidate(dirty))
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["title"], "Test Unquoted")

    def test_parse_and_repair_user_exact_malformed_string(self):
        raw_user_error = """{
'title Summarize Google Sheets articles and send to
Telegram
trigger": { type
'manual details":
Triggered manually by the user to summarize and send
sheet data., }, required_apps [ "Google Sheets
Telegram ], steps [{ step_number 1, route
composio_api"
"app Google Sheets action
GOOGLESHEETS_GET_SPREADSHEET_VALUES"
parameters { spreadsheet_name
'articles } }, {
step_number 2, route ai_generate" app
VoxAgent Al
"action GENERATE_TEXT" parameters
{ "prompt Summarize the following data from the
articles sheet: {step_1_result} } }, { step_number 3,
route telegram_client
"app
{telegram_account_type} action SEND_MESSAGE
parameters { target": "me
message
{step_2_result} } } ], 'needs_human_approval false,
'needs_clarification true, 'clarification_question
'Please specify whether you would like to use your
personal Telegram account or a Telegram Bot to send the
summary.
"missing_parameters": [ { step_number 3,
parameter_key telegram_account_type"
'label
Telegram Account Type description Should this run
on your personal Telegram account, or your connected
Telegram Bot?11 Ilsuggested_type":
'select
'options [
Telegram Bot Telegram Personal Account ] } ],
require_approval true }"""
        parsed = _parse_and_repair_json(raw_user_error)
        self.assertIsInstance(parsed, dict)
        self.assertIn("title", parsed)
        self.assertTrue(len(parsed.get("steps", [])) >= 1)

    def test_generate_blueprint_with_current_blueprint(self):
        import json
        from unittest.mock import patch, MagicMock
        from app.services.planner import generate_blueprint

        mock_response = MagicMock()
        mock_response.text = json.dumps({
            "title": "Updated Workflow to Gmail",
            "trigger": {"type": "manual", "details": "Manual"},
            "steps": [
                {
                    "step_number": 1,
                    "route": "composio_api",
                    "app": "Gmail",
                    "action": "GMAIL_SEND_EMAIL",
                    "parameters": {"recipient_email": "test@example.com", "body": "Summary"}
                }
            ],
            "required_apps": ["Gmail"],
            "needs_clarification": False,
            "needs_human_approval": False
        })

        existing_bp = {
            "title": "Old Workflow to Telegram",
            "trigger": {"type": "manual", "details": "Manual"},
            "steps": [
                {
                    "step_number": 1,
                    "route": "telegram_client",
                    "app": "Telegram Personal Account",
                    "action": "SEND_MESSAGE",
                    "parameters": {"target": "me", "message": "Summary"}
                }
            ],
            "required_apps": ["Telegram Personal Account"],
            "needs_clarification": False,
            "needs_human_approval": False
        }

        with patch("app.services.planner._generate_content_with_fallback", return_value=mock_response) as mock_gen:
            res = generate_blueprint("Actually, send via Gmail instead of Telegram", current_blueprint=existing_bp)
            self.assertEqual(res.title, "Updated Workflow to Gmail")
            self.assertEqual(len(res.steps), 1)
            self.assertEqual(res.steps[0].app, "Gmail")
            call_contents = mock_gen.call_args[1]["contents"]
            prompt_text = call_contents[0].parts[0].text
            self.assertIn("EXISTING WORKFLOW BLUEPRINT TO AMEND", prompt_text)
            self.assertIn("Old Workflow to Telegram", prompt_text)
            self.assertIn("Actually, send via Gmail instead of Telegram", prompt_text)

    def test_plan_api_endpoint_with_current_blueprint(self):
        import json
        from fastapi.testclient import TestClient
        from main import app
        from unittest.mock import patch, MagicMock

        client = TestClient(app)
        mock_response = MagicMock()
        mock_response.text = json.dumps({
            "title": "Refined Workflow",
            "trigger": {"type": "manual", "details": "Manual"},
            "steps": [
                {
                    "step_number": 1,
                    "route": "composio_api",
                    "app": "Gmail",
                    "action": "GMAIL_SEND_EMAIL",
                    "parameters": {"recipient_email": "test@example.com"}
                }
            ],
            "required_apps": ["Gmail"],
            "needs_clarification": False,
            "needs_human_approval": False
        })

        with patch("app.services.planner._generate_content_with_fallback", return_value=mock_response):
            resp = client.post("/api/v1/plan", json={
                "prompt": "Send to Gmail instead",
                "current_blueprint": {
                    "title": "Old Workflow",
                    "trigger": {"type": "manual", "details": "Manual"},
                    "steps": [],
                    "required_apps": []
                }
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["title"], "Refined Workflow")
            self.assertEqual(data["steps"][0]["app"], "Gmail")

    def test_reconcile_missing_parameters_preserves_surviving_and_drops_removed(self):
        from app.services.planner import _reconcile_missing_parameters

        bp1 = {
            "title": "Summarize Google Sheets to Telegram",
            "steps": [
                {"step_number": 1, "route": "composio_api", "app": "Google Sheets", "action": "GOOGLESHEETS_GET_SPREADSHEET_VALUES", "parameters": {}},
                {"step_number": 2, "route": "ai_generate", "app": "VoxAgent AI", "action": "GENERATE_TEXT", "parameters": {}},
                {"step_number": 3, "route": "telegram_client", "app": "Telegram Personal Account", "action": "SEND_MESSAGE", "parameters": {}}
            ],
            "missing_parameters": [
                {"step_number": 1, "parameter_key": "spreadsheet_name", "label": "Google Sheet Name", "description": "Which sheet?", "suggested_type": "text"},
                {"step_number": 3, "parameter_key": "telegram_account_type", "label": "Telegram Account Type", "description": "Identity", "suggested_type": "select"}
            ]
        }

        # Simulated amended plan where LLM forgot spreadsheet_name
        amended_plan = {
            "title": "Summarize Google Sheets to Gmail",
            "steps": [
                {"step_number": 1, "route": "composio_api", "app": "Google Sheets", "action": "GOOGLESHEETS_GET_SPREADSHEET_VALUES", "parameters": {}},
                {"step_number": 2, "route": "ai_generate", "app": "VoxAgent AI", "action": "GENERATE_TEXT", "parameters": {}},
                {"step_number": 3, "route": "composio_api", "app": "Gmail", "action": "GMAIL_SEND_EMAIL", "parameters": {}}
            ],
            "missing_parameters": [
                {"step_number": 3, "parameter_key": "recipient_email", "label": "Recipient Email", "description": "Email address", "suggested_type": "text"}
            ]
        }

        _reconcile_missing_parameters(amended_plan, bp1, "actually send it to my gmail instead")
        self.assertEqual(len(amended_plan["missing_parameters"]), 2)
        # Step 1 spreadsheet_name must be first
        self.assertEqual(amended_plan["missing_parameters"][0]["parameter_key"], "spreadsheet_name")
        self.assertEqual(amended_plan["missing_parameters"][0]["step_number"], 1)
        # Step 3 recipient_email must be second
        self.assertEqual(amended_plan["missing_parameters"][1]["parameter_key"], "recipient_email")
        self.assertEqual(amended_plan["missing_parameters"][1]["step_number"], 3)
        # telegram_account_type must be purged
        self.assertNotIn("telegram_account_type", [p["parameter_key"] for p in amended_plan["missing_parameters"]])
        # Clarification question mentions both
        self.assertIn("Google Sheet Name", amended_plan["clarification_question"])
        self.assertIn("Recipient Email", amended_plan["clarification_question"])
        self.assertTrue(amended_plan["needs_clarification"])

if __name__ == "__main__":
    unittest.main()

