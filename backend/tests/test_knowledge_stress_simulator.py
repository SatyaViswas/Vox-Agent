import unittest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from main import app
from app.schemas.knowledge import KnowledgeStressTestRequest, KnowledgeStressTestResponse
from app.services.knowledge_simulator import run_knowledge_stress_test, get_latest_cached_stress_test


class TestKnowledgeStressSimulator(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.user_id = "00000000-0000-0000-0000-000000000000"

    async def test_run_knowledge_stress_test_service(self):
        req = KnowledgeStressTestRequest(count=4)
        report = await run_knowledge_stress_test(self.user_id, req)
        self.assertIsInstance(report, KnowledgeStressTestResponse)
        self.assertGreaterEqual(report.reliability_score, 0.0)
        self.assertLessEqual(report.reliability_score, 100.0)
        self.assertIn(report.readiness_status, ["DEPLOYMENT_READY", "ACCEPTABLE", "NEEDS_REVIEW"])
        self.assertGreaterEqual(len(report.scenarios), 4)
        for sc in report.scenarios:
            self.assertIn(sc.verdict, ["passed", "warning", "failed"])
            self.assertTrue(len(sc.customer_query) > 0)
            self.assertTrue(len(sc.agent_answer) > 0)

    def test_stress_test_endpoint_post_and_get(self):
        # 1. Post stress test
        resp = self.client.post(
            "/api/v1/knowledge/stress-test",
            headers={"X-User-Id": self.user_id},
            json={"count": 4},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("reliability_score", data)
        self.assertIn("readiness_status", data)
        self.assertIn("scenarios", data)
        self.assertEqual(data["powered_by"], "Adaption Labs")

        # 2. Get latest cached report
        latest_resp = self.client.get(
            "/api/v1/knowledge/stress-test/latest",
            headers={"X-User-Id": self.user_id},
        )
        self.assertEqual(latest_resp.status_code, 200)
        latest_data = latest_resp.json()
        self.assertEqual(latest_data["reliability_score"], data["reliability_score"])
        self.assertEqual(latest_data["readiness_status"], data["readiness_status"])


if __name__ == "__main__":
    unittest.main()
