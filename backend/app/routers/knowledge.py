from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Header
from typing import List, Optional
from app.schemas.knowledge import KnowledgeUploadResponse, KnowledgeBaseItem
from app.services.knowledge_ingestion import (
    process_and_store_knowledge,
    extract_text_from_pdf,
    extract_text_from_csv,
    extract_text_from_url
)
from app.database import supabase
import uuid

router = APIRouter(prefix="/knowledge", tags=["Knowledge Base"])

GUEST_USER_ID = "00000000-0000-0000-0000-000000000000"

def get_user_id(x_user_id: Optional[str] = Header(None)) -> str:
    return x_user_id or GUEST_USER_ID

@router.post("/ingest", response_model=KnowledgeUploadResponse)
async def ingest_knowledge(
    text: Optional[str] = Form(None),
    url: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    custom_name: Optional[str] = Form(None),
    x_user_id: Optional[str] = Header(None),
):
    user_id = get_user_id(x_user_id)
    """
    Universal ingest endpoint. Accepts text, url, or file.
    """
    if not any([text, url, file]):
        raise HTTPException(status_code=400, detail="Must provide text, url, or file")
        
    content = ""
    source_type = ""
    source_name = ""
    
    try:
        if file:
            # Check file size (10MB limit)
            file_bytes = await file.read()
            if len(file_bytes) > 10 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="File too large. Max 10MB.")
                
            source_name = custom_name.strip() if custom_name else file.filename
            source_type = "file"
            
            if file.filename.endswith(".pdf"):
                content = extract_text_from_pdf(file_bytes)
            elif file.filename.endswith(".csv"):
                content = extract_text_from_csv(file_bytes)
            elif file.filename.endswith(".txt"):
                content = file_bytes.decode("utf-8")
            else:
                raise HTTPException(status_code=400, detail="Unsupported file format")
                
        elif url:
            source_name = custom_name.strip() if custom_name else url
            source_type = "url"
            content = extract_text_from_url(url)
            
        elif text:
            source_name = custom_name.strip() if custom_name else f"Text Snippet {uuid.uuid4().hex[:6]}"
            source_type = "text"
            content = text
            
        if not content.strip():
            raise HTTPException(status_code=400, detail="Extracted content is empty")
            
        # Process, embed and store
        chunks_inserted = process_and_store_knowledge(
            user_id=user_id,
            source_type=source_type,
            source_name=source_name,
            content=content
        )
        
        return KnowledgeUploadResponse(
            message="Knowledge ingested successfully",
            sources_added=chunks_inserted,
            cache_invalidated=True
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to ingest knowledge: {str(e)}")


@router.get("/", response_model=List[KnowledgeBaseItem])
async def get_knowledge_sources(x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    """
    List all active knowledge sources for the user.
    Groups by source_name to avoid listing every single chunk.
    """
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
        
    # We select DISTINCT ON (source_name) to get one entry per source
    response = supabase.table("business_knowledge") \
        .select("id, user_id, source_type, source_name, content, created_at") \
        .eq("user_id", user_id) \
        .execute()
        
    # Grouping logic (since supabase python client doesn't directly support DISTINCT ON)
    unique_sources = {}
    for item in response.data:
        if item["source_name"] not in unique_sources:
            unique_sources[item["source_name"]] = item
            
    return list(unique_sources.values())


@router.delete("/{source_name}")
async def delete_knowledge_source(source_name: str, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    """
    Delete a knowledge source and invalidate the cache.
    """
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
        
    # Delete from knowledge base
    supabase.table("business_knowledge") \
        .delete() \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .execute()
        
    # Invalidate semantic cache
    supabase.table("semantic_cache").delete().eq("user_id", user_id).execute()
    
    return {"message": f"Deleted source '{source_name}' and invalidated cache."}

from pydantic import BaseModel

class RenameRequest(BaseModel):
    new_name: str

class UpdateRequest(BaseModel):
    content: str

@router.get("/{source_name}", response_model=dict)
async def get_knowledge_source_content(source_name: str, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
    
    response = supabase.table("business_knowledge") \
        .select("id, content") \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .order("id") \
        .execute()
        
    chunks = [item["content"] for item in response.data]
    if not chunks:
        raise HTTPException(status_code=404, detail="Source not found")
        
    if len(chunks) == 1:
        full_text = chunks[0]
    else:
        # Reconstruct from chunks with overlap 200
        overlap = 200
        full_text = ""
        for i in range(len(chunks) - 1):
            chunk = chunks[i]
            if len(chunk) > overlap:
                full_text += chunk[:-overlap]
            else:
                full_text += chunk
        full_text += chunks[-1]
        
    return {"source_name": source_name, "content": full_text}

@router.patch("/{source_name}/rename")
async def rename_knowledge_source(source_name: str, request: RenameRequest, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
        
    supabase.table("business_knowledge") \
        .update({"source_name": request.new_name.strip()}) \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .execute()
        
    supabase.table("semantic_cache").delete().eq("user_id", user_id).execute()
    return {"message": "Renamed successfully"}

@router.put("/{source_name}")
async def update_knowledge_source(source_name: str, request: UpdateRequest, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
        
    # Get the original source type from one of the chunks
    response = supabase.table("business_knowledge") \
        .select("source_type") \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .limit(1) \
        .execute()
        
    if not response.data:
        raise HTTPException(status_code=404, detail="Source not found")
        
    source_type = response.data[0]["source_type"]
    
    # Delete old chunks
    supabase.table("business_knowledge") \
        .delete() \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .execute()
        
    # Re-ingest
    process_and_store_knowledge(
        user_id=user_id,
        source_type=source_type,
        source_name=source_name,
        content=request.content
    )
    
    return {"message": "Content updated successfully"}
