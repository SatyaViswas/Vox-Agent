import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime

async def main():
    scheduler = AsyncIOScheduler()
    scheduler.start()
    
    def my_job():
        print(f"Job fired at {datetime.now()}")
        
    scheduler.add_job(my_job, 'interval', seconds=1)
    
    await asyncio.sleep(3)
    scheduler.shutdown()

asyncio.run(main())
