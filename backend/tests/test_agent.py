import os
import asyncio
import logging

# Enable debug logging for browser-use
logging.basicConfig(level=logging.DEBUG)

from app.config import settings
from browser_use import Agent, Browser, ChatGoogle

original_get_client = ChatGoogle.get_client
def _cached_get_client(self):
    if not hasattr(self, '_cached_client'):
        self._cached_client = original_get_client(self)
    return self._cached_client
ChatGoogle.get_client = _cached_get_client

async def main():
    gemini_key = settings.GEMINI_API_KEY
    os.environ["GOOGLE_API_KEY"] = gemini_key
    
    llm = ChatGoogle(model="gemini-3.5-flash", api_key=gemini_key)
    browser = Browser(headless=True)
    
    agent = Agent(
        task="Navigate to https://news.ycombinator.com and extract the title of the #1 top story",
        llm=llm,
        browser=browser,
        use_vision=False,
        llm_timeout=150
    )
    
    print("Starting agent...")
    try:
        history = await agent.run(max_steps=5)
        print("Final Result:", history.final_result())
    finally:
        await browser.kill()
        print("Browser closed.")

asyncio.run(main())
