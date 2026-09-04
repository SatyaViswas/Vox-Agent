"""Temporary test helper for manually verifying the MutAgent Phase 1 http_engine
fix. Not part of the app — safe to delete once you're done testing.

Run it in your OWN terminal (same machine/network namespace as your backend
process): `python3 _phase1_mock_server.py`
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys

# Per-path hit counters, used by the /flaky/<n> route below to fail the
# first n requests then succeed — lets Phase 2's retry-until-success
# behavior be proven purely from the persisted execution log (the "hit"
# count in the final logged result tells you how many real HTTP calls were
# made), without needing a live websocket listener.
_hit_counts: dict[str, int] = {}


class Handler(BaseHTTPRequestHandler):
    def _drain_body(self):
        # A real server always consumes the request body before responding;
        # this bare-bones handler didn't, which is what caused httpx's
        # ReadError when a GET carried a (possibly empty) JSON body.
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)

    def _respond(self):
        self._drain_body()
        path = self.path
        if path.startswith("/flaky/"):
            try:
                fail_times = int(path.split("/")[2])
            except (IndexError, ValueError):
                fail_times = 0
            hit = _hit_counts.get(path, 0) + 1
            _hit_counts[path] = hit
            code = 500 if hit <= fail_times else 200
        else:
            try:
                code = int(path.strip("/") or 200)
            except ValueError:
                code = 200
            hit = _hit_counts.get(path, 0) + 1
            _hit_counts[path] = hit
        body = f'{{"forced": true, "hit": {hit}}}'.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    print(f"Mock server listening on http://127.0.0.1:{port}  (e.g. /200 or /500 forces that status code)")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
