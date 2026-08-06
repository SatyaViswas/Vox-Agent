import asyncio
from telethon import TelegramClient
from app.config import settings
from telethon.sessions import StringSession

async def main():
    print("API_ID:", settings.TELEGRAM_API_ID)
    client = TelegramClient(StringSession(), settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
    await client.connect()
    # We will just print if we can connect. We don't have the user's phone number.
    print("Connected successfully.")
    await client.disconnect()

asyncio.run(main())
