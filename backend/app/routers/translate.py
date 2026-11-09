from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.services.translator import translate_text

router = APIRouter(prefix="/translate", tags=["translate"])


class TranslateRequest(BaseModel):
    text: str
    source_lang: Optional[str] = "auto"
    target_lang: Optional[str] = "en"


class TranslateResponse(BaseModel):
    translated_text: str


@router.post("", response_model=TranslateResponse)
def translate(request: TranslateRequest):
    try:
        translated = translate_text(
            text=request.text,
            target_lang=request.target_lang or "en",
            source_lang=request.source_lang or "auto",
        )
        return TranslateResponse(translated_text=translated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
