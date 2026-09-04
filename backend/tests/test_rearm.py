import asyncio
from main import _rearm_event_trigger_agents
from app.routers.execution import get_trigger_status
from app.services.scheduler import scheduler

async def main():
    await _rearm_event_trigger_agents()
    print("Agent ea2c95b7:", await get_trigger_status('ea2c95b7-3ceb-41e9-b27a-7ce00abb5e7a'))
    print("Agent db0e37e7:", await get_trigger_status('db0e37e7-2bed-4706-a4e8-2e54977c0f79'))
    print("Scheduler running:", scheduler.running)
    jobs = scheduler.get_jobs()
    print("Scheduled jobs:", len(jobs))
    for j in jobs:
        print(j.id, j.trigger)

asyncio.run(main())
