"""Unit tests for Structured Business Knowledge Pillars, Autonomous Grounding, and Test Query Playground."""

import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from app.schemas.knowledge import KnowledgeTestQueryRequest, KnowledgeTestQueryResponse, PillarUpdateRequest
from app.services.context_injector import (
    retrieve_business_context,
    retrieve_business_context_detailed,
)
from main import app


class TestBusinessKnowledgeAndGrounding(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.user_id = "00000000-0000-0000-0000-000000000000"

    def test_retrieve_business_context_detailed_ranking(self):
        # Mock database rows
        mock_rows = [
            {
                "id": 1,
                "source_name": "Policies & Refund Rules",
                "content": "Refunds are allowed within 7 days of purchase with original receipt. Opened food items non-refundable.",
                "embedding": [0.1] * 768,
            },
            {
                "id": 2,
                "source_name": "Services, Products & Pricing",
                "content": "Standard consulting package is $150/hr. Premium audit is $500.",
                "embedding": [-0.1] * 768,
            },
        ]

        with patch("app.services.context_injector.supabase") as mock_sb:
            mock_table = MagicMock()
            mock_select = MagicMock()
            mock_eq = MagicMock()
            mock_eq.execute.return_value = MagicMock(data=mock_rows)
            mock_select.eq.return_value = mock_eq
            mock_table.select.return_value = mock_select
            mock_sb.table.return_value = mock_table

            # Mock embedding for query
            with patch("app.services.context_injector.get_embedding", return_value=[0.1] * 768):
                results = retrieve_business_context_detailed(
                    user_id=self.user_id,
                    task_intent="customer refund request",
                    threshold=0.45,
                    limit=2,
                )

                self.assertGreaterEqual(len(results), 1)
                top = results[0]
                self.assertEqual(top["source_name"], "Policies & Refund Rules")
                self.assertIn("Refunds are allowed within 7 days", top["content"])
                self.assertGreater(top["similarity"], 0.8)

    def test_retrieve_business_context_formats_source_headings(self):
        mock_detailed = [
            {
                "source_name": "Policies & Refund Rules",
                "content": "Refunds within 7 days.",
                "similarity": 0.92,
            }
        ]

        with patch("app.services.context_injector.retrieve_business_context_detailed", return_value=mock_detailed):
            formatted = retrieve_business_context(self.user_id, "refund", threshold=0.45)
            self.assertIn("[Policies & Refund Rules]", formatted)
            self.assertIn("Refunds within 7 days.", formatted)

    def test_test_query_endpoint_grounded(self):
        mock_chunks = [
            {
                "source_name": "Policies & Refund Rules",
                "content": "Refunds allowed within 7 days.",
                "similarity": 0.91,
            }
        ]

        with patch("app.routers.knowledge.retrieve_business_context_detailed", return_value=mock_chunks):
            with patch("google.genai.Client") as mock_genai_cls:
                mock_instance = MagicMock()
                mock_genai_cls.return_value = mock_instance
                mock_response = MagicMock(text="Under our policy, returns are accepted within 7 days of purchase.")
                mock_instance.models.generate_content.return_value = mock_response

                resp = self.client.post(
                    "/api/v1/knowledge/test-query",
                    json={"query": "Can I get a refund on my purchase?", "language": "en"},
                    headers={"X-User-Id": self.user_id},
                )

                self.assertEqual(resp.status_code, 200)
                data = resp.json()
                self.assertTrue(data["grounded"])
                self.assertIn("Policies & Refund Rules", data["sources"])
                self.assertIn("7 days", data["answer"])

    def test_test_query_endpoint_ungrounded_fallback(self):
        # When no knowledge chunks match
        with patch("app.routers.knowledge.retrieve_business_context_detailed", return_value=[]):
            resp = self.client.post(
                "/api/v1/knowledge/test-query",
                json={"query": "Do you repair lawnmowers?", "language": "en"},
                headers={"X-User-Id": self.user_id},
            )

            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertFalse(data["grounded"])
            self.assertIn("No matching business policy", data["answer"])

    def test_pillar_update_endpoint(self):
        with patch("app.routers.knowledge.supabase") as mock_sb:
            mock_table = MagicMock()
            mock_sb.table.return_value = mock_table
            mock_del = MagicMock()
            mock_del.eq.return_value.eq.return_value.execute.return_value = MagicMock()
            mock_table.delete.return_value = mock_del

            with patch("app.routers.knowledge.process_and_store_knowledge", return_value=3) as mock_process:
                payload = {
                    "pillar_key": "policies",
                    "title": "Policies & Refund Rules",
                    "content": "Full refunds within 7 days with receipt. Digital downloads non-refundable.",
                }
                resp = self.client.post(
                    "/api/v1/knowledge/pillar",
                    json=payload,
                    headers={"X-User-Id": self.user_id},
                )
                self.assertEqual(resp.status_code, 200)
                data = resp.json()
                self.assertEqual(data["sources_added"], 3)
                self.assertIn("saved successfully", data["message"])
                mock_process.assert_called_once_with(
                    user_id=self.user_id,
                    source_type="text",
                    source_name="Policies & Refund Rules",
                    content="Full refunds within 7 days with receipt. Digital downloads non-refundable.",
                )


if __name__ == "__main__":
    unittest.main()

