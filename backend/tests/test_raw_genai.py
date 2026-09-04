import os
import asyncio
from google import genai

async def main():
    try:
        from app.config import settings
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        response = await client.aio.models.generate_content(
            model='gemini-3.5-flash',
            contents='Hello',
        )
        print("Success:", response.text)
    except Exception as e:
        print("Error details:", repr(e))

asyncio.run(main())
