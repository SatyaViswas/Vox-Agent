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

    # MutAgent Phase 2 — off by default until validated; when False, every
    # step runs exactly as it did before MutAgent existed (a single attempt,
    # no retry). See backend/app/services/mutagent/controller.py.
    MUTAGENT_ENABLED: bool = False
    # Total attempts (including the first) for a step whose failure classifies
    # as transient/rate-limited. 1 effectively disables retrying even if
    # MUTAGENT_ENABLED is True.
    MUTAGENT_MAX_RETRY_ATTEMPTS: int = 3

    # MutAgent Phase 4 — the LLM-repair mutator has its own, independent
    # gate (can stay off even with MUTAGENT_ENABLED=True) since it's the
    # only mutator with real LLM cost. Uses Groq (already configured in
    # this project) rather than Gemini, so self-healing's last line of
    # defense doesn't share a single point of failure with the rest of
    # the app's LLM calls.
    MUTAGENT_LLM_REPAIR_ENABLED: bool = False
    MUTAGENT_REPAIR_MODEL: str = "llama-3.3-70b-versatile"
    # When True (the default), every mutator beyond plain retry (selector
    # re-tries, LLM-proposed parameter fixes) only PROPOSES and logs what
    # it would do, without actually applying it — the original
    # failure/pause still surfaces normally. Flip to False only once
    # you've watched shadow-mode logs and trust the proposals.
    MUTAGENT_SHADOW_MODE: bool = True

    # MutAgent Phase 7 — circuit breaker: after this many consecutive
    # mutation-exhausted failures for the same (app, action), stop
    # attempting retries/mutation_memory/selector/LLM-repair on it for
    # MUTAGENT_CIRCUIT_BREAKER_COOLDOWN_MINUTES, escalating straight to a
    # human instead of burning latency/LLM cost on a likely-broken
    # integration every single run.
    MUTAGENT_CIRCUIT_BREAKER_THRESHOLD: int = 5
    MUTAGENT_CIRCUIT_BREAKER_COOLDOWN_MINUTES: int = 30

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
