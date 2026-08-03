import json
import base64
import hashlib
from cryptography.fernet import Fernet
from app.config import settings
from app.database import supabase

import uuid

# Derive a 32-byte url-safe base64 key from SUPABASE_SERVICE_ROLE_KEY or a default fallback
_secret = settings.SUPABASE_SERVICE_ROLE_KEY or "default-insecure-vault-key-for-dev"
_key = base64.urlsafe_b64encode(hashlib.sha256(_secret.encode("utf-8")).digest())
_cipher = Fernet(_key)

def ensure_uuid(user_id: str) -> str:
    """Converts any arbitrary string into a valid deterministic UUID string."""
    try:
        return str(uuid.UUID(user_id))
    except ValueError:
        # Create a deterministic UUID from the string using uuid5 and DNS namespace
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, user_id))

def _ensure_user_exists(user_id_uuid: str, original_id: str) -> None:
    """Ensure a user record exists in the users table to satisfy foreign key constraints."""
    if not supabase:
        return
    try:
        user_check = supabase.table("users").select("id").eq("id", user_id_uuid).execute()
        if not user_check.data:
            supabase.table("users").insert({
                "id": user_id_uuid,
                "email": f"{original_id}@example.com"
            }).execute()
    except Exception:
        pass

def encrypt_data(data: dict | str) -> str:
    """Converts dict/str to JSON string and returns Fernet encrypted token."""
    if isinstance(data, dict):
        data_str = json.dumps(data)
    else:
        data_str = str(data)
    
    return _cipher.encrypt(data_str.encode("utf-8")).decode("utf-8")

def decrypt_data(encrypted_token: str) -> dict | str:
    """Decrypts token and returns original data."""
    decrypted_bytes = _cipher.decrypt(encrypted_token.encode("utf-8"))
    data_str = decrypted_bytes.decode("utf-8")
    
    try:
        return json.loads(data_str)
    except json.JSONDecodeError:
        return data_str

def save_app_credentials(user_id: str, app_name: str, auth_type: str, credentials_data: dict) -> dict:
    """Encrypts credentials_data and upserts into connected_apps."""
    if not supabase:
        raise Exception("Supabase client is not initialized")
        
    valid_uuid_str = ensure_uuid(user_id)
    _ensure_user_exists(valid_uuid_str, user_id)
    
    encrypted_token = encrypt_data(credentials_data)
    
    payload = {
        "user_id": valid_uuid_str,
        "app_name": app_name,
        "auth_type": auth_type,
        "encrypted_credentials": {"data": encrypted_token},
        "status": "active"
    }
    
    # Check if app credentials already exist for this user and app_name
    existing = supabase.table("connected_apps") \
        .select("id") \
        .eq("user_id", valid_uuid_str) \
        .eq("app_name", app_name) \
        .execute()
        
    if existing.data:
        # Update existing record
        record_id = existing.data[0]["id"]
        response = supabase.table("connected_apps").update(payload).eq("id", record_id).execute()
    else:
        # Insert new record
        response = supabase.table("connected_apps").insert(payload).execute()
    
    return response.data[0] if response.data else payload

def get_app_credentials(user_id: str, app_name: str) -> dict | None:
    """Fetches active record and returns decrypted credentials_data."""
    if not supabase:
        return None
        
    valid_uuid_str = ensure_uuid(user_id)
    response = supabase.table("connected_apps").select("*").eq("user_id", valid_uuid_str).eq("app_name", app_name).eq("status", "active").execute()
    
    if not response.data:
        return None
        
    record = response.data[0]
    encrypted_creds = record.get("encrypted_credentials")
    
    if not encrypted_creds:
        return None
        
    encrypted_token = None
    if isinstance(encrypted_creds, dict):
        encrypted_token = encrypted_creds.get("data")
    elif isinstance(encrypted_creds, str):
        try:
            parsed = json.loads(encrypted_creds)
            if isinstance(parsed, dict):
                encrypted_token = parsed.get("data")
        except Exception:
            encrypted_token = encrypted_creds
            
    if not encrypted_token:
        return None
        
    decrypted = decrypt_data(encrypted_token)
    if isinstance(decrypted, dict):
        return decrypted
    return {"token": decrypted}

def list_user_apps(user_id: str) -> list[dict]:
    """Returns summary of connected apps for a user, omitting sensitive token strings."""
    if not supabase:
        return []
        
    valid_uuid_str = ensure_uuid(user_id)
    response = supabase.table("connected_apps") \
        .select("id, app_name, auth_type, status, updated_at") \
        .eq("user_id", valid_uuid_str) \
        .order("updated_at", desc=True) \
        .execute()
    
    return response.data

def disconnect_app(user_id: str, app_name: str) -> bool:
    """Updates status to revoked for the target app."""
    if not supabase:
        return False

    valid_uuid_str = ensure_uuid(user_id)
    response = supabase.table("connected_apps").update({"status": "revoked"}).eq("user_id", valid_uuid_str).eq("app_name", app_name).execute()

    return len(response.data) > 0

VAULT_NOTES_APP_NAME = "voxagent vault notes"

def is_vault_notes_target(app_name: str) -> bool:
    """True when a workflow step's target app is the internal Vault Notes
    destination the planner falls back to when no real save location was
    specified (see planner.py Rule 1)."""
    return (app_name or "").strip().lower() == VAULT_NOTES_APP_NAME

def save_vault_note(user_id: str, title: str, content) -> dict:
    """Persists extracted/scraped data into the vault_notes table.

    vault_notes columns (per the live Supabase schema): id, user_id, title
    (varchar 255), content (jsonb), created_at. There is no dedicated
    agent/source column, so callers should fold that context (agent name,
    source app, timestamp) into `content` itself.
    """
    if not supabase:
        raise Exception("Supabase client is not initialized")

    valid_uuid_str = ensure_uuid(user_id)
    _ensure_user_exists(valid_uuid_str, user_id)

    payload = {
        "user_id": valid_uuid_str,
        "title": (title or "Untitled Note")[:255],
        "content": content,
    }

    response = supabase.table("vault_notes").insert(payload).execute()
    return response.data[0] if response.data else payload
