from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.translator import translate_to_english

router = APIRouter(prefix="/translate", tags=["translate"])


class TranslateRequest(BaseModel):
    text: str
    source_lang: str = "auto"


class TranslateResponse(BaseModel):
    translated_text: str


@router.post("", response_model=TranslateResponse)
def translate(request: TranslateRequest):
    try:
        translated = translate_to_english(request.text, request.source_lang)
        return TranslateResponse(translated_text=translated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
