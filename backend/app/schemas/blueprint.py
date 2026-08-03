from pydantic import BaseModel
from typing import List, Dict, Optional, Any, Literal

class MissingParameter(BaseModel):
    step_number: int
    parameter_key: str
    label: str             # e.g., "Google Sheet Name or URL"
    description: str       # e.g., "Which Google Sheet should rows be added to?"
    suggested_type: str    # "text" | "number" | "select" | "url"

class WorkflowStep(BaseModel):
    step_number: int
    route: Literal["browser_agent", "composio_api", "http_webhook", "telegram_client", "ai_generate"]
    app: str
    action: str
    parameters: Dict[str, Any]
    # Set only when this step must run once PER ITEM of an earlier step's
    # result rather than once overall — e.g. one Google Sheets row per
    # AI-generated caption. Value is the exact placeholder referencing the
    # producing step, e.g. "{{step_1_result}}"; inside this step's own
    # parameters, {{item}} resolves to the current item on each iteration.
    for_each: Optional[str] = None

class TriggerSpec(BaseModel):
    type: Literal["schedule", "webhook", "manual"]
    details: str
    cron: Optional[str] = None
    # Populated when type == "webhook" (an event-driven "whenever X happens"
    # automation): which app's events to listen for, and an optional filter
    # (e.g. a phone number/contact) narrowing which events count as a match.
    event_app: Optional[str] = None
    event_target: Optional[str] = None

class WorkflowBlueprint(BaseModel):
    title: str
    trigger: TriggerSpec
    required_apps: List[str]
    steps: List[WorkflowStep]
    needs_human_approval: bool
    needs_clarification: bool
    clarification_question: Optional[str] = None
    missing_parameters: List[MissingParameter] = []

class PlanRequest(BaseModel):
    prompt: str
    user_id: Optional[str] = None
