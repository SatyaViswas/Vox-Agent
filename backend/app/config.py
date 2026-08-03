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
    # App-level Telegram client credentials (from my.telegram.org) — used to
    # log VoxAgent into a user's own Telegram account (MTProto) so it can see
    # and send in any chat, including Saved Messages. Distinct from
    # TELEGRAM_BOT_TOKEN above, which is unused/for a future bot integration.
    TELEGRAM_API_ID: int | None = None
    TELEGRAM_API_HASH: str | None = None
    GROQ_API_KEY: str | None = None
    PORT: int = 8000
    # Comma-separated list of origins allowed to call the API / open the
    # telemetry websocket, e.g. "http://localhost:5173,https://app.example.com".
    ALLOWED_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",") if origin.strip()]

settings = Settings()

# Check critical keys
critical_keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
missing_keys = [key for key in critical_keys if not getattr(settings, key)]

if missing_keys:
    print(f"WARNING: Missing critical environment variables: {', '.join(missing_keys)}", file=sys.stderr)
