import asyncio
from telethon import TelegramClient, events
from app.config import settings
from app.services.vault import get_app_credentials
from telethon.sessions import StringSession

async def main():
    creds = get_app_credentials("00000000-0000-0000-0000-000000000000", "Telegram Personal Account")
    client = TelegramClient(StringSession(creds["session_string"]), settings.TELEGRAM_API_ID, settings.TELEGRAM_API_HASH)
    await client.start()
    
    @client.on(events.NewMessage(incoming=True, outgoing=True))
    async def handler(event):
        print("Received message inside handler:", event.raw_text)

    await client.send_message("me", "Test message from script 3!")
    await asyncio.sleep(3)

asyncio.run(main())
