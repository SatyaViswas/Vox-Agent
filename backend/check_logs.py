import asyncio
from app.database import supabase

def main():
    logs = supabase.table("execution_logs").select("*").order("executed_at", desc=True).limit(5).execute()
    for log in logs.data:
        print(f"Agent: {log['agent_id']}, Status: {log['status']}, Time: {log['executed_at']}")
        if log.get('log_messages'):
            print("  Log: ", log['log_messages'][-1] if log['log_messages'] else "Empty")
        print("---")

main()
