from google import genai
from google.genai import types
from app.config import settings

# Deliberately its own Gemini client, separate from planner.py's — this
# service only ever translates short command-style text before it reaches
# the planner; it must stay decoupled from blueprint-generation logic.
client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

_SYSTEM_PROMPT = """You are a precise translator embedded in an AI automation assistant.
The text you receive is a spoken or typed command a user gave, describing an automation task they
want performed (e.g. "har subah 9 baje mujhe Gmail se ek email bhejo").

First, detect the actual language of the text yourself — never assume it matches any language name
mentioned below, which is only an unverified hint about what a UI dropdown was set to and may be
wrong (the user may have typed or spoken in a different language than they had selected).

Then:
- If the text is already in English, output it back UNCHANGED — do not paraphrase, "clean up"
  grammar, or rewrite it. Passing it through exactly preserves the user's precise wording.
- Otherwise, translate it into clear, natural English, following these rules:
  - Preserve app names, product names, and proper nouns exactly as given (e.g. "Gmail", "Slack",
    "Airtable", people's names) — do not translate or alter them.
  - Preserve numbers, times, dates, phone numbers, email addresses, and URLs exactly as given.
  - Keep the instruction's meaning and intent fully intact — this translation will be used to plan
    and execute the automation, so accuracy matters more than elegance.
- Output ONLY the resulting English text. No quotes, no commentary, no explanation, no markdown.
"""


def translate_to_english(text: str, source_lang: str = "auto") -> str:
    if not client:
        raise ValueError("GEMINI_API_KEY is not configured.")

    if not text or not text.strip():
        return ""

    lang_hint = (
        f" A UI dropdown suggested the source language might be: {source_lang} — treat this as an"
        f" unverified hint only, not a fact; detect the real language from the text itself."
        if source_lang and source_lang != "auto"
        else ""
    )

    response = client.models.generate_content(
        model="gemini-3.1-flash-lite",
        contents=[
            types.Content(role="user", parts=[types.Part.from_text(text=text.strip())])
        ],
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT + lang_hint,
            temperature=0.0,
        ),
    )

    return (response.text or "").strip()
