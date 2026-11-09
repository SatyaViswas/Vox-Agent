import json
import re
from typing import Optional, List, Dict, Any
import numpy as np
from app.database import supabase
from app.services.knowledge_ingestion import get_embedding

_CHUNK_PREFIX_RE = re.compile(r"^\[CHUNK:(\d+)/(\d+)\]\n")

def _clean_chunk_content(text: str) -> str:
    """Strips internal chunk header tag so prompt receives clean business text."""
    if not text:
        return ""
    m = _CHUNK_PREFIX_RE.match(text)
    return text[m.end():] if m else text

def check_semantic_cache(user_id: str, task_intent: str, threshold: float = 0.95) -> Optional[str]:
    """
    Checks if a highly similar task was already executed.
    Returns the cached LLM output if found, otherwise None.
    """
    if not supabase:
        return None
        
    try:
        query_embedding = get_embedding(task_intent)
        
        # Call the Supabase RPC function we defined in SQL
        response = supabase.rpc(
            "match_semantic_cache", 
            {
                "query_embedding": query_embedding,
                "match_user_id": user_id,
                "match_threshold": threshold
            }
        ).execute()
        
        data = response.data
        if data and len(data) > 0:
            return data[0].get("llm_output")
            
        return None
    except Exception as e:
        print(f"Error checking semantic cache: {str(e)}")
        return None

def _retrieve_scoped_context(user_id: str, query_embedding: list, source_names: list, threshold: float, limit: int) -> str:
    """Same ranking as `match_business_knowledge`, but restricted to specific
    `source_name`s. The RPC has no source_name filter (and doesn't return
    source_name in its results either, so its output can't be filtered
    after the fact) — a user's knowledge hub is one shared pool per
    account, so without this, an automation dedicated to one business can
    surface an unrelated business's content that happens to embed closer to
    a given message. Ranks in Python instead, over just the allowed rows."""
    detailed = retrieve_business_context_detailed(user_id, query_embedding=query_embedding, threshold=threshold, limit=limit, source_names=source_names)
    if not detailed:
        return ""
    context_chunks = [
        f"[{item.get('source_name', 'Business Knowledge')}]\n{item.get('content', '')}"
        if item.get("source_name")
        else item.get("content", "")
        for item in detailed
    ]
    return "\n\n---\n\n".join(context_chunks)


def retrieve_business_context_detailed(
    user_id: str,
    task_intent: str = "",
    query_embedding: Optional[list] = None,
    threshold: float = 0.45,
    limit: int = 5,
    source_names: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Retrieves ranked matching knowledge chunks with metadata (source_name, similarity, content)."""
    if not supabase:
        return []

    import json
    import numpy as np

    try:
        if query_embedding is None:
            if not task_intent:
                return []
            query_embedding = get_embedding(task_intent)

        # 1. Fetch relevant rows from Supabase
        query = supabase.table("business_knowledge").select("id, content, embedding, source_name").eq("user_id", user_id)
        if source_names:
            query = query.in_("source_name", source_names)
        
        response = query.execute()
        rows = response.data or []
        if not rows:
            return []

        query_vec = np.array(query_embedding, dtype=float)
        query_norm = np.linalg.norm(query_vec) or 1.0

        scored = []
        for row in rows:
            embedding = row.get("embedding")
            content = row.get("content")
            if not embedding or not content:
                continue
            if isinstance(embedding, str):
                try:
                    embedding = json.loads(embedding)
                except Exception:
                    continue
            vec = np.array(embedding, dtype=float)
            denom = (np.linalg.norm(vec) * query_norm) or 1.0
            similarity = float(np.dot(query_vec, vec) / denom)
            if similarity >= threshold:
                clean_content = _clean_chunk_content(content)
                scored.append({
                    "id": row.get("id"),
                    "source_name": row.get("source_name", "Business Knowledge"),
                    "content": clean_content,
                    "similarity": round(similarity, 4),
                })

        scored.sort(key=lambda x: x["similarity"], reverse=True)
        return scored[:limit]
    except Exception as e:
        print(f"Error in retrieve_business_context_detailed: {e}")
        return []


def retrieve_business_context(
    user_id: str, task_intent: str, threshold: float = 0.5, limit: int = 5, source_names: Optional[List[str]] = None
) -> str:
    """
    Retrieves relevant business knowledge chunks based on the task intent.

    `source_names`, when given, restricts the search to only those knowledge
    sources — see `_retrieve_scoped_context`.
    """
    if not supabase:
        return ""

    detailed = retrieve_business_context_detailed(
        user_id=user_id,
        task_intent=task_intent,
        threshold=threshold,
        limit=limit,
        source_names=source_names,
    )
    if not detailed:
        return ""

    context_chunks = [
        f"[{item.get('source_name', 'Business Knowledge')}]\n{item.get('content', '')}"
        if item.get("source_name")
        else item.get("content", "")
        for item in detailed
    ]
    return "\n\n---\n\n".join(context_chunks)

def save_to_semantic_cache(user_id: str, task_intent: str, llm_output: str) -> bool:
    """
    Saves a task intent and its corresponding LLM output to the cache.
    """
    if not supabase:
        return False
        
    try:
        intent_embedding = get_embedding(task_intent)
        
        data = {
            "user_id": user_id,
            "task_intent": task_intent,
            "intent_embedding": intent_embedding,
            "llm_output": llm_output
        }
        
        supabase.table("semantic_cache").insert(data).execute()
        return True
    except Exception as e:
        print(f"Error saving to semantic cache: {str(e)}")
        return False
