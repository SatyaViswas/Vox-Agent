from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Header
from typing import List, Optional
from app.schemas.knowledge import (
    KnowledgeUploadResponse,
    KnowledgeBaseItem,
    KnowledgeTestQueryRequest,
    KnowledgeTestQueryResponse,
    PillarUpdateRequest,
)
from app.services.knowledge_ingestion import (
    process_and_store_knowledge,
    extract_text_from_pdf,
    extract_text_from_csv,
    extract_text_from_url,
    extract_text_from_audio,
)
from app.services.context_injector import retrieve_business_context_detailed
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
            
            AUDIO_EXTS = (".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac")
            lower_name = file.filename.lower()
            if lower_name.endswith(".pdf"):
                content = extract_text_from_pdf(file_bytes)
            elif lower_name.endswith(".csv"):
                content = extract_text_from_csv(file_bytes)
            elif lower_name.endswith(".txt"):
                content = file_bytes.decode("utf-8")
            elif lower_name.endswith(AUDIO_EXTS):
                source_type = "file"
                content = extract_text_from_audio(file_bytes, file.filename)
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Unsupported file format. Supported: .pdf, .csv, .txt, .wav, .mp3, .m4a, .ogg, .flac, .aac",
                )
                
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

import re

CHUNK_PREFIX_RE = re.compile(r"^\[CHUNK:(\d+)/(\d+)\]\n")

def parse_chunk_content(content: str) -> tuple[Optional[int], Optional[int], str]:
    """Extracts (chunk_index, total_chunks, raw_content) if tagged."""
    m = CHUNK_PREFIX_RE.match(content)
    if m:
        return int(m.group(1)), int(m.group(2)), content[m.end():]
    return None, None, content

def reconstruct_source_text(raw_chunks_data: list, overlap: int = 200) -> str:
    """Reassembles original full text from stored knowledge chunks with zero data loss."""
    if not raw_chunks_data:
        return ""
    
    parsed = [parse_chunk_content(item.get("content", "")) for item in raw_chunks_data]
    has_chunk_tags = all(p[0] is not None for p in parsed)
    
    if has_chunk_tags:
        # Sort strictly by numerical chunk index
        parsed.sort(key=lambda x: x[0])
        chunks = [p[2] for p in parsed]
    else:
        # Backward compatibility for legacy chunks: sort by created_at then id
        sorted_rows = sorted(
            raw_chunks_data, 
            key=lambda x: (x.get("created_at") or "", x.get("id") or "")
        )
        chunks = [item.get("content", "") for item in sorted_rows]
        
    if len(chunks) == 1:
        return chunks[0]
        
    full_text = ""
    for i in range(len(chunks) - 1):
        chunk = chunks[i]
        next_chunk = chunks[i + 1]
        
        # Determine actual character overlap between end of current chunk and start of next chunk
        max_possible = min(len(chunk), len(next_chunk), overlap + 80)
        actual_overlap = 0
        for length in range(max_possible, 0, -1):
            if chunk.endswith(next_chunk[:length]):
                actual_overlap = length
                break
                
        if actual_overlap > 0:
            full_text += chunk[:-actual_overlap]
        elif len(chunk) > overlap:
            full_text += chunk[:-overlap]
        else:
            full_text += chunk
            
    full_text += chunks[-1]
    return full_text

class UpdateRequest(BaseModel):
    content: str

@router.get("/{source_name}", response_model=dict)
async def get_knowledge_source_content(source_name: str, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not initialized")
    
    response = supabase.table("business_knowledge") \
        .select("id, content, created_at") \
        .eq("user_id", user_id) \
        .eq("source_name", source_name) \
        .execute()
        
    if not response.data:
        raise HTTPException(status_code=404, detail="Source not found")
        
    full_text = reconstruct_source_text(response.data, overlap=200)
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


@router.post("/test-query", response_model=KnowledgeTestQueryResponse)
async def test_knowledge_query(request: KnowledgeTestQueryRequest, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    query_str = (request.query or "").strip()
    if not query_str:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    detailed_chunks = retrieve_business_context_detailed(
        user_id=user_id,
        task_intent=query_str,
        threshold=0.45,
        limit=4,
    )

    if not detailed_chunks:
        return KnowledgeTestQueryResponse(
            query=query_str,
            answer="No matching business policy or information found in your knowledge base. Add your rules under 'Policies & SOPs' or 'Customer FAQs' so your agent can answer this accurately.",
            grounded=False,
            sources=[],
            confidence=0.0,
            snippets=[],
        )

    sources = list(dict.fromkeys(item.get("source_name", "Business Knowledge") for item in detailed_chunks))
    snippets = [item.get("content", "") for item in detailed_chunks]
    top_confidence = detailed_chunks[0].get("similarity", 0.0)

    context_text = "\n\n---\n\n".join(
        f"[{item.get('source_name', 'Business Knowledge')}]\n{item.get('content', '')}"
        for item in detailed_chunks
    )

    try:
        from google import genai
        from app.config import settings
        gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None
        
        prompt = f"""You are VoxAgent's Business AI Assistant answering a customer question on behalf of the business owner.
Answer the customer's question politely, clearly, and concisely (under 60 words).
You MUST base your answer strictly on the provided business knowledge below. If the knowledge does not provide sufficient detail, state what the business policy is and offer to connect them with the owner. Do not hallucinate unauthorized discounts, promises, or terms.
Language: Respond in {request.language or 'en'}.

--- BUSINESS KNOWLEDGE ---
{context_text}
--- END BUSINESS KNOWLEDGE ---

Customer Question:
"{query_str}"
"""
        answer_text = None
        for m_name in [
            "gemini-3.1-flash-lite",
            "gemini-3.1-flash-lite-preview",
            "gemini-3-flash-preview",
            "gemini-3.5-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
        ]:
            try:
                response = gemini_client.models.generate_content(
                    model=m_name,
                    contents=prompt,
                )
                answer_text = response.text.strip()
                break
            except Exception:
                continue
        if not answer_text:
            raise RuntimeError("All Gemini models failed for knowledge test query")
    except Exception as e:
        answer_text = f"Based on your {sources[0]}: {snippets[0][:200]}..."

    return KnowledgeTestQueryResponse(
        query=query_str,
        answer=answer_text,
        grounded=True,
        sources=sources,
        confidence=top_confidence,
        snippets=snippets,
    )


@router.post("/pillar", response_model=KnowledgeUploadResponse)
async def update_business_pillar(request: PillarUpdateRequest, x_user_id: Optional[str] = Header(None)):
    user_id = get_user_id(x_user_id)
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Pillar content cannot be empty.")

    # 1. Purge previous chunks for this pillar title to keep knowledge clean & current
    if supabase:
        supabase.table("business_knowledge").delete().eq("user_id", user_id).eq("source_name", request.title.strip()).execute()

    # 2. Ingest and embed the new structured pillar content
    chunks_inserted = process_and_store_knowledge(
        user_id=user_id,
        source_type="text",
        source_name=request.title.strip(),
        content=request.content.strip()
    )

    return KnowledgeUploadResponse(
        message=f"Pillar '{request.title}' saved successfully.",
        sources_added=chunks_inserted,
        cache_invalidated=True,
    )
