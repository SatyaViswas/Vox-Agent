import os
import sys
from pathlib import Path
from browser_use import Agent, Browser, ChatGoogle
from app.config import settings
from app.services.browser_stealth import chromium_launch_kwargs, desktop_user_agent

# Explicitly prepend the project's local venv/bin path
venv_bin = str(Path(__file__).parent.parent.parent / "venv" / "bin")
if venv_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{venv_bin}{os.pathsep}{os.environ.get('PATH', '')}"

async def execute_browser_action(
    task_description: str, 
    session_cookies: list | None = None,
    user_id: str = "00000000-0000-0000-0000-000000000000",
    app_name: str | None = None
) -> dict:
    gemini_key = settings.GEMINI_API_KEY or os.getenv("GOOGLE_API_KEY")
    if not gemini_key:
        return {"status": "error", "error": "GEMINI_API_KEY is not configured."}
        
    # ChatGoogle relies on os.environ["GOOGLE_API_KEY"] internally
    os.environ["GOOGLE_API_KEY"] = gemini_key
    os.environ["GEMINI_API_KEY"] = gemini_key
        
    try:
        # Monkey patch ChatGoogle to retain the client instance and fix aiohttp AssertionError
        if not hasattr(ChatGoogle, "_cached_get_client"):
            original_get_client = ChatGoogle.get_client
            def _cached_get_client(self):
                if not hasattr(self, '_cached_client'):
                    self._cached_client = original_get_client(self)
                return self._cached_client
            ChatGoogle.get_client = _cached_get_client
            ChatGoogle._cached_get_client = True
            
        llm = ChatGoogle(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key
        )
        
        # Setup Browser Context with stored session cookies from Vault if app_name is provided
        storage_state = None
        sensitive_data = None
        if app_name:
            from app.services.vault import get_app_credentials
            credentials = get_app_credentials(user_id, app_name)
            if credentials and "cookies" in credentials:
                # Playwright expects this exact structure
                storage_state = credentials
            elif credentials and (credentials.get("username") or credentials.get("password")):
                # A portal saved via the App Vault's "web session" form
                # (name/url/username/password, no cookies) — hand the
                # username/password to browser_use's own sensitive_data
                # mechanism so the agent can fill a login form itself. The
                # LLM only ever sees the placeholder names below, never the
                # real values (browser_use substitutes them at the browser
                # layer), so a stored password never enters the model's
                # context or gets logged.
                sensitive_data = {
                    "x_username": credentials.get("username") or "",
                    "x_password": credentials.get("password") or "",
                }
                login_url = credentials.get("url")
                login_hint = (
                    f"First navigate to {login_url} and log in" if login_url else "If a login form appears, log in"
                )
                task_description = (
                    f"{login_hint} using the sensitive_data placeholders x_username and x_password. "
                    f"Then: {task_description}"
                )

        # Merge manual session_cookies if provided
        if session_cookies and storage_state is None:
            storage_state = {"cookies": session_cookies, "origins": []}

        # Same anti-fingerprinting config as the headed login-capture window
        # (browser_login_engine.py) — a task step running against a
        # bot-protected site (e.g. browsing showtimes on a ticketing site
        # right after a successful login) is just as exposed to the same
        # detection, headless if anything more so historically.
        browser_kwargs = chromium_launch_kwargs(headless=True)
        browser_kwargs["user_agent"] = desktop_user_agent()
        if storage_state:
            browser_kwargs["storage_state"] = storage_state

        browser = Browser(**browser_kwargs)

        agent_kwargs = {
            "task": task_description,
            "llm": llm,
            "browser": browser,
            "use_vision": False,
            "llm_timeout": 150,
        }
        if sensitive_data:
            agent_kwargs["sensitive_data"] = sensitive_data
        agent = Agent(**agent_kwargs)

        try:
            # max_steps ensures it doesn't loop infinitely if stuck
            history = await agent.run(max_steps=30)
            extracted_text = history.final_result() if hasattr(history, "final_result") else str(history)
            # The agent's own end-of-run self-assessment (True/False once
            # it calls "done", None if it never did) — the orchestrator
            # uses this (not just "no exception was raised") to decide
            # whether this was a real success, e.g. a login wall the agent
            # gave up on still returns cleanly here with no exception.
            agent_success = history.is_successful() if hasattr(history, "is_successful") else None

            return {"status": "success", "result": extracted_text, "agent_success": agent_success}
        finally:
            # ALWAYS cleanly kill the browser session when done
            if hasattr(browser, "kill"):
                await browser.kill()
            elif hasattr(browser, "close"):
                await browser.close()
    except Exception as e:
        return {"status": "error", "error": str(e)}
