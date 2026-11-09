import unittest
from unittest.mock import patch, MagicMock
from app.services.execution_events import (
    record_trigger_started,
    record_execution_completed,
    get_recent_execution_events,
)

class TestExecutionEvents(unittest.TestCase):
    def test_record_trigger_started_scheduled(self):
        event = record_trigger_started(
            agent_id="test_agent_123",
            user_id="test_user_456",
            trigger_type="scheduled",
            agent_title="Trending Laptops",
            run_id="run_test_001",
        )
        self.assertEqual(event["agent_id"], "test_agent_123")
        self.assertEqual(event["trigger_type"], "scheduled")
        self.assertEqual(event["status"], "info")
        self.assertIn("Scheduled run triggered", event["message"])
        self.assertIn("Trending Laptops", event["spoken_message"])

    def test_record_trigger_started_event_trigger(self):
        event = record_trigger_started(
            agent_id="test_agent_evt",
            user_id="test_user_456",
            trigger_type="event_trigger",
            agent_title="Gmail Auto Reply",
            run_id="run_test_002",
        )
        self.assertEqual(event["agent_id"], "test_agent_evt")
        self.assertEqual(event["trigger_type"], "event_trigger")
        self.assertEqual(event["status"], "info")
        self.assertIn("Trigger event detected", event["message"])
        self.assertIn("Gmail Auto Reply", event["spoken_message"])

    def test_record_execution_completed_success(self):
        step_logs = [
            {"step": 1, "app": "Amazon", "action": "SEARCH", "result": {"status": "success"}},
            {"step": 2, "app": "Google Sheets", "action": "APPEND", "result": {"status": "success"}},
        ]
        event = record_execution_completed(
            agent_id="test_agent_123",
            user_id="test_user_456",
            trigger_type="scheduled",
            outcome="success",
            step_logs=step_logs,
            agent_title="Trending Laptops",
            run_id="run_test_003",
            log_id="log_test_003",
        )
        self.assertEqual(event["status"], "success")
        self.assertEqual(event["skipped_steps"], [])
        self.assertIn("Scheduled workflow \"Trending Laptops\" executed successfully!", event["message"])
        self.assertIn("completed successfully", event["spoken_message"])

    def test_record_execution_completed_with_skipped_steps(self):
        step_logs = [
            {"step": 1, "app": "Amazon", "action": "SEARCH", "result": {"status": "success"}},
            {"step": 2, "app": "Telegram", "action": "SEND", "result": {"status": "skipped", "reason": "No new items"}},
        ]
        event = record_execution_completed(
            agent_id="test_agent_123",
            user_id="test_user_456",
            trigger_type="scheduled",
            outcome="success",
            step_logs=step_logs,
            agent_title="Trending Laptops",
            run_id="run_test_004",
            log_id="log_test_004",
        )
        self.assertEqual(event["status"], "success")
        self.assertEqual(event["skipped_steps"], [2])
        self.assertIn("completed with step 2 skipped", event["message"])
        self.assertIn("Step 2 was skipped as condition was not met", event["spoken_message"])

    def test_record_execution_completed_failure(self):
        step_logs = [
            {"step": 1, "app": "Amazon", "action": "SEARCH", "result": {"status": "failed", "error": "Timeout"}},
        ]
        event = record_execution_completed(
            agent_id="test_agent_123",
            user_id="test_user_456",
            trigger_type="event_trigger",
            outcome="failed",
            step_logs=step_logs,
            agent_title="Gmail Forwarder",
            run_id="run_test_005",
            log_id="log_test_005",
        )
        self.assertEqual(event["status"], "failed")
        self.assertIn("encountered an error during execution", event["message"])
        self.assertIn("failed", event["spoken_message"])

    def test_get_recent_execution_events(self):
        record_trigger_started(
            agent_id="test_agent_recent",
            user_id="test_user_456",
            trigger_type="scheduled",
            agent_title="Recent Agent",
            run_id="run_test_recent",
        )
        events = get_recent_execution_events(user_id="test_user_456", limit=10)
        self.assertIsInstance(events, list)
        found = any(e.get("agent_id") == "test_agent_recent" for e in events)
        self.assertTrue(found)

    def test_recent_executions_endpoint(self):
        from fastapi.testclient import TestClient
        from main import app
        client = TestClient(app)
        response = client.get("/api/v1/recent-executions", headers={"X-User-Id": "test_user_456"})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("status"), "success")
        self.assertIsInstance(data.get("events"), list)

if __name__ == "__main__":
    unittest.main()
