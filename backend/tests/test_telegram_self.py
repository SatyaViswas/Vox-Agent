import asyncio
from app.services.telegram_client_engine import _get_or_start_live_client
from telethon import events

async def main():
    print("Starting telegram client...")
    client = await _get_or_start_live_client("00000000-0000-0000-0000-000000000000")
    print("Connected!", client.is_connected())
    
    @client.on(events.NewMessage())
    async def handler(event):
        print("Received message:", event.raw_text)

    # Send a message to itself
    await client.send_message("me", "Test message from script!")
    
    print("Sent message to me. Waiting 3 seconds for it to arrive...")
    await asyncio.sleep(3)

asyncio.run(main())
