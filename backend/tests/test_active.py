import asyncio
from main import _rearm_event_trigger_agents
from app.services.trigger_engine import _active_agents as composio_agents
from app.services.telegram_client_engine import _active_agents as telegram_agents

async def main():
    await _rearm_event_trigger_agents()
    print("Composio agents:", composio_agents)
    print("Telegram agents:", telegram_agents)

asyncio.run(main())
