from pydantic import BaseModel, HttpUrl
from typing import Optional, List
from datetime import datetime

class KnowledgeBaseItem(BaseModel):
    id: str
    user_id: str
    source_type: str
    source_name: str
    content: str
    created_at: datetime

    class Config:
        from_attributes = True

class KnowledgeUploadResponse(BaseModel):
    message: str
    sources_added: int
    cache_invalidated: bool

class URLUploadRequest(BaseModel):
    url: HttpUrl
    
class TextUploadRequest(BaseModel):
    text: str
