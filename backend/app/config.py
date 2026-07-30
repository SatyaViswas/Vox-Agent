import os
import sys
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

# Load environment variables from backend/.env
load_dotenv()

class Settings(BaseSettings):
    GEMINI_API_KEY: str | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_SERVICE_ROLE_KEY: str | None = None
    COMPOSIO_API_KEY: str | None = None
    TELEGRAM_BOT_TOKEN: str | None = None
    GROQ_API_KEY: str | None = None
    PORT: int = 8000

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

settings = Settings()

# Check critical keys
critical_keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
missing_keys = [key for key in critical_keys if not getattr(settings, key)]

if missing_keys:
    print(f"WARNING: Missing critical environment variables: {', '.join(missing_keys)}", file=sys.stderr)
