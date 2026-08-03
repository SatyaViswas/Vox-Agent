import os
import sys
from pathlib import Path
from browser_use import Agent, Browser, ChatGoogle
from app.config import settings

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
            model="gemini-3.1-flash-lite",
            api_key=gemini_key
        )
        
        # Find local Playwright chromium if available to prevent downloading via uvx
        executable_path = None
        import glob
        patterns = [
            os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
        ]
        for pattern in patterns:
            matches = glob.glob(pattern)
            if matches:
                executable_path = matches[0]
                break
                
        # Setup Browser Context with stored session cookies from Vault if app_name is provided
        storage_state = None
        if app_name:
            from app.services.vault import get_app_credentials
            credentials = get_app_credentials(user_id, app_name)
            if credentials and "cookies" in credentials:
                # Playwright expects this exact structure
                storage_state = credentials
                
        # Merge manual session_cookies if provided
        if session_cookies and storage_state is None:
            storage_state = {"cookies": session_cookies, "origins": []}

        browser_kwargs = {"headless": True}
        if executable_path:
            browser_kwargs["executable_path"] = executable_path
        if storage_state:
            browser_kwargs["storage_state"] = storage_state
            
        browser = Browser(**browser_kwargs)
            
        agent = Agent(
            task=task_description,
            llm=llm,
            browser=browser,
            use_vision=False,
            llm_timeout=150
        )
        
        try:
            # max_steps ensures it doesn't loop infinitely if stuck
            history = await agent.run(max_steps=30)
            extracted_text = history.final_result() if hasattr(history, "final_result") else str(history)
            
            return {"status": "success", "result": extracted_text}
        finally:
            # ALWAYS cleanly kill the browser session when done
            if hasattr(browser, "kill"):
                await browser.kill()
            elif hasattr(browser, "close"):
                await browser.close()
    except Exception as e:
        return {"status": "error", "error": str(e)}
