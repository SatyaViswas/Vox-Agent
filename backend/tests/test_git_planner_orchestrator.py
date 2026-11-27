import asyncio
import unittest
from app.schemas.blueprint import WorkflowBlueprint, WorkflowStep, TriggerSpec
from app.services.orchestrator import _dispatch_action
from app.routers.vault import _compute_required_apps_status
from app.services.planner import get_system_prompt


class TestGitPlannerOrchestrator(unittest.IsolatedAsyncioTestCase):
    def test_schema_allows_git_client_route(self):
        step = WorkflowStep(
            step_number=1,
            route="git_client",
            app="Local Git",
            action="GIT_SMART_PUSH",
            parameters={"branch": "main"}
        )
        self.assertEqual(step.route, "git_client")

        blueprint = WorkflowBlueprint(
            title="Auto Git Push",
            trigger=TriggerSpec(type="manual", details="Push code"),
            required_apps=["Local Git"],
            steps=[step],
            needs_human_approval=False,
            needs_clarification=False,
        )
        self.assertEqual(blueprint.steps[0].action, "GIT_SMART_PUSH")

    def test_vault_required_apps_marks_local_git_as_builtin(self):
        status = _compute_required_apps_status(
            names=["Local Git", "Git"],
            route_list=["git_client", "git_client"],
            user_id="00000000-0000-0000-0000-000000000000"
        )
        self.assertEqual(len(status), 2)
        self.assertTrue(status[0]["connected"])
        self.assertTrue(status[0]["builtin"])
        self.assertTrue(status[1]["connected"])
        self.assertTrue(status[1]["builtin"])

    def test_planner_system_prompt_includes_git_client(self):
        prompt = get_system_prompt()
        self.assertIn("git_client", prompt)
        self.assertIn("GIT_SMART_PUSH", prompt)
        self.assertIn("Local Git", prompt)

    async def test_orchestrator_dispatches_git_client(self):
        # Dispatch status check via orchestrator's _dispatch_action
        res = await _dispatch_action(
            agent_id="test_agent",
            user_id="test_user",
            blueprint={},
            steps=[],
            index=0,
            step_number=1,
            step_results={},
            app="Local Git",
            action="GIT_STATUS",
            route="git_client",
            parameters={},
        )
        self.assertEqual(res["status"], "success")
        self.assertIn("branch", res["result"])

    async def test_orchestrator_enriches_github_pr_from_git_step(self):
        from unittest.mock import patch, AsyncMock

        mock_composio = AsyncMock(return_value={"status": "success", "output": {"html_url": "https://github.com/satyaviswas/Vox-Agent/pull/99"}})
        with patch("app.services.orchestrator.execute_composio_action", mock_composio):
            res = await _dispatch_action(
                agent_id="test_agent",
                user_id="test_user",
                blueprint={},
                steps=[],
                index=1,
                step_number=2,
                step_results={
                    1: {
                        "owner": "satyaviswas",
                        "repo": "Vox-Agent",
                        "branch": "feature/auth",
                        "default_branch": "main",
                        "pr_title": "feat: add auth",
                    }
                },
                app="GitHub",
                action="GITHUB_CREATE_A_PULL_REQUEST",
                route="composio_api",
                parameters={"title": "feat: add auth", "body": "Adds JWT"},
            )
        self.assertEqual(res["status"], "success")
        called_params = mock_composio.call_args.kwargs["parameters"]
        self.assertEqual(called_params["owner"], "satyaviswas")
        self.assertEqual(called_params["repo"], "Vox-Agent")
        self.assertEqual(called_params["head"], "feature/auth")
        self.assertEqual(called_params["base"], "main")


if __name__ == "__main__":
    unittest.main()
