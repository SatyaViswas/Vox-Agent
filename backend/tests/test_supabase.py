import os
from supabase import create_client

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not url or not key:
    print("Missing env vars, reading from .env")
    from dotenv import load_dotenv
    load_dotenv()
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

supabase = create_client(url, key)

# Try updating an agent to see what it returns
res = supabase.table("agents").select("id").limit(1).execute()
if res.data:
    agent_id = res.data[0]["id"]
    print(f"Updating agent {agent_id}")
    update_res = supabase.table("agents").update({"is_active": False}).eq("id", agent_id).execute()
    print("Update response data:", update_res.data)
else:
    print("No agents found")
