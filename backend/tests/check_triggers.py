import asyncio
from app.database import supabase
from app.services import trigger_engine, telegram_client_engine
from app.services.scheduler import scheduler
print(supabase.table("agents").select("id, trigger_type, is_active").execute().data)
