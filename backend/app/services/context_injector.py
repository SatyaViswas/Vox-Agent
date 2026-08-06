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

def retrieve_business_context(user_id: str, task_intent: str, threshold: float = 0.7, limit: int = 5) -> str:
    """
    Retrieves relevant business knowledge chunks based on the task intent.
    """
    if not supabase:
        return ""
        
    try:
        query_embedding = get_embedding(task_intent)
        
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
