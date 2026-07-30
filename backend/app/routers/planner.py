from fastapi import APIRouter, UploadFile, File, HTTPException
from app.schemas.blueprint import PlanRequest, WorkflowBlueprint
from app.services.planner import generate_blueprint
from app.services.transcriber import transcribe_audio

router = APIRouter(tags=["planner"])

@router.post("/plan", response_model=WorkflowBlueprint)
def plan_workflow(request: PlanRequest):
    try:
        blueprint = generate_blueprint(request.prompt)
        return blueprint
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        transcript = transcribe_audio(file_bytes, file.filename or "audio.webm")
        return {"transcript": transcript}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/voice-plan", response_model=WorkflowBlueprint)
async def voice_plan(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        transcript = transcribe_audio(file_bytes, file.filename or "audio.webm")
        
        # Now use the transcript to generate a blueprint
        blueprint = generate_blueprint(transcript)
        return blueprint
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
