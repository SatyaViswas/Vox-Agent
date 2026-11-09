"""Unit tests for Gnani TTS Concurrency & Re-Entrant Lock Serialization."""

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from app.services.gnani_service import (
    _gnani_tts_lock,
    stream_speech_timbre,
    synthesize_speech_timbre,
)


class TestGnaniTTSConcurrency(unittest.TestCase):
    @patch("app.services.gnani_service.is_gnani_configured", return_value=True)
    @patch("app.services.gnani_service.get_tts_stream_client")
    @patch("app.services.gnani_service.get_tts_client")
    def test_reentrant_fallback_no_deadlock(self, mock_tts_client, mock_stream_client, mock_cfg):
        """Verify stream_speech_timbre falling back to synthesize_speech_timbre does not deadlock."""
        # Setup stream client to raise an exception
        bad_stream_client = MagicMock()
        bad_stream_client.synthesize_stream.side_effect = Exception("Streaming connection severed")
        mock_stream_client.return_value = bad_stream_client

        # Setup standard synthesis client to succeed
        tts_client = MagicMock()
        tts_client.synthesize.return_value = b"FULL_AUDIO_FALLBACK"
        mock_tts_client.return_value = tts_client

        # If _gnani_tts_lock was a non-reentrant Lock, this call would deadlock forever
        chunks = list(
            stream_speech_timbre(
                text="Testing re-entrant fallback",
                voice="Shivani",
                language="en-IN",
            )
        )
        self.assertEqual(chunks, [b"FULL_AUDIO_FALLBACK"])
        print("\n[PASS] Re-entrant lock test: stream exception successfully fell back to full synthesis without deadlock")

    @patch("app.services.gnani_service.is_gnani_configured", return_value=True)
    @patch("app.services.gnani_service.get_tts_client")
    def test_concurrent_synthesis_serialized(self, mock_tts_client, mock_cfg):
        """Verify concurrent synthesis requests are safely serialized through the lock."""
        active_calls = 0
        max_concurrent_calls = 0
        call_lock = threading.Lock()

        def slow_synthesize(*args, **kwargs):
            nonlocal active_calls, max_concurrent_calls
            with call_lock:
                active_calls += 1
                if active_calls > max_concurrent_calls:
                    max_concurrent_calls = active_calls
            time.sleep(0.05)
            with call_lock:
                active_calls -= 1
            return b"AUDIO_DATA"

        tts_client = MagicMock()
        tts_client.synthesize.side_effect = slow_synthesize
        mock_tts_client.return_value = tts_client

        threads = []
        for i in range(5):
            t = threading.Thread(
                target=synthesize_speech_timbre,
                kwargs={"text": f"Thread test {i}", "voice": "Shivani", "language": "en-IN"},
            )
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Concurrency must be strictly 1 at all times
        self.assertEqual(max_concurrent_calls, 1)
        print("[PASS] Concurrency test: 5 simultaneous synthesis threads strictly serialized to max 1 active call")


if __name__ == "__main__":
    unittest.main()

