import unittest
from unittest.mock import patch

from app.routers.vault import _compute_required_apps_status
from app.schemas.blueprint import TriggerSpec, WorkflowBlueprint, WorkflowStep
from app.services.orchestrator import _dispatch_action
from app.services.planner import _apply_route_fallback_and_required_apps, get_system_prompt


class TestDeployPlannerOrchestrator(unittest.IsolatedAsyncioTestCase):
    def test_schema_allows_deploy_client_route(self):
        step = WorkflowStep(
            step_number=1,
            route="deploy_client",
            app="Vercel",
            action="DEPLOY_PROJECT",
            parameters={"platform": "vercel", "repository": "voxagent-judge-demo", "sync_env": True},
        )
        self.assertEqual(step.route, "deploy_client")

        bp = WorkflowBlueprint(
            title="Deploy Demo to Vercel",
            trigger=TriggerSpec(type="manual", details="Deploy app"),
            required_apps=["Vercel"],
            steps=[step],
            needs_human_approval=False,
            needs_clarification=False,
        )
        self.assertEqual(bp.steps[0].app, "Vercel")

    def test_route_fallback_upgrades_netlify_vercel_render_to_deploy_client(self):
        raw_plan = {
            "steps": [
                {
                    "step_number": 1,
                    "route": "composio_api",
                    "app": "Netlify",
                    "action": "DEPLOY_PROJECT",
                    "parameters": {"repository": "voxagent-judge-demo"},
                }
            ],
            "required_apps": [],
        }
        _apply_route_fallback_and_required_apps(raw_plan, "Deploy voxagent-judge-demo to Netlify")
        self.assertEqual(raw_plan["steps"][0]["route"], "deploy_client")
        self.assertEqual(raw_plan["steps"][0]["parameters"]["platform"], "netlify")
        self.assertIn("Netlify", raw_plan["required_apps"])

    def test_vault_required_apps_checks_deploy_vault_status(self):
        with patch("app.routers.vault.list_composio_connected_accounts", return_value=[]), \
             patch("app.routers.vault.list_user_apps", return_value=[{"app_name": "Vercel", "status": "active"}]):
            status = _compute_required_apps_status(
                names=["Vercel", "Netlify"],
                route_list=["deploy_client", "deploy_client"],
                user_id="00000000-0000-0000-0000-000000000000",
            )
        self.assertEqual(len(status), 2)
        self.assertTrue(status[0]["connected"])
        self.assertEqual(status[0]["connect_via"], "deploy_vault")
        self.assertFalse(status[1]["connected"])
        self.assertEqual(status[1]["connect_via"], "deploy_vault")

    def test_planner_system_prompt_includes_deploy_client(self):
        prompt = get_system_prompt()
        self.assertIn("deploy_client", prompt)
        self.assertIn("DEPLOY_PROJECT", prompt)
        self.assertIn("Vercel", prompt)
        self.assertIn("Render", prompt)
        self.assertIn("Netlify", prompt)

    async def test_orchestrator_dispatches_deploy_client(self):
        res = await _dispatch_action(
            agent_id="test_agent",
            user_id="test_user",
            blueprint={},
            steps=[],
            index=0,
            step_number=1,
            step_results={},
            app="Vercel",
            action="DEPLOY_DETECT_STACK",
            route="deploy_client",
            parameters={},
        )
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["result"]["repository"], "Vox-Agent")
        self.assertTrue(res["result"]["is_monorepo"])


if __name__ == "__main__":
    unittest.main()
