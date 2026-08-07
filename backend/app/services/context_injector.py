from typing import Optional, List, Dict, Any
from app.database import supabase
from app.services.knowledge_ingestion import get_embedding

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
    import json
    import numpy as np

    response = (
        supabase.table("business_knowledge")
        .select("content, embedding")
        .eq("user_id", user_id)
        .in_("source_name", source_names)
        .execute()
    )
    rows = response.data or []
    if not rows:
        return ""

    query_vec = np.array(query_embedding, dtype=float)
    query_norm = np.linalg.norm(query_vec) or 1.0

    scored = []
    for row in rows:
        embedding = row.get("embedding")
        content = row.get("content")
        if not embedding or not content:
            continue
        # PostgREST serializes a pgvector column as a JSON-array-shaped
        # string (e.g. "[-0.017,0.020,...]"), not a native list.
        if isinstance(embedding, str):
            embedding = json.loads(embedding)
        vec = np.array(embedding, dtype=float)
        denom = (np.linalg.norm(vec) * query_norm) or 1.0
        similarity = float(np.dot(query_vec, vec) / denom)
        if similarity >= threshold:
            scored.append((similarity, content))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    context_chunks = [content for _similarity, content in scored[:limit]]
    return "\n\n---\n\n".join(context_chunks)


def retrieve_business_context(
    user_id: str, task_intent: str, threshold: float = 0.7, limit: int = 5, source_names: Optional[List[str]] = None
) -> str:
    """
    Retrieves relevant business knowledge chunks based on the task intent.

    `source_names`, when given, restricts the search to only those knowledge
    sources — see `_retrieve_scoped_context`. Omit it to search the user's
    entire knowledge hub via the pgvector RPC (the original, unscoped path).
    """
    if not supabase:
        return ""

    try:
        query_embedding = get_embedding(task_intent)

        if source_names:
            return _retrieve_scoped_context(user_id, query_embedding, source_names, threshold, limit)

        # Call the Supabase RPC function
        response = supabase.rpc(
            "match_business_knowledge",
            {
                "query_embedding": query_embedding,
                "match_user_id": user_id,
                "match_threshold": threshold,
                "match_count": limit
            }
        ).execute()

        data = response.data
        if not data:
            return ""

        # Combine the retrieved chunks into a single context string
        context_chunks = [item.get("content") for item in data if item.get("content")]
        return "\n\n---\n\n".join(context_chunks)

    except Exception as e:
        print(f"Error retrieving business context: {str(e)}")
        return ""

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
