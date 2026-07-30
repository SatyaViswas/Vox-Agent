from supabase import create_client, Client
from app.config import settings

supabase: Client | None = None

if settings.SUPABASE_URL and settings.SUPABASE_SERVICE_ROLE_KEY:
    supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
else:
    print("WARNING: Supabase client could not be initialized due to missing credentials.")
