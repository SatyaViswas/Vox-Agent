import os
import asyncio
from google import genai

async def main():
    try:
        from app.config import settings
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        models = []
        for m in client.models.list():
            models.append(m.name)
        print("Models:", models)
    except Exception as e:
        print("Error details:", repr(e))

asyncio.run(main())
