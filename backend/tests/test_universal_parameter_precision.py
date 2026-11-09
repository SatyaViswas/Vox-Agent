import unittest
from datetime import datetime, timezone, timedelta
from app.services.parameter_normalizer import (
    normalize_datetime_value,
    unwrap_dict_for_field,
    normalize_action_parameter,
)
from app.services.orchestrator import _resolve_property
from app.services.composio_engine import _coerce_value_type, _apply_intelligent_data_extraction_limits


class TestUniversalParameterPrecision(unittest.TestCase):
    def setUp(self):
        self.fixed_now = datetime(2026, 11, 8, 14, 0, 0, tzinfo=timezone.utc)

    def test_relative_datetime_normalization(self):
        # Tomorrow lower bound (time_min)
        res_min = normalize_datetime_value("tomorrow", is_end_bound=False, now=self.fixed_now)
        self.assertEqual(res_min, "2026-11-09T00:00:00Z")

        # Tomorrow upper bound (time_max)
        res_max = normalize_datetime_value("tomorrow", is_end_bound=True, now=self.fixed_now)
        self.assertEqual(res_max, "2026-11-09T23:59:59Z")

        # Today
        today_min = normalize_datetime_value("today", is_end_bound=False, now=self.fixed_now)
        self.assertEqual(today_min, "2026-11-08T00:00:00Z")

        # Yesterday
        yest_min = normalize_datetime_value("yesterday", is_end_bound=False, now=self.fixed_now)
        self.assertEqual(yest_min, "2026-11-07T00:00:00Z")

        # In 3 days
        in_3 = normalize_datetime_value("in 3 days", is_end_bound=False, now=self.fixed_now)
        self.assertEqual(in_3, "2026-11-11T00:00:00Z")

        # Space separated datetime
        space_dt = normalize_datetime_value("2026-11-15 10:30:00", is_end_bound=False)
        self.assertEqual(space_dt, "2026-11-15T10:30:00Z")

    def test_dict_payload_unwrapping(self):
        payload = {
            "is_test": True,
            "subject": "Customer Cake Order",
            "sender": "sarah.jenkins@apexsolutions.io",
            "message_text": "We need custom cakes for 120 guests on Saturday.",
        }

        # Email field unwrap
        email = unwrap_dict_for_field("recipient_email", payload)
        self.assertEqual(email, "sarah.jenkins@apexsolutions.io")

        # Body field unwrap
        body = unwrap_dict_for_field("body", payload)
        self.assertEqual(body, "We need custom cakes for 120 guests on Saturday.")

        # Subject field unwrap
        subj = unwrap_dict_for_field("subject", payload)
        self.assertEqual(subj, "Customer Cake Order")

        # Target field unwrap
        target = unwrap_dict_for_field("target", payload)
        self.assertEqual(target, "sarah.jenkins@apexsolutions.io")

    def test_normalize_action_parameter_dict_and_datetime(self):
        payload = {
            "sender": "client@business.com",
            "message_text": "Inquiry details here",
        }
        # Dict passed to email
        email = normalize_action_parameter("Gmail", "GMAIL_SEND_EMAIL", "recipient_email", payload)
        self.assertEqual(email, "client@business.com")

        # Tomorrow passed to time_min
        t_min = normalize_action_parameter("Google Calendar", "GOOGLECALENDAR_FIND_EVENT", "time_min", "tomorrow")
        self.assertTrue(t_min.endswith("T00:00:00Z"))

        # Tomorrow passed to time_max
        t_max = normalize_action_parameter("Google Calendar", "GOOGLECALENDAR_FIND_EVENT", "time_max", "tomorrow")
        self.assertTrue(t_max.endswith("T23:59:59Z"))

    def test_resolve_property_aliases(self):
        data = {
            "sender": "sarah@apex.com",
            "message_text": "Hello world",
            "title": "Welcome",
        }
        # Exact
        self.assertEqual(_resolve_property(data, "sender"), "sarah@apex.com")
        # Aliases for email/sender
        self.assertEqual(_resolve_property(data, "from"), "sarah@apex.com")
        self.assertEqual(_resolve_property(data, "email"), "sarah@apex.com")
        # Aliases for body
        self.assertEqual(_resolve_property(data, "body"), "Hello world")
        self.assertEqual(_resolve_property(data, "text"), "Hello world")
        # Aliases for subject
        self.assertEqual(_resolve_property(data, "subject"), "Welcome")

    def test_google_calendar_limits_and_defaults(self):
        params = {"time_min": "2026-11-09T00:00:00Z"}
        updated = _apply_intelligent_data_extraction_limits("Google Calendar", "GOOGLECALENDAR_FIND_EVENT", params)
        self.assertEqual(updated.get("calendar_id"), "primary")
        self.assertEqual(updated.get("time_max"), "2026-11-09T23:59:59Z")
        self.assertTrue(updated.get("single_events"))
        self.assertEqual(updated.get("order_by"), "startTime")


if __name__ == "__main__":
    unittest.main()

