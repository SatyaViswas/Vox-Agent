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


class KnowledgeTestQueryRequest(BaseModel):
    query: str
    language: Optional[str] = "en"


class KnowledgeTestQueryResponse(BaseModel):
    query: str
    answer: str
    grounded: bool
    sources: List[str] = []
    confidence: float = 0.0
    snippets: List[str] = []


class PillarUpdateRequest(BaseModel):
    pillar_key: str  # "profile", "pricing", "policies", "faq"
    title: str
    content: str


class StressTestScenario(BaseModel):
    id: int
    category: str
    scenario_title: str
    customer_query: str
    expected_behavior: str
    agent_answer: str
    verdict: str  # "passed" | "warning" | "failed"
    explanation: str
    grounded: bool = True
    sources: List[str] = []
    confidence: float = 0.0


class KnowledgeStressTestRequest(BaseModel):
    count: Optional[int] = 8
    category_filter: Optional[str] = None
    language_mix: Optional[str] = "indic-multilingual"


class KnowledgeStressTestResponse(BaseModel):
    timestamp: str
    reliability_score: float
    readiness_status: str  # "DEPLOYMENT_READY" | "ACCEPTABLE" | "NEEDS_REVIEW"
    summary: str
    total_scenarios: int
    passed_count: int
    warning_count: int
    failed_count: int
    category_breakdown: dict = {}
    scenarios: List[StressTestScenario] = []
    adaption_model: str = "qwen3.8-27b"
    powered_by: str = "Adaption Labs"
