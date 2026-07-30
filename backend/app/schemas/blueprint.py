from pydantic import BaseModel
from typing import List, Dict, Optional, Any, Literal

class WorkflowStep(BaseModel):
    step_number: int
    route: Literal["browser_agent", "composio_api", "http_webhook"]
    app: str
    action: str
    parameters: Dict[str, Any]

class TriggerSpec(BaseModel):
    type: Literal["schedule", "webhook", "manual"]
    details: str
    cron: Optional[str] = None

class WorkflowBlueprint(BaseModel):
    title: str
    trigger: TriggerSpec
    required_apps: List[str]
    steps: List[WorkflowStep]
    needs_human_approval: bool
    needs_clarification: bool
    clarification_question: Optional[str] = None

class PlanRequest(BaseModel):
    prompt: str
    user_id: Optional[str] = None
