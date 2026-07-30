import os
import asyncio
import traceback
from browser_use import ChatGoogle
from langchain_core.messages import HumanMessage

# Monkey patch to fix aiohttp AssertionError
original_get_client = ChatGoogle.get_client
def _cached_get_client(self):
    if not hasattr(self, '_cached_client'):
        self._cached_client = original_get_client(self)
    return self._cached_client
ChatGoogle.get_client = _cached_get_client

async def main():
    try:
        from app.config import settings
        os.environ["GOOGLE_API_KEY"] = settings.GEMINI_API_KEY
        llm = ChatGoogle(model="gemini-3.5-flash", api_key=settings.GEMINI_API_KEY)
        msg = HumanMessage(content="Hello")
        res = await llm.ainvoke([msg])
        print("Success:", res)
    except Exception as e:
        print("Error details:", repr(e))
        if e.__cause__:
            print("Root cause:", repr(e.__cause__))

asyncio.run(main())
