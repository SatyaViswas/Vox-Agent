import asyncio
import unittest
from unittest.mock import patch
from app.services import composio_engine
from app.services.planner import _apply_route_fallback_and_required_apps


class TestGoogleSheetsLifecycle(unittest.TestCase):
    def test_planner_synthesis_create_spreadsheet(self):
        """When user prompt expresses intent to create a spreadsheet, but LLM only output append,
        _apply_route_fallback_and_required_apps automatically synthesizes GOOGLESHEETS_CREATE_GOOGLE_SHEET1."""
        raw_plan = {
            "title": "Amazon Laptops Workflow",
            "steps": [
                {
                    "step_number": 1,
                    "route": "browser_agent",
                    "app": "Amazon",
                    "action": "BROWSER_SEARCH_AND_EXTRACT",
                    "parameters": {"search_query": "top 10 laptops"},
                },
                {
                    "step_number": 2,
                    "route": "ai_generate",
                    "app": "VoxAgent AI",
                    "action": "GENERATE_TEXT",
                    "parameters": {"prompt": "Summarize: {step_1_result}"},
                },
                {
                    "step_number": 3,
                    "route": "composio_api",
                    "app": "Google Sheets",
                    "action": "GOOGLESHEETS_APPEND_ROW",
                    "parameters": {"values": ["{step_2_result}"]},
                },
            ],
            "missing_parameters": [
                {
                    "step_number": 3,
                    "parameter_key": "spreadsheet_name",
                    "label": "Google Spreadsheet Name",
                    "description": "Which Google Spreadsheet would you like to save into?",
                    "suggested_type": "text",
                }
            ],
        }

        prompt = "Summarise top 10 laptops from amazon and create a spreadsheet with it"
        _apply_route_fallback_and_required_apps(raw_plan, prompt=prompt)

        # Should now have 4 steps
        self.assertEqual(len(raw_plan["steps"]), 4)
        step3 = raw_plan["steps"][2]
        step4 = raw_plan["steps"][3]

        self.assertEqual(step3["step_number"], 3)
        self.assertEqual(step3["action"], "GOOGLESHEETS_CREATE_GOOGLE_SHEET1")
        self.assertEqual(step4["step_number"], 4)
        self.assertEqual(step4["action"], "GOOGLESHEETS_APPEND_ROW")
        self.assertEqual(step4["parameters"]["spreadsheet_name"], "{{step_3_result}}")

        # Missing parameter should ask for Step 3 name
        missing = raw_plan["missing_parameters"]
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["step_number"], 3)
        self.assertEqual(missing[0]["parameter_key"], "spreadsheet_name")
        self.assertIn("name your new", missing[0]["description"])

    def test_exact_match_priority_over_substring(self):
        """Searching for 'Trending Laptops' when Drive has both 'Laptops' and 'Trending Laptops'
        must return 'Trending Laptops' and NEVER mistakenly match 'Laptops'."""
        search_result = {
            "data": {
                "files": [
                    {"name": "Laptops", "id": "laptops_old_id_111"},
                    {"name": "Trending Laptops", "id": "trending_laptops_target_id_222"},
                ]
            }
        }
        resolved = composio_engine._extract_named_id(search_result, "Trending Laptops")
        self.assertEqual(resolved, "trending_laptops_target_id_222")

    def test_step_result_mapped_to_spreadsheet_id(self):
        """When an append step receives the Step 3 output dict in spreadsheet_name,
        _normalize_parameters_via_schema and _auto_resolve_missing_ids must extract spreadsheetId."""
        step3_output = {
            "data": {
                "sheets": [{"properties": {"title": "Sheet1"}}],
                "properties": {"title": "Trending Laptops"},
                "spreadsheetId": "1CPpJyrlfk4cp-B_qFCc2WlRxH2Sq11vcEu2GNBgllf8",
            },
            "successful": True,
        }
        params = {
            "spreadsheet_name": step3_output,
            "values": [["HP Laptop", "$999"]],
        }
        normalized = composio_engine._normalize_parameters_via_schema("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", params)
        self.assertEqual(normalized.get("spreadsheetId"), "1CPpJyrlfk4cp-B_qFCc2WlRxH2Sq11vcEu2GNBgllf8")

    def test_self_healing_append_creates_missing_sheet(self):
        """When appending to a sheet that does not exist in Google Drive,
        the engine self-heals by auto-creating it and completing the append."""
        async def run_test():
            calls = []
            async def mock_exec(slug, arguments, **kwargs):
                calls.append((slug, arguments))
                if "SEARCH" in slug:
                    return {"data": {"files": []}}  # Not found
                if "CREATE" in slug:
                    return {"data": {"spreadsheetId": "healed_sheet_id_456", "title": arguments.get("title")}}
                if "APPEND" in slug or "VALUES" in slug:
                    return {"successful": True, "data": {"updates": {"updatedRows": 1}}}
                return {}

            with patch("app.services.composio_engine._execute_composio_with_timeout", side_effect=mock_exec):
                params = {"spreadsheet_name": "New Deals Sheet", "values": [["Dell XPS 15", "$1800"]]}
                res = await composio_engine.execute_composio_action(
                    app="Google Sheets",
                    action="GOOGLESHEETS_APPEND_ROW",
                    parameters=params,
                    entity_id="default",
                )
                self.assertEqual(res.get("status"), "success")
                slugs = [c[0] for c in calls]
                self.assertTrue(any("CREATE" in s for s in slugs))
                self.assertTrue(any("APPEND" in s or "VALUES" in s for s in slugs))

        asyncio.run(run_test())

    def test_duplicate_sheet_disambiguation_flow(self):
        """When creating a spreadsheet whose title already exists:
        1. First call pauses with 'needs_input' and options.
        2. Resuming with 'Add to Existing Spreadsheet' uses existing sheet ID.
        3. Resuming with 'Create New Spreadsheet' creates a new sheet with almost same name."""
        async def run_test():
            created_titles = []
            async def mock_exec(slug, arguments, **kwargs):
                if "SEARCH" in slug:
                    return {"data": {"files": [{"name": "Market Trends", "id": "existing_trends_id_789"}]}}
                if "CREATE" in slug:
                    created_titles.append(arguments.get("title"))
                    return {"data": {"spreadsheetId": "new_created_trends_id_101", "title": arguments.get("title")}}
                return {}

            with patch("app.services.composio_engine._execute_composio_with_timeout", side_effect=mock_exec):
                # Phase 1: Conflict detection
                res_pause = await composio_engine.execute_composio_action(
                    app="Google Sheets",
                    action="GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    parameters={"title": "Market Trends"},
                    entity_id="default",
                )
                self.assertEqual(res_pause.get("status"), "needs_input")
                self.assertIn("already exists", res_pause.get("question", ""))
                self.assertEqual(
                    res_pause.get("options"),
                    ["Create New Spreadsheet", "Add to Existing Spreadsheet"]
                )
                self.assertEqual(res_pause.get("_existing_sheet_id"), "existing_trends_id_789")

                # Phase 2: User chooses to add to existing
                res_existing = await composio_engine.execute_composio_action(
                    app="Google Sheets",
                    action="GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    parameters={
                        "title": "Market Trends",
                        "_duplicate_sheet_action": "Add to Existing Spreadsheet",
                        "_existing_sheet_id": "existing_trends_id_789",
                    },
                    entity_id="default",
                )
                self.assertEqual(res_existing.get("status"), "success")
                self.assertEqual(res_existing["output"]["spreadsheetId"], "existing_trends_id_789")
                self.assertTrue(res_existing["output"]["reused_existing"])

                # Phase 3: User chooses to create new spreadsheet -> title becomes 'Market Trends (New)'
                res_new = await composio_engine.execute_composio_action(
                    app="Google Sheets",
                    action="GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    parameters={
                        "title": "Market Trends",
                        "_duplicate_sheet_action": "Create New Spreadsheet",
                    },
                    entity_id="default",
                )
                self.assertEqual(res_new.get("status"), "success")
                self.assertEqual(res_new["output"]["spreadsheetId"], "new_created_trends_id_101")
                self.assertEqual(created_titles[-1], "Market Trends (New)")

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
