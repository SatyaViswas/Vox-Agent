"""Dynamic ASR Context & Keyterm Injection Service for Gnani Prisma v3.0.

Extracts personalized user entities (connected apps, vault note titles,
agent workflows, knowledge sources) and injects them as dynamic keyterms
into Gnani Prisma v3.0 Speech-to-Text.
"""

import logging
import re
import time
from typing import Dict, List, Optional, Set, Tuple

from app.database import supabase
from app.services.vault import ensure_uuid

logger = logging.getLogger(__name__)

# Core platform and standard SaaS tool keywords
STATIC_AUTOMATION_KEYTERMS: List[str] = [
    "VoxAgent",
    "Gnani AI",
    "Composio",
    "Playwright",
    "FastAPI",
    "Supabase",
    "webhook",
    "blueprint",
    "workflow",
    "trigger",
    "Gmail",
    "Google Sheets",
    "Google Calendar",
    "Google Docs",
    "Slack",
    "Notion",
    "Airtable",
    "Telegram",
    "WhatsApp",
    "GitHub",
    "Trello",
    "Jira",
    "Zomato",
    "Swiggy",
    "Discord",
    "LinkedIn",
    "Instagram",
    "Canva",
]

# Simple in-memory cache with 60-second TTL: user_id -> (timestamp, keyterms, topic, user_count)
_CACHE_TTL_SECONDS = 60
_user_context_cache: Dict[str, Tuple[float, List[str], str, int]] = {}


def _clean_token(raw: str) -> Optional[str]:
    """Clean and sanitize entity names into clean speech keyterms."""
    if not raw or not raw.strip():
        return None
    # Strip common file extensions
    cleaned = re.sub(r"\.(pdf|csv|txt|wav|mp3|m4a|ogg|flac|json|xlsx?)$", "", raw, flags=re.I)
    # Strip leading/trailing symbols, underscores, or dashes
    cleaned = re.sub(r"^[\W_]+|[\W_]+$", "", cleaned)
    cleaned = cleaned.strip()

    # Discard overly long sentences or empty strings
    if not cleaned or len(cleaned) < 2 or len(cleaned) > 50:
        return None
    return cleaned


def extract_user_entities(user_id: str) -> Set[str]:
    """Fetch active connected apps, notes, agents, and knowledge titles for user."""
    entities: Set[str] = set()
    if not supabase:
        return entities

    try:
        valid_uuid = ensure_uuid(user_id)

        # 1. Connected Apps (App Vault)
        apps_resp = (
            supabase.table("connected_apps")
            .select("app_name")
            .eq("user_id", valid_uuid)
            .eq("status", "active")
            .limit(25)
            .execute()
        )
        for row in apps_resp.data or []:
            name = _clean_token(row.get("app_name", ""))
            if name:
                entities.add(name)

        # 2. Vault Notes Titles
        notes_resp = (
            supabase.table("vault_notes")
            .select("title")
            .eq("user_id", valid_uuid)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        for row in notes_resp.data or []:
            title = row.get("title", "")
            # If title is of form "App — Action", extract both app and words
            if "—" in title or "-" in title:
                parts = re.split(r"[—-]", title)
                for part in parts:
                    tok = _clean_token(part)
                    if tok and len(tok.split()) <= 4:
                        entities.add(tok)
            else:
                tok = _clean_token(title)
                if tok and len(tok.split()) <= 4:
                    entities.add(tok)

        # 3. Active Agents
        agents_resp = (
            supabase.table("agents")
            .select("title")
            .eq("user_id", valid_uuid)
            .limit(15)
            .execute()
        )
        for row in agents_resp.data or []:
            tok = _clean_token(row.get("title", ""))
            if tok and len(tok.split()) <= 4:
                entities.add(tok)

        # 4. Business Knowledge Sources
        kb_resp = (
            supabase.table("business_knowledge")
            .select("source_name")
            .eq("user_id", valid_uuid)
            .limit(15)
            .execute()
        )
        for row in kb_resp.data or []:
            tok = _clean_token(row.get("source_name", ""))
            if tok and len(tok.split()) <= 4:
                entities.add(tok)

    except Exception as e:
        logger.warning(f"[ASR Context] Failed to fetch user entities: {e}")

    return entities


def get_user_context_keyterms(
    user_id: Optional[str] = None,
    extra_terms: Optional[List[str]] = None,
) -> Tuple[List[str], str, int]:
    """Compile personalized keyterms and topic for Gnani Prisma v3.0.
    
    Returns:
        tuple: (keyterms: List[str], topic: str, user_entity_count: int)
    """
    user_key = user_id or "default"
    now = time.time()

    # Check cache
    if user_key in _user_context_cache:
        timestamp, cached_terms, cached_topic, cached_count = _user_context_cache[user_key]
        if now - timestamp < _CACHE_TTL_SECONDS:
            if extra_terms:
                merged = list(dict.fromkeys(cached_terms + [t for t in extra_terms if t]))
                return merged[:120], cached_topic, cached_count
            return cached_terms, cached_topic, cached_count

    # Extract dynamic entities for this user
    user_entities: Set[str] = set()
    if user_id:
        user_entities = extract_user_entities(user_id)

    # Merge static + user entities + extras while preserving order and casing
    merged_list: List[str] = []
    seen_lower: Set[str] = set()

    # Priority 1: User-specific entities
    for term in sorted(user_entities):
        low = term.lower()
        if low not in seen_lower:
            seen_lower.add(low)
            merged_list.append(term)

    user_count = len(merged_list)

    # Priority 2: Extra terms passed by caller
    if extra_terms:
        for term in extra_terms:
            cleaned = _clean_token(term)
            if cleaned and cleaned.lower() not in seen_lower:
                seen_lower.add(cleaned.lower())
                merged_list.append(cleaned)

    # Priority 3: Platform static keywords
    for term in STATIC_AUTOMATION_KEYTERMS:
        low = term.lower()
        if low not in seen_lower:
            seen_lower.add(low)
            merged_list.append(term)

    # Cap to max 120 keyterms (Gnani Prisma allows up to 200)
    final_keyterms = merged_list[:120]

    # Formulate domain topic
    top_apps = list(user_entities)[:5]
    if top_apps:
        topic = (
            f"Automation workflows, digital tasks, and cloud apps including {', '.join(top_apps)}"
        )
    else:
        topic = "Automation workflows, cloud software tools, messaging apps, and spreadsheets"

    # Save to cache
    _user_context_cache[user_key] = (now, final_keyterms, topic, user_count)

    logger.info(
        f"[ASR Context] Dynamic keyterms compiled for user={user_id}: "
        f"{user_count} user entities, {len(final_keyterms)} total keyterms."
    )
    return final_keyterms, topic, user_count
