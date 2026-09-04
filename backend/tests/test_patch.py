import httpx
import asyncio

async def test():
    async with httpx.AsyncClient() as client:
        res = await client.patch(
            "http://localhost:8000/api/v1/agents/b76fef23-e9a4-46f8-8814-9fdb1fbb4a83/schedule",
            json={
                "trigger_type": "scheduled",
                "cron_schedule": None,
                "status": "paused"
            },
            headers={"X-User-Id": "00000000-0000-0000-0000-000000000000"}
        )
        print(res.status_code)
        print(res.text)

asyncio.run(test())
