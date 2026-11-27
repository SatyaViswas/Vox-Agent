import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from app.services.git_engine import (
    is_sensitive_file,
    resolve_repo_path,
    git_status,
    git_diff,
    git_log,
    execute_git_action,
    run_git_command,
    ensure_gitignore_secrets,
)


class TestGitEngine(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Create a temporary local git repo for safe sandboxed testing
        self.test_dir = tempfile.mkdtemp(prefix="voxagent_git_test_")
        self.repo_path = Path(self.test_dir)
        # Initialize test git repo
        os.system(f"git -C '{self.test_dir}' init -b main >/dev/null 2>&1")
        os.system(f"git -C '{self.test_dir}' config user.name 'Test Dev' >/dev/null 2>&1")
        os.system(f"git -C '{self.test_dir}' config user.email 'test@voxagent.ai' >/dev/null 2>&1")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_sensitive_file_detection(self):
        # Sensitive files must be detected
        self.assertTrue(is_sensitive_file(".env"))
        self.assertTrue(is_sensitive_file(".env.local"))
        self.assertTrue(is_sensitive_file(".env.production"))
        self.assertTrue(is_sensitive_file("backend/.env"))
        self.assertTrue(is_sensitive_file("id_rsa"))
        self.assertTrue(is_sensitive_file("server.pem"))
        self.assertTrue(is_sensitive_file("private.key"))
        self.assertTrue(is_sensitive_file("gcp_credentials.json"))
        self.assertTrue(is_sensitive_file("serviceAccountKey.json"))

        # Safe files must NOT be detected as sensitive
        self.assertFalse(is_sensitive_file("main.py"))
        self.assertFalse(is_sensitive_file("package.json"))
        self.assertFalse(is_sensitive_file("src/App.jsx"))
        self.assertFalse(is_sensitive_file("README.md"))

    async def test_git_status_and_commit_in_sandbox(self):
        # Initial status should be clean
        status = await git_status(self.repo_path)
        self.assertEqual(status["branch"], "main")
        self.assertTrue(status["is_clean"])

        # Create a safe file and a secret file
        safe_file = self.repo_path / "app.py"
        safe_file.write_text("print('hello world')")
        secret_file = self.repo_path / ".env"
        secret_file.write_text("OPENAI_API_KEY=sk-secret123456")

        status_after = await git_status(self.repo_path)
        self.assertFalse(status_after["is_clean"])
        self.assertEqual(status_after["untracked_count"], 2)

        # Stage files via execute_git_action
        add_res = await execute_git_action(
            action="GIT_ADD",
            parameters={"repo_path": str(self.repo_path)},
        )
        self.assertEqual(add_res["status"], "success")
        result = add_res["result"]
        # Safe file must be staged
        self.assertIn("app.py", result["staged_files"])
        # Secret file must be BLOCKED
        self.assertIn(".env", result["blocked_secrets"])

        # Check that .gitignore was updated to include .env
        gitignore = self.repo_path / ".gitignore"
        self.assertTrue(gitignore.exists())
        content = gitignore.read_text()
        self.assertIn(".env", content)

        # Commit safe file
        commit_res = await execute_git_action(
            action="GIT_COMMIT",
            parameters={"repo_path": str(self.repo_path), "message": "feat(core): initial app commit"},
        )
        self.assertEqual(commit_res["status"], "success")
        self.assertTrue(commit_res["result"]["committed"])

        # Log must have the new commit
        log_res = await execute_git_action(
            action="GIT_LOG",
            parameters={"repo_path": str(self.repo_path), "limit": 1},
        )
        self.assertEqual(log_res["status"], "success")
        commits = log_res["result"]["commits"]
        self.assertEqual(len(commits), 1)
        self.assertIn("feat(core): initial app commit", commits[0]["message"])

    async def test_execute_git_action_dispatch_on_real_repo(self):
        # Test status on current real repository
        res = await execute_git_action(action="GIT_STATUS")
        self.assertEqual(res["status"], "success")
        self.assertIn("branch", res["result"])
        self.assertIn("repository", res["result"])

        # Test diff
        diff_res = await execute_git_action(action="GIT_DIFF")
        self.assertEqual(diff_res["status"], "success")
        self.assertIn("has_changes", diff_res["result"])

        # Test invalid action error handling
        err_res = await execute_git_action(action="UNKNOWN_ACTION_XYZ")
        self.assertEqual(err_res["status"], "error")
        self.assertIn("Unknown Git action", err_res["error"])

    async def test_git_checkout_and_clean_smart_push(self):
        # Create a branch
        checkout_res = await execute_git_action(
            action="GIT_CHECKOUT",
            parameters={"repo_path": str(self.repo_path), "branch": "feature/auth-test", "create": True},
        )
        self.assertEqual(checkout_res["status"], "success")
        self.assertEqual(checkout_res["result"]["branch"], "feature/auth-test")

        # Calling smart push on clean repo should report nothing to commit cleanly
        smart_push_res = await execute_git_action(
            action="GIT_SMART_PUSH",
            parameters={"repo_path": str(self.repo_path)},
        )
        self.assertEqual(smart_push_res["status"], "success")
        self.assertFalse(smart_push_res["result"]["committed"])
        self.assertIn("clean", smart_push_res["result"]["message"].lower())

    async def test_local_repo_discovery_and_multi_repo_local_mode(self):
        from app.services.git_engine import discover_local_repos

        repos = discover_local_repos()
        repo_names = [r["name"] for r in repos]
        self.assertIn("Vox-Agent", repo_names)

        # Test resolving by repository parameter name (e.g. 'Vox-Agent')
        log_res = await execute_git_action(
            action="GIT_LOG",
            parameters={"repository": "Vox-Agent", "limit": 2},
        )
        self.assertEqual(log_res["status"], "success")
        self.assertEqual(log_res["result"]["repository"], "Vox-Agent")

        # Test multi-repo 'local' mode across all discovered repositories
        local_status = await execute_git_action(
            action="GIT_STATUS",
            parameters={"repository": "local"},
        )
        self.assertEqual(local_status["status"], "success")
        self.assertTrue(local_status["result"]["multi_repo"])
        self.assertIn("Vox-Agent", local_status["result"]["repositories_scanned"])

    def test_parse_github_remote(self):
        from app.services.git_engine import parse_github_remote

        self.assertEqual(
            parse_github_remote("https://github.com/octocat/Spoon-Knife.git"),
            ("octocat", "Spoon-Knife"),
        )
        self.assertEqual(
            parse_github_remote("git@github.com:satyaviswas/Vox-Agent.git"),
            ("satyaviswas", "Vox-Agent"),
        )
        self.assertEqual(parse_github_remote(None), (None, None))

    async def test_git_init_repo_scaffolding(self):
        new_proj = Path(self.test_dir) / "fresh_student_project"
        res = await execute_git_action(
            action="GIT_INIT",
            parameters={"repo_path": str(new_proj), "title": "My CS50 Final Project"},
        )
        self.assertEqual(res["status"], "success")
        self.assertTrue(res["result"]["initialized"])
        self.assertTrue((new_proj / ".git").exists())
        self.assertTrue((new_proj / ".gitignore").exists())
        self.assertTrue((new_proj / "README.md").exists())
        self.assertIn(".env", (new_proj / ".gitignore").read_text())
        self.assertIn("My CS50 Final Project", (new_proj / "README.md").read_text())
        self.assertTrue(res["result"]["initial_committed"])

    async def test_smart_push_missing_origin_asks_input_and_resumes(self):
        # Write a file in sandbox repo (which has no origin remote yet)
        (self.repo_path / "feature.py").write_text("print('auth feature')\n")

        # 1st attempt without origin -> must cleanly pause with needs_input instead of crashing
        res1 = await execute_git_action(
            action="GIT_SMART_PUSH",
            parameters={"repo_path": str(self.repo_path), "branch": "feature/test-pr", "commit_message": "feat: add auth"},
        )
        self.assertEqual(res1["status"], "needs_input")
        self.assertEqual(res1["missing_field"], "remote_url")
        self.assertIn("origin", res1["question"].lower())

        # Create a bare local remote and configure origin, then test full branch switch + commit + push
        bare_remote = Path(self.test_dir) / "remote_origin.git"
        os.system(f"git init --bare '{bare_remote}' >/dev/null 2>&1")
        os.system(f"git -C '{self.repo_path}' remote add origin '{bare_remote}' >/dev/null 2>&1")

        res2 = await execute_git_action(
            action="GIT_SMART_PUSH",
            parameters={"repo_path": str(self.repo_path), "branch": "feature/test-pr", "commit_message": "feat: add auth"},
        )
        self.assertEqual(res2["status"], "success")
        self.assertTrue(res2["result"]["pushed"])
        self.assertEqual(res2["result"]["branch"], "feature/test-pr")
        self.assertEqual(res2["result"]["commit_message"], "feat: add auth")

        # Verify both origin/main and origin/feature/test-pr exist on bare_remote (so GitHub PR base='main' is always valid!)
        heads = await run_git_command(["ls-remote", "--heads", "origin"], self.repo_path)
        self.assertIn("refs/heads/main", heads[1])
        self.assertIn("refs/heads/feature/test-pr", heads[1])

    async def test_ensure_remote_base_branch_fixes_single_orphan_feature_branch(self):
        from app.services.git_engine import ensure_remote_base_branch

        bare_remote = Path(self.test_dir) / "orphan_remote.git"
        orphan_repo = Path(self.test_dir) / "orphan_repo"
        os.system(f"git init --bare '{bare_remote}' >/dev/null 2>&1")
        os.system(f"git init -b feature/solo '{orphan_repo}' >/dev/null 2>&1")
        os.system(f"git -C '{orphan_repo}' config user.name 'Dev' >/dev/null 2>&1")
        os.system(f"git -C '{orphan_repo}' config user.email 'dev@test.com' >/dev/null 2>&1")
        (orphan_repo / "app.py").write_text("print('solo')\n")
        os.system(f"git -C '{orphan_repo}' add . && git -C '{orphan_repo}' commit -m 'feat: solo commit' >/dev/null 2>&1")
        os.system(f"git -C '{orphan_repo}' remote add origin '{bare_remote}' >/dev/null 2>&1")
        os.system(f"git -C '{orphan_repo}' push -u origin feature/solo >/dev/null 2>&1")

        # Fix missing origin/main automatically
        await ensure_remote_base_branch(orphan_repo, "main", "feature/solo")

        heads = await run_git_command(["ls-remote", "--heads", "origin"], orphan_repo)
        self.assertIn("refs/heads/main", heads[1])
        self.assertIn("refs/heads/feature/solo", heads[1])

    async def test_mutating_git_action_requires_explicit_repo_guard(self):
        # Calling GIT_SMART_PUSH or GIT_CHECKOUT with no repo MUST pause with needs_input
        # and NEVER silently touch DEFAULT_REPO_PATH (Vox-Agent)
        res = await execute_git_action(action="GIT_SMART_PUSH", parameters={"branch": "feature/oops"})
        self.assertEqual(res["status"], "needs_input")
        self.assertEqual(res["missing_field"], "repository")
        self.assertIsInstance(res.get("options"), list)

        res_auto = await execute_git_action(action="GIT_CHECKOUT", parameters={"repository": "auto", "branch": "test"})
        self.assertEqual(res_auto["status"], "needs_input")
        self.assertEqual(res_auto["missing_field"], "repository")

    async def test_git_status_includes_clean_human_summary(self):
        (self.repo_path / "notes.txt").write_text("hello")
        status = await git_status(self.repo_path)
        self.assertIn("human_summary", status)
        self.assertIn("Repository:", status["human_summary"])
        self.assertIn("notes.txt", status["human_summary"])
        self.assertNotIn("{", status["human_summary"])


if __name__ == "__main__":
    unittest.main()
