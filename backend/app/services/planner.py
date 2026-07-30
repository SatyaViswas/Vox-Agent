import os
import json
from google import genai
from google.genai import types
from app.config import settings
from app.schemas.blueprint import WorkflowBlueprint

# Initialize Gemini Client using google-genai
client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

def get_system_prompt() -> str:
    schema_json = json.dumps(WorkflowBlueprint.model_json_schema(), indent=2)
    return f"""
You are VoxAgent AI, an expert automation workflow planner. 
Your task is to parse the user's natural language request into a strict structured JSON workflow blueprint.

Rules for route classification:
- 'browser_agent': For websites/portals without public APIs (e.g., college ERPs, WhatsApp Web, Canva, Instagram).
- 'composio_api': For standard SaaS apps with public APIs (e.g., Google Workspace, Notion, Slack, GitHub, Trello).
- 'http_webhook': For custom URLs, REST endpoints, or triggering other external software.

If the user's prompt is too ambiguous, unsafe, or lacks enough information to build a reliable workflow, set `needs_clarification` to true and provide a helpful `clarification_question`.

Output exactly in the following JSON schema format:
{schema_json}
"""

def generate_blueprint(prompt: str) -> WorkflowBlueprint:
    if not client:
        raise ValueError("GEMINI_API_KEY is not configured.")

    response = client.models.generate_content(
        model='gemini-3.1-flash-lite',
        contents=[
            types.Content(role="user", parts=[types.Part.from_text(text=prompt)])
        ],
        config=types.GenerateContentConfig(
            system_instruction=get_system_prompt(),
            response_mime_type="application/json",
            temperature=0.1,
        )
    )
    
    raw_text = response.text.strip()
    
    # Clean up markdown code blocks if present
    if raw_text.startswith("```json"):
        raw_text = raw_text[len("```json"):].strip()
    elif raw_text.startswith("```"):
        raw_text = raw_text[len("```"):].strip()
        
    if raw_text.endswith("```"):
        raw_text = raw_text[:-len("```")].strip()
        
    try:
        return WorkflowBlueprint.model_validate_json(raw_text)
    except Exception as e:
        raise ValueError(f"Failed to parse Gemini response into WorkflowBlueprint. Error: {e}. Raw response: {raw_text}")
