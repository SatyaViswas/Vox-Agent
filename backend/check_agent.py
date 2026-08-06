import asyncio
from app.database import supabase
import json

def main():
    agents = supabase.table("agents").select("*").eq("is_active", True).execute()
    for agent in agents.data:
        bp = agent.get('json_blueprint', {})
        if 'linkedin' in str(bp).lower() and 'summarise' in str(bp).lower():
            print(f"Found Agent ID: {agent['id']}")
            print(json.dumps(bp, indent=2))

main()
