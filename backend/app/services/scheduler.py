import asyncio
import traceback
from datetime import datetime
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from app.services.orchestrator import run_agent_workflow
from app.services.telemetry import telemetry_manager

scheduler = AsyncIOScheduler()

async def execute_scheduled_agent(agent_id: str, user_id: str):
    """Callback for APScheduler to execute the agent."""
    try:
        await telemetry_manager.send_log(agent_id, "Scheduled execution started.", level="info")
        await run_agent_workflow(agent_id, user_id)
        await telemetry_manager.send_log(agent_id, "Scheduled execution completed.", level="info")
    except Exception as e:
        traceback.print_exc()
        await telemetry_manager.send_log(agent_id, f"Scheduled execution failed: {e}", level="error")

def add_or_update_job(agent_id: str, user_id: str, cron_expression: str):
    """Add or update an APScheduler job for the given agent."""
    if not cron_expression:
        return
        
    job_id = f"agent_{agent_id}"
    
    # Try parsing to make sure it's valid
    try:
        trigger = CronTrigger.from_crontab(cron_expression)
    except Exception as e:
        print(f"Invalid cron expression for {agent_id}: {cron_expression}. Error: {e}")
        return

    # If it exists, remove it first
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
        
    scheduler.add_job(
        execute_scheduled_agent,
        trigger,
        id=job_id,
        args=[agent_id, user_id],
        replace_existing=True
    )
    print(f"Scheduled agent {agent_id} with cron {cron_expression}")

def remove_job(agent_id: str):
    """Remove the APScheduler job for the given agent."""
    job_id = f"agent_{agent_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
        print(f"Removed schedule for agent {agent_id}")
