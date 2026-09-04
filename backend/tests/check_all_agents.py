import asyncio
from app.database import supabase
import json

def main():
    agents = supabase.table("agents").select("*").execute()
    for agent in agents.data:
        bp = agent.get('json_blueprint', {})
        if 'linkedin' in str(bp).lower() or 'article' in str(bp).lower():
            print(f"Found Agent ID: {agent['id']}")
            print(json.dumps(bp, indent=2))

main()
