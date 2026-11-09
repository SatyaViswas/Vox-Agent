from typing import Any, Dict, List, Optional
from fastapi import APIRouter, UploadFile, File, Form, Header, HTTPException
from pydantic import BaseModel
from app.schemas.blueprint import PlanRequest, WorkflowBlueprint
from app.services.planner import generate_blueprint
from app.services.composio_engine import enrich_blueprint_with_connected_resources
from app.services.transcriber import transcribe_audio, transcribe_audio_detailed
from app.services.disambiguation import resolve_disambiguation
from app.services.voice_assistant import (
    VoiceAssistantContext,
    VoiceAssistantIntentResult,
    resolve_voice_intent,
)

router = APIRouter(tags=["planner"])


class DisambiguationResolveRequest(BaseModel):
    clarification_question: Optional[str] = None
    missing_parameters: List[Dict[str, Any]]
    spoken_answer: str
    existing_values: Optional[Dict[str, str]] = None


class DisambiguationResolveResponse(BaseModel):
    success: bool
    resolved_values: Dict[str, str]
    all_resolved: bool
    spoken_acknowledgement: str

@router.post("/plan", response_model=WorkflowBlueprint)
async def plan_workflow(request: PlanRequest):
    try:
        blueprint = generate_blueprint(request.prompt, current_blueprint=request.current_blueprint)
        user_id = request.user_id or "00000000-0000-0000-0000-000000000000"
        bp_dict = blueprint.model_dump()
        enriched_dict = await enrich_blueprint_with_connected_resources(bp_dict, user_id=user_id)
        return WorkflowBlueprint(**enriched_dict)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    x_user_id: Optional[str] = Header(None),
    language_code: Optional[str] = Form("indic-auto"),
    format_style: Optional[str] = Form("codemix"),
):
    try:
        file_bytes = await file.read()
        res = transcribe_audio_detailed(
            file_bytes=file_bytes,
            filename=file.filename or "audio.webm",
            language_code=language_code or "indic-auto",
            format_style=format_style or "codemix",
            user_id=x_user_id,
        )
        return {
            "transcript": res.get("transcript", ""),
            "detected_language_code": res.get("detected_language_code"),
            "model": res.get("model"),
            "processing_time": res.get("processing_time"),
            "user_entities_boosted": res.get("user_entities_boosted", 0),
            "keyterms_applied": res.get("keyterms_applied", []),
            "topic": res.get("topic"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/voice-plan", response_model=WorkflowBlueprint)
async def voice_plan(
    file: UploadFile = File(...),
    x_user_id: Optional[str] = Header(None),
):
    try:
        file_bytes = await file.read()
        transcript = transcribe_audio(
            file_bytes=file_bytes,
            filename=file.filename or "audio.webm",
            user_id=x_user_id,
        )
        
        # Now use the transcript to generate a blueprint
        blueprint = generate_blueprint(transcript)
        user_id = x_user_id or "00000000-0000-0000-0000-000000000000"
        bp_dict = blueprint.model_dump()
        enriched_dict = await enrich_blueprint_with_connected_resources(bp_dict, user_id=user_id)
        return WorkflowBlueprint(**enriched_dict)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/disambiguate/resolve", response_model=DisambiguationResolveResponse)
def resolve_disambig(request: DisambiguationResolveRequest):
    try:
        result = resolve_disambiguation(
            clarification_question=request.clarification_question,
            missing_parameters=request.missing_parameters,
            spoken_answer=request.spoken_answer,
            existing_values=request.existing_values,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class VoiceAssistantIntentRequest(BaseModel):
    spoken_text: str
    context: Optional[VoiceAssistantContext] = None
    language: Optional[str] = "en"


@router.post("/voice-assistant/intent", response_model=VoiceAssistantIntentResult)
def voice_assistant_intent(request: VoiceAssistantIntentRequest):
    try:
        ctx = request.context or VoiceAssistantContext()
        return resolve_voice_intent(request.spoken_text, ctx, language=request.language or "en")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

