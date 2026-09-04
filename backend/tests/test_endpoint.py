from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

res = client.patch(
    "/api/v1/agents/8b555ad7-ee4e-40fa-8c31-28fd9afe5d50/schedule",
    json={
        "trigger_type": "scheduled",
        "cron_schedule": None,
        "status": "paused"
    },
    headers={"X-User-Id": "00000000-0000-0000-0000-000000000000"}
)
print("Status:", res.status_code)
print("Response:", res.json())
