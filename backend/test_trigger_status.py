import asyncio
from app.routers.execution import get_trigger_status
async def main():
    print(await get_trigger_status('ea2c95b7-3ceb-41e9-b27a-7ce00abb5e7a'))
    print(await get_trigger_status('db0e37e7-2bed-4706-a4e8-2e54977c0f79'))

asyncio.run(main())
