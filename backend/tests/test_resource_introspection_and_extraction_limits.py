"""Unit tests for Connected Resource Introspection Closest-Match & Multi-App Intelligent Extraction Limits."""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.resource_matcher import (
    calculate_resource_similarity,
    find_closest_resource_match,
    find_closest_resource_item,
)
from app.services.composio_engine import (
    _apply_intelligent_data_extraction_limits,
    _extract_named_id,
    enrich_blueprint_with_connected_resources,
)
from app.services.disambiguation import (
    _rule_based_option_match,
    resolve_disambiguation,
)


class TestResourceMatcher(unittest.TestCase):
    def setUp(self):
        self.sheets = [
            "Quarterly Financials 2024",
            "Customer Feedback Leads",
            "Inventory Master Sheet",
            "Company Invoices & Billing",
        ]
        self.channels = [
            "general-announcements",
            "sales-leads",
            "engineering-alerts",
        ]

    def test_exact_match(self):
        match, score = find_closest_resource_match("Customer Feedback Leads", self.sheets)
        self.assertEqual(match, "Customer Feedback Leads")
        self.assertAlmostEqual(score, 1.0, places=2)

    def test_case_and_whitespace_insensitivity(self):
        match, score = find_closest_resource_match("  customer  feedback  leads  ", self.sheets)
        self.assertEqual(match, "Customer Feedback Leads")
        self.assertGreaterEqual(score, 0.95)

    def test_typo_tolerance(self):
        # Transposition and missing letters
        match, score = find_closest_resource_match("Quartrly Financials", self.sheets)
        self.assertEqual(match, "Quarterly Financials 2024")
        self.assertGreaterEqual(score, 0.70)

        match2, score2 = find_closest_resource_match("Invetory Master", self.sheets)
        self.assertEqual(match2, "Inventory Master Sheet")
        self.assertGreaterEqual(score2, 0.70)

    def test_partial_and_filler_phrasing(self):
        # User says "my sheet named Customer Leads"
        match, score = find_closest_resource_match("my sheet named Customer Leads", self.sheets)
        self.assertEqual(match, "Customer Feedback Leads")
        self.assertGreaterEqual(score, 0.60)

        # Slack channel with prefix
        match2, score2 = find_closest_resource_match("the sales leads channel", self.channels)
        self.assertEqual(match2, "sales-leads")
        self.assertGreaterEqual(score2, 0.65)

    def test_irrelevant_detail_rejection(self):
        # Completely irrelevant details must NOT match and return None
        match, score = find_closest_resource_match("Groceries List", self.sheets, threshold=0.55)
        self.assertIsNone(match)
        self.assertLess(score, 0.55)

        match2, score2 = find_closest_resource_match("Potato", self.sheets, threshold=0.55)
        self.assertIsNone(match2)
        self.assertLess(score2, 0.55)

        match3, score3 = find_closest_resource_match("crypto-trading", self.channels, threshold=0.55)
        self.assertIsNone(match3)
        self.assertLess(score3, 0.55)

    def test_find_closest_resource_item(self):
        items = [
            {"name": "Monthly Budget 2024", "id": "sheet_1"},
            {"title": "Product Roadmap", "id": "sheet_2"},
            {"summary": "Hiring Pipeline", "id": "sheet_3"},
        ]
        # Match title
        item, score = find_closest_resource_item("Monthly Budget", items)
        self.assertIsNotNone(item)
        self.assertEqual(item["id"], "sheet_1")

        # Typos in search
        item2, score2 = find_closest_resource_item("Product Rodmap", items)
        self.assertIsNotNone(item2)
        self.assertEqual(item2["id"], "sheet_2")

        # Irrelevant item
        item3, score3 = find_closest_resource_item("Gaming Discord", items)
        self.assertIsNone(item3)


class TestIntelligentDataExtractionLimits(unittest.TestCase):
    def test_user_specified_amount_honored(self):
        # Slack with explicit limit: 3
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"limit": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Slack", "SLACK_LIST_MESSAGES", {"limit": 3})
            self.assertEqual(params["limit"], 3)

        # Jira with result_limit hint: 4
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"maxResults": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Jira", "JIRA_SEARCH_ISSUES", {}, result_limit=4)
            self.assertEqual(params["maxResults"], 4)

    def test_unspecified_amount_applies_safe_defaults(self):
        # Slack default (not 100)
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"limit": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Slack", "SLACK_LIST_MESSAGES", {})
            self.assertEqual(params["limit"], 5)

        # Google Calendar default
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"maxResults": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Google Calendar", "GOOGLECALENDAR_LIST_EVENTS", {})
            self.assertEqual(params["maxResults"], 5)

        # GitHub issues default
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"per_page": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("GitHub", "GITHUB_LIST_ISSUES", {})
            self.assertEqual(params["per_page"], 5)

        # Notion database query default
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"page_size": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Notion", "NOTION_QUERY_DATABASE", {})
            self.assertEqual(params["page_size"], 10)

    def test_latest_single_detection(self):
        # "latest message" -> limit 1
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"limit": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Slack", "SLACK_LIST_MESSAGES", {"query": "latest message in channel"})
            self.assertEqual(params["limit"], 1)

    def test_google_sheets_bounded_range(self):
        # Empty range bounded to A1:Z30
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"range": {"type": "string"}}}):
            params = _apply_intelligent_data_extraction_limits("Google Sheets", "GOOGLESHEETS_GET_SPREADSHEET_VALUES", {})
            self.assertEqual(params["range"], "A1:Z30")

        # Unbounded A:Z bounded to A1:Z30
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"range": {"type": "string"}}}):
            params = _apply_intelligent_data_extraction_limits("Google Sheets", "GOOGLESHEETS_GET_SPREADSHEET_VALUES", {"range": "A:Z"})
            self.assertEqual(params["range"], "A1:Z30")

        # Specific tab name without cells bounded to Sheet1!A1:Z30
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"range": {"type": "string"}}}):
            params = _apply_intelligent_data_extraction_limits("Google Sheets", "GOOGLESHEETS_GET_SPREADSHEET_VALUES", {"range": "Sheet1"})
            self.assertEqual(params["range"], "Sheet1!A1:Z30")

    def test_clamping_excessive_limits(self):
        # Clamps 5000 down to safe envelope of 50
        with patch("app.services.composio_engine._get_action_schema", return_value={"properties": {"limit": {"type": "integer"}}}):
            params = _apply_intelligent_data_extraction_limits("Slack", "SLACK_LIST_MESSAGES", {"limit": 5000})
            self.assertEqual(params["limit"], 50)


class TestConnectedResourceEnrichmentAndDisambiguation(unittest.TestCase):
    def test_enrichment_assumes_closest_sheet_and_resolves_step(self):
        blueprint = {
            "title": "Analyze Expenses",
            "trigger": {"type": "manual"},
            "steps": [
                {
                    "step_number": 1,
                    "app": "Google Sheets",
                    "action": "GOOGLESHEETS_GET_SPREADSHEET_VALUES",
                    "parameters": {"spreadsheet_name": "Monthly Expensess"},
                }
            ],
            "missing_parameters": [
                {
                    "step_number": 1,
                    "parameter_key": "spreadsheet_name",
                    "label": "Spreadsheet Name",
                }
            ],
        }

        async def fake_introspect(user_id, app, parameter_key=""):
            return ["Monthly Expenses 2024", "Sales Q3", "Inventory Master"]

        with patch("app.services.composio_engine.introspect_app_resources", side_effect=fake_introspect):
            enriched = asyncio.run(enrich_blueprint_with_connected_resources(blueprint, user_id="user_123"))

            # Step parameter updated to closest match
            step_params = enriched["steps"][0]["parameters"]
            self.assertEqual(step_params["spreadsheet_name"], "Monthly Expenses 2024")

            # Missing parameter resolved and removed
            self.assertEqual(len(enriched["missing_parameters"]), 0)

    def test_enrichment_rejects_irrelevant_sheet_and_leaves_options(self):
        blueprint = {
            "title": "Random Automation",
            "trigger": {"type": "manual"},
            "steps": [
                {
                    "step_number": 1,
                    "app": "Google Sheets",
                    "action": "GOOGLESHEETS_GET_SPREADSHEET_VALUES",
                    "parameters": {"spreadsheet_name": "Potato Garden"},
                }
            ],
            "missing_parameters": [
                {
                    "step_number": 1,
                    "parameter_key": "spreadsheet_name",
                    "label": "Spreadsheet Name",
                }
            ],
        }

        async def fake_introspect(user_id, app, parameter_key=""):
            return ["Monthly Expenses 2024", "Sales Q3", "Inventory Master"]

        with patch("app.services.composio_engine.introspect_app_resources", side_effect=fake_introspect):
            enriched = asyncio.run(enrich_blueprint_with_connected_resources(blueprint, user_id="user_123"))

            # Step parameter NOT corrupted with random sheet
            step_params = enriched["steps"][0]["parameters"]
            self.assertEqual(step_params["spreadsheet_name"], "Potato Garden")

            # Missing parameter left in place with real options so user can choose
            self.assertEqual(len(enriched["missing_parameters"]), 1)
            self.assertEqual(enriched["missing_parameters"][0]["options"], ["Monthly Expenses 2024", "Sales Q3", "Inventory Master"])

    def test_disambiguation_rule_based_closest_match(self):
        options = ["Quarterly Financials 2024", "Customer Feedback Leads", "Inventory Master Sheet"]
        
        # Typos match closest option
        self.assertEqual(_rule_based_option_match("Quartrly Financials", options), "Quarterly Financials 2024")
        self.assertEqual(_rule_based_option_match("Customer Leads", options), "Customer Feedback Leads")

        # Irrelevant input returns None
        self.assertIsNone(_rule_based_option_match("Potato Salad", options))


if __name__ == "__main__":
    unittest.main()

