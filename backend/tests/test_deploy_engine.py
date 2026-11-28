import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.deploy_engine import (
    detect_project_stack,
    execute_deploy_action,
    normalize_platform_name,
    parse_env_file,
)


class _FakeHttpResponse:
    def __init__(self, status_code: int, payload, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or (json.dumps(payload) if payload is not None else "")
        self.url = "https://example-live-app.vercel.app"

    def json(self):
        return self._payload


class TestDeployEngine(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="voxagent_deploy_test_")
        self.repo_path = Path(self.test_dir) / "sample-app"
        self.repo_path.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_platform_normalization(self):
        self.assertEqual(normalize_platform_name("Vercel"), "vercel")
        self.assertEqual(normalize_platform_name("render.com"), "render")
        self.assertEqual(normalize_platform_name("Netlify CLI"), "netlify")
        self.assertIsNone(normalize_platform_name("unknowncloud"))

    def test_detect_monorepo_stack(self):
        fe = self.repo_path / "frontend"
        be = self.repo_path / "backend"
        fe.mkdir()
        be.mkdir()
        (fe / "package.json").write_text(json.dumps({"dependencies": {"vite": "^5.0.0"}, "scripts": {"build": "vite build"}}))
        (be / "requirements.txt").write_text("fastapi==0.115.0\nuvicorn==0.30.0\n")
        (be / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")

        stack = detect_project_stack(self.repo_path)
        self.assertTrue(stack["is_monorepo"])
        self.assertEqual(stack["frontend"]["framework"], "Vite")
        self.assertEqual(stack["frontend"]["output_dir"], "dist")
        self.assertEqual(stack["backend"]["framework"], "FastAPI")
        self.assertIn("uvicorn main:app", stack["backend"]["start_command"])
        self.assertEqual(stack["recommended_platform"], "render+vercel")

    def test_parse_env_file(self):
        (self.repo_path / ".env").write_text(
            '# Comment line\nSTRIPE_KEY="sk_test_123"\nexport API_URL=\'https://api.test.dev\'\nPLAIN=abc\n'
        )
        parsed = parse_env_file(self.repo_path)
        self.assertEqual(parsed["STRIPE_KEY"], "sk_test_123")
        self.assertEqual(parsed["API_URL"], "https://api.test.dev")
        self.assertEqual(parsed["PLAIN"], "abc")

    async def test_safety_and_missing_token_guards(self):
        # Missing repo -> pauses with needs_input instead of guessing Vox-Agent
        res_repo = await execute_deploy_action(action="DEPLOY_PROJECT", parameters={"platform": "vercel"})
        self.assertEqual(res_repo["status"], "needs_input")
        self.assertEqual(res_repo["missing_field"], "repository")

        # Valid path but no token in Vault -> pauses asking for API token
        (self.repo_path / "index.html").write_text("<h1>Hello</h1>")
        with patch("app.services.deploy_engine.get_app_credentials", return_value=None):
            res_tok = await execute_deploy_action(
                action="DEPLOY_PROJECT",
                parameters={"repo_path": str(self.repo_path), "platform": "netlify"},
                user_id="test_user",
            )
        self.assertEqual(res_tok["status"], "needs_input")
        self.assertEqual(res_tok["missing_field"], "api_token")
        self.assertIn("Netlify API Token", res_tok["question"])

    async def test_deploy_netlify_zip_flow_mocked(self):
        (self.repo_path / "index.html").write_text("<h1>Judge Demo Live</h1>")
        (self.repo_path / ".env").write_text("DEMO_MODE=true\n")

        async def _fake_request(method, url, **kwargs):
            if method == "GET" and url.endswith("/sites"):
                return _FakeHttpResponse(200, [])
            if method == "POST" and url.endswith("/sites"):
                return _FakeHttpResponse(201, {"id": "site_1", "name": "sample-app", "account_slug": "acc_1", "ssl_url": "https://sample-app.netlify.app"})
            if method == "POST" and "/env" in url:
                return _FakeHttpResponse(201, [])
            if method == "GET" and "/deploys/dep_1" in url:
                return _FakeHttpResponse(200, {"id": "dep_1", "state": "ready", "ssl_url": "https://sample-app.netlify.app"})
            return _FakeHttpResponse(200, {})

        async def _fake_post(url, **kwargs):
            if "/deploys" in url:
                return _FakeHttpResponse(201, {"id": "dep_1", "state": "ready", "ssl_url": "https://sample-app.netlify.app"})
            return _FakeHttpResponse(200, {})

        async def _fake_get(url, **kwargs):
            return _FakeHttpResponse(200, None, "OK")

        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(side_effect=_fake_request)
        mock_client.post = AsyncMock(side_effect=_fake_post)
        mock_client.get = AsyncMock(side_effect=_fake_get)

        with patch("app.services.deploy_engine.httpx.AsyncClient", return_value=mock_client), \
             patch("app.services.deploy_engine.save_app_credentials"):
            res = await execute_deploy_action(
                action="DEPLOY_PROJECT",
                parameters={"repo_path": str(self.repo_path), "platform": "netlify", "api_token": "nf_test_tok"},
                user_id="test_user",
            )

        self.assertEqual(res["status"], "success")
        out = res["result"]
        self.assertEqual(out["platform"], "netlify")
        self.assertEqual(out["live_url"], "https://sample-app.netlify.app")
        self.assertTrue(out["health"]["healthy"])
        self.assertIn("DEMO_MODE", out["env_vars_synced"])

    async def test_deploy_vercel_file_upload_flow_mocked(self):
        (self.repo_path / "index.html").write_text("<h1>Vercel Demo</h1>")

        async def _fake_request(method, url, **kwargs):
            if method == "GET" and "/v9/projects/" in url:
                return _FakeHttpResponse(404, {})
            if method == "POST" and url.endswith("/v9/projects"):
                return _FakeHttpResponse(201, {"id": "prj_123"})
            if method == "POST" and "/v13/deployments" in url:
                return _FakeHttpResponse(201, {
                    "id": "dpl_1",
                    "url": "sample-app-9t1234-user.vercel.app",
                    "readyState": "READY",
                    "alias": ["sample-app-chi.vercel.app"],
                })
            return _FakeHttpResponse(200, {})

        async def _fake_post(url, **kwargs):
            return _FakeHttpResponse(200, {})

        async def _fake_get(url, **kwargs):
            return _FakeHttpResponse(200, None, "OK")

        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(side_effect=_fake_request)
        mock_client.post = AsyncMock(side_effect=_fake_post)
        mock_client.get = AsyncMock(side_effect=_fake_get)

        with patch("app.services.deploy_engine.httpx.AsyncClient", return_value=mock_client), \
             patch("app.services.deploy_engine.save_app_credentials"):
            res = await execute_deploy_action(
                action="DEPLOY_PROJECT",
                parameters={"repo_path": str(self.repo_path), "platform": "vercel", "api_token": "vrc_test_tok"},
                user_id="test_user",
            )

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["result"]["platform"], "vercel")
        self.assertEqual(res["result"]["live_url"], "https://sample-app-chi.vercel.app")
        self.assertTrue(res["result"]["health"]["healthy"])

    async def test_deploy_render_service_flow_mocked(self):
        (self.repo_path / "requirements.txt").write_text("fastapi\nuvicorn\n")
        (self.repo_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")
        os.system(f"git -C '{self.repo_path}' init -b main >/dev/null 2>&1")
        os.system(f"git -C '{self.repo_path}' remote add origin https://github.com/test/sample-app.git >/dev/null 2>&1")

        async def _fake_request(method, url, **kwargs):
            if method == "GET" and url.endswith("/owners"):
                return _FakeHttpResponse(200, [{"owner": {"id": "own_1"}}])
            if method == "GET" and url.endswith("/services"):
                return _FakeHttpResponse(200, [])
            if method == "POST" and url.endswith("/services"):
                return _FakeHttpResponse(201, {"service": {"id": "srv_1", "serviceDetails": {"url": "https://sample-app.onrender.com"}}})
            if method == "PUT" and "/env-vars" in url:
                return _FakeHttpResponse(200, [])
            if method == "POST" and "/deploys" in url:
                return _FakeHttpResponse(201, {"id": "dep_r1", "status": "live"})
            return _FakeHttpResponse(200, {})

        async def _fake_get(url, **kwargs):
            return _FakeHttpResponse(200, None, "OK")

        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(side_effect=_fake_request)
        mock_client.get = AsyncMock(side_effect=_fake_get)

        with patch("app.services.deploy_engine.httpx.AsyncClient", return_value=mock_client), \
             patch("app.services.deploy_engine.save_app_credentials"):
            res = await execute_deploy_action(
                action="DEPLOY_PROJECT",
                parameters={"repo_path": str(self.repo_path), "platform": "render", "api_token": "rnd_test_tok"},
                user_id="test_user",
            )

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["result"]["platform"], "render")
        self.assertEqual(res["result"]["live_url"], "https://sample-app.onrender.com")
        self.assertTrue(res["result"]["health"]["healthy"])


if __name__ == "__main__":
    unittest.main()
