import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(supabase_url, supabase_key)

payload = {
    "trigger_type": "scheduled",
    "cron_schedule": "8 14 * * *",
    "is_active": False
}

agent_id = "990368c4-8c4e-4685-9327-2d12d865b501"
print(f"Updating agent {agent_id} with payload {payload}")

res = supabase.table("agents").update(payload).eq("id", agent_id).execute()
print("Response data:", res.data)
