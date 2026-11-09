"""Voice Assistant Intent Resolution Service.

Provides unified, multi-purpose intent understanding for VoxAgent's Voice First platform.
Determines whether an operator's spoken input is:
1. Answering a paused workflow step (e.g. 'extract full sheet', 'A1:B10', 'approve', 'yes')
2. Adding missing details to an existing workflow in Studio (e.g. 'recipient is test@gmail.com')
3. Creating a new agent workflow (e.g. 'create an agent to email project summary every morning')
4. Running an existing agent (e.g. 'run the lead tracker agent')
5. Navigating the web app (e.g. 'go to vault', 'open my agents', 'open notes')
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from app.config import settings
from app.services.disambiguation import resolve_disambiguation
from app.services.parameter_normalizer import normalize_action_parameter

logger = logging.getLogger(__name__)

# Initialize Gemini Client if available
_gemini_client = None
if settings.GEMINI_API_KEY:
    try:
        from google import genai
        _gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY)
    except Exception as e:
        logger.warning(f"[VoiceAssistant] Could not initialize Gemini client: {e}")


class VoiceAssistantContext(BaseModel):
    has_live_clarification: bool = False
    live_question: Optional[str] = None
    live_agent_id: Optional[str] = None
    live_input_type: Optional[str] = None
    live_pending_id: Optional[str] = None

    has_blueprint: bool = False
    blueprint_title: Optional[str] = None
    missing_parameters: Optional[List[Dict[str, Any]]] = None
    existing_disambig_values: Optional[Dict[str, str]] = None

    current_route: Optional[str] = None


class VoiceAssistantIntentResult(BaseModel):
    intent: str  # "resume_paused" | "update_blueprint" | "create_workflow" | "run_agent" | "navigate" | "general"
    action: Optional[str] = None  # "resume", "approve", "reject"
    answer: Optional[str] = None
    prompt: Optional[str] = None
    route: Optional[str] = None
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    resolved_values: Optional[Dict[str, str]] = None
    all_resolved: Optional[bool] = None
    spoken_acknowledgement: str
    display_title: str
    display_detail: str


LOCALIZED_PHRASES = {
    "te": {
        "no_speech": "<curious> నాకేమీ వినిపించలేదు. నేను మీకు ఎలా సహాయపడగలను? </curious>",
        "no_speech_title": "వింటోంది",
        "no_speech_detail": "స్పీచ్ గుర్తించబడలేదు",
        "dark_mode": "<happy> డార్క్ మోడ్‌కి మార్చబడింది. </happy>",
        "dark_mode_title": "డార్క్ మోడ్ ప్రారంభించబడింది",
        "dark_mode_detail": "డార్క్ థీమ్‌కి మార్చబడింది",
        "light_mode": "<happy> లైట్ మోడ్‌కి మార్చబడింది. </happy>",
        "light_mode_title": "లైట్ మోడ్ ప్రారంభించబడింది",
        "light_mode_detail": "లైట్ థీమ్‌కి మార్చబడింది",
        "who_are_you": "<happy> నేను VoxAgent, మీ స్వతంత్ర వాయిస్ అసిస్టెంట్‌ని. మీరు మాట్లాడి వర్క్‌ఫ్లోలను రూపొందించవచ్చు, ఆగిన దశలను కొనసాగించవచ్చు లేదా ఏదైనా స్క్రీన్‌ను నావిగేట్ చేయవచ్చు. </happy>",
        "who_are_you_title": "VoxAgent వాయిస్ అసిస్టెంట్",
        "who_are_you_detail": "ఇలా చెప్పి చూడండి: 'Create email agent', 'Go to vault', లేదా 'Extract full sheet'.",
        "settings": "<happy> సెట్టింగ్‌లు తెరుస్తున్నాను. </happy>",
        "settings_title": "యాప్ సెట్టింగ్‌లు తెరుస్తున్నాను",
        "settings_detail": "థీమ్, వాయిస్ పర్సొనా మరియు ప్రాధాన్యతలను అనుకూలీకరించండి",
        "studio": "<happy> ఏజెంట్ స్టూడియో తెరుస్తున్నాను. </happy>",
        "studio_title": "ఏజెంట్ స్టూడియోకి నావిగేట్ చేస్తోంది",
        "studio_detail": "వాయిస్ వర్క్‌ఫ్లోలను సృష్టించి అమలు చేయండి",
        "vault": "<happy> యాప్ వాల్ట్ తెరుస్తున్నాను. </happy>",
        "vault_title": "యాప్ వాల్ట్‌కి నావిగేట్ చేస్తోంది",
        "vault_detail": "మీ 500+ SaaS యాప్‌లు మరియు వెబ్ సెషన్‌లను నిర్వహించండి",
        "agents": "<happy> మై ఏజెంట్స్ తెరుస్తున్నాను. </happy>",
        "agents_title": "మై ఏజెంట్స్‌కి నావిగేట్ చేస్తోంది",
        "agents_detail": "యాక్టివ్ వర్క్‌ఫ్లోలను చూడండి మరియు నిర్వహించండి",
        "knowledge": "<happy> నాలెడ్జ్ బేస్ తెరుస్తున్నాను. </happy>",
        "knowledge_title": "నాలెడ్జ్ బేస్‌కి నావిగేట్ చేస్తోంది",
        "knowledge_detail": "డాక్యుమెంట్‌లు మరియు RAG కాంటెక్స్ట్‌ను నిర్వహించండి",
        "notes": "<happy> వాల్ట్ నోట్స్ తెరుస్తున్నాను. </happy>",
        "notes_title": "వాల్ట్ నోట్స్‌కి నావిగేట్ చేస్తోంది",
        "notes_detail": "ఏజెంట్ ఇంటెలిజెన్స్ మరియు నోట్స్‌ను తనిఖీ చేయండి",
        "start_agent": "<happy> {name} రన్ చేస్తున్నాను. </happy>",
        "start_agent_title": "ఏజెంట్ రన్ అవుతోంది: {name}",
        "action_rejected": "<pauses> చర్య తిరస్కరించబడింది. వర్క్‌ఫ్లో నిలిపివేయబడింది. </pauses>",
        "action_rejected_title": "చర్య తిరస్కరించబడింది",
        "action_approved": "<happy> ఆమోదించబడింది. వర్క్‌ఫ్లో అమలు కొనసాగుతోంది. </happy>",
        "action_approved_title": "చర్య ఆమోదించబడింది",
        "resuming_step": "<happy> అర్థమైంది. {answer} తో వర్క్‌ఫ్లో కొనసాగుతోంది. </happy>",
        "resuming_step_title": "ఆగిన దశను కొనసాగిస్తోంది",
        "create_workflow": "<happy> {prompt} కోసం వర్క్‌ఫ్లో రూపొందిస్తున్నాను. </happy>",
        "create_workflow_title": "కొత్త ఏజెంట్‌ని రూపొందిస్తోంది",
    },
    "hi": {
        "no_speech": "<curious> मुझे कुछ सुनाई नहीं दिया। मैं आपकी क्या मदद करूँ? </curious>",
        "no_speech_title": "सुन रहा है",
        "no_speech_detail": "कोई आवाज़ नहीं पहचानी गई",
        "dark_mode": "<happy> डार्क मोड में बदल दिया गया है। </happy>",
        "dark_mode_title": "डार्क मोड सक्षम किया गया",
        "dark_mode_detail": "डार्क थीम लागू की गई",
        "light_mode": "<happy> लाइट मोड में बदल दिया गया है। </happy>",
        "light_mode_title": "लाइट मोड सक्षम किया गया",
        "light_mode_detail": "लाइट थीम लागू की गई",
        "who_are_you": "<happy> मैं VoxAgent हूँ, आपकी वॉइस-फ़र्स्ट स्वायत्त असिस्टेंट। आप बोलकर वर्कफ़्लो बना सकते हैं, रुके हुए चरणों को जारी रख सकते हैं या किसी भी स्क्रीन पर जा सकते हैं। </happy>",
        "who_are_you_title": "VoxAgent वॉइस असिस्टेंट",
        "who_are_you_detail": "बोलकर देखें: 'Create email agent', 'Go to vault', या 'Extract full sheet'.",
        "settings": "<happy> सेटिंग्स खोली जा रही हैं। </happy>",
        "settings_title": "ऐप सेटिंग्स खोली जा रही हैं",
        "settings_detail": "थीम, आवाज़ और प्राथमिकताएं कस्टमाइज़ करें",
        "studio": "<happy> एजेंट स्टूडियो खोला जा रहा है। </happy>",
        "studio_title": "एजेंट स्टूडियो पर जा रहे हैं",
        "studio_detail": "वॉइस वर्कफ़्लो बनाएं और चलाएं",
        "vault": "<happy> ऐप वॉल्ट खोला जा रहा है। </happy>",
        "vault_title": "ऐप वॉल्ट पर जा रहे हैं",
        "vault_detail": "अपने 500+ SaaS ऐप्स और वेब सत्र प्रबंधित करें",
        "agents": "<happy> माय एजेंट्स खोले जा रहे हैं। </happy>",
        "agents_title": "माय एजेंट्स पर जा रहे हैं",
        "agents_detail": "सक्रिय वर्कफ़्लो देखें और प्रबंधित करें",
        "knowledge": "<happy> नॉलेज बेस खोला जा रहा है। </happy>",
        "knowledge_title": "नॉलेज बेस पर जा रहे हैं",
        "knowledge_detail": "दस्तावेज़ और संदर्भ प्रबंधित करें",
        "notes": "<happy> वॉल्ट नोट्स खोले जा रहे हैं। </happy>",
        "notes_title": "वॉल्ट नोट्स पर जा रहे हैं",
        "notes_detail": "एजेंट इंटेलिजेंस और नोट्स देखें",
        "start_agent": "<happy> {name} शुरू कर रहे हैं। </happy>",
        "start_agent_title": "एजेंट शुरू हो रहा है: {name}",
        "action_rejected": "<pauses> कार्रवाई अस्वीकृत। वर्कफ़्लो रोक दिया गया। </pauses>",
        "action_rejected_title": "कार्रवाई अस्वीकृत",
        "action_approved": "<happy> स्वीकृत। वर्कफ़्लो निष्पादन जारी है। </happy>",
        "action_approved_title": "कार्रवाई स्वीकृत",
        "resuming_step": "<happy> समझ गया। {answer} के साथ वर्कफ़्लो जारी है। </happy>",
        "resuming_step_title": "रुके हुए चरण को फिर से शुरू किया गया",
        "create_workflow": "<happy> {prompt} के लिए वर्कफ़्लो तैयार कर रहे हैं। </happy>",
        "create_workflow_title": "नया एजेंट तैयार कर रहे हैं",
    },
}


def _get_lang_key(lang: Optional[str]) -> str:
    if not lang:
        return "en"
    clean = lang.strip().lower()
    if clean.startswith("te"):
        return "te"
    if clean.startswith("hi"):
        return "hi"
    return "en"


def resolve_voice_intent(
    spoken_text: str,
    context: VoiceAssistantContext,
    language: str = "en",
) -> VoiceAssistantIntentResult:
    """Resolve spoken text into a rich, multi-purpose assistant intent."""
    raw = (spoken_text or "").strip()
    low = raw.lower()
    lk = _get_lang_key(language)
    lp = LOCALIZED_PHRASES.get(lk)

    if not raw:
        return VoiceAssistantIntentResult(
            intent="general",
            spoken_acknowledgement=lp["no_speech"] if lp else "<curious> I didn't hear anything. How can I help you? </curious>",
            display_title=lp["no_speech_title"] if lp else "Listening",
            display_detail=lp["no_speech_detail"] if lp else "No speech detected",
        )

    # ─────────────────────────────────────────────────────────────────
    # 1. NAVIGATION SHORTCUTS & SYSTEM ACTIONS
    # ─────────────────────────────────────────────────────────────────
    if any(p in low for p in ["dark mode", "dark theme", "enable dark mode", "switch to dark", "డార్క్", "डार्क"]):
        return VoiceAssistantIntentResult(
            intent="change_theme",
            action="dark",
            spoken_acknowledgement=lp["dark_mode"] if lp else "<happy> Switched to dark mode. </happy>",
            display_title=lp["dark_mode_title"] if lp else "Dark Mode Enabled",
            display_detail=lp["dark_mode_detail"] if lp else "Switched appearance to dark theme",
        )

    if any(p in low for p in ["light mode", "light theme", "enable light mode", "switch to light", "లైట్", "लाइट"]):
        return VoiceAssistantIntentResult(
            intent="change_theme",
            action="light",
            spoken_acknowledgement=lp["light_mode"] if lp else "<happy> Switched to light mode. </happy>",
            display_title=lp["light_mode_title"] if lp else "Light Mode Enabled",
            display_detail=lp["light_mode_detail"] if lp else "Switched appearance to light theme",
        )

    if any(p in low for p in ["what can you do", "who are you", "help me", "how to use", "voice commands"]):
        return VoiceAssistantIntentResult(
            intent="general",
            spoken_acknowledgement=lp["who_are_you"] if lp else "<happy> I am VoxAgent, your voice-first autonomous agent assistant. You can speak to create workflows, resume paused steps, manage your vault, or navigate any screen. </happy>",
            display_title=lp["who_are_you_title"] if lp else "VoxAgent Voice Assistant",
            display_detail=lp["who_are_you_detail"] if lp else "Try saying: 'Create email agent', 'Go to vault', 'Switch to dark mode', or 'Extract full sheet'.",
        )

    if any(p in low for p in ["open settings", "go to settings", "show settings", "app preferences", "change voice", "voice settings", "account settings", "సెట్టింగ్", "सेटिंग"]):
        return VoiceAssistantIntentResult(
            intent="open_settings",
            action="voice" if "voice" in low else "account" if "account" in low else "general",
            spoken_acknowledgement=lp["settings"] if lp else "<happy> Opening Settings. </happy>",
            display_title=lp["settings_title"] if lp else "Opening App Settings",
            display_detail=lp["settings_detail"] if lp else "Customize theme, voice persona, and preferences",
        )

    if any(p in low for p in ["go to studio", "open studio", "agent studio", "create workflow", "workflow creator", "స్టూడియో", "स्टूडियो"]):
        return VoiceAssistantIntentResult(
            intent="navigate",
            route="/studio",
            spoken_acknowledgement=lp["studio"] if lp else "<happy> Opening Agent Studio. </happy>",
            display_title=lp["studio_title"] if lp else "Navigating to Agent Studio",
            display_detail=lp["studio_detail"] if lp else "Create and run voice workflows",
        )

    if any(p in low for p in ["go to vault", "open vault", "show apps", "app vault", "manage apps", "connect apps", "వాల్ట్", "वॉल्ट"]):
        return VoiceAssistantIntentResult(
            intent="navigate",
            route="/vault",
            spoken_acknowledgement=lp["vault"] if lp else "<happy> Opening App Vault. </happy>",
            display_title=lp["vault_title"] if lp else "Navigating to Vault",
            display_detail=lp["vault_detail"] if lp else "Manage your 500+ SaaS apps and web sessions",
        )

    if any(p in low for p in ["go to agents", "open agents", "my agents", "show agents", "all workflows", "show my workflows"]):
        return VoiceAssistantIntentResult(
            intent="navigate",
            route="/agents",
            spoken_acknowledgement=lp["agents"] if lp else "<happy> Opening My Agents. </happy>",
            display_title=lp["agents_title"] if lp else "Navigating to My Agents",
            display_detail=lp["agents_detail"] if lp else "View and manage active workflows",
        )

    if any(p in low for p in ["go to knowledge", "open knowledge", "knowledge base", "documents", "show knowledge"]):
        return VoiceAssistantIntentResult(
            intent="navigate",
            route="/knowledge",
            spoken_acknowledgement=lp["knowledge"] if lp else "<happy> Opening Knowledge Base. </happy>",
            display_title=lp["knowledge_title"] if lp else "Navigating to Knowledge Base",
            display_detail=lp["knowledge_detail"] if lp else "Manage company documents and RAG context",
        )

    if any(p in low for p in ["go to notes", "open notes", "vault notes", "saved notes"]):
        return VoiceAssistantIntentResult(
            intent="navigate",
            route="/notes",
            spoken_acknowledgement=lp["notes"] if lp else "<happy> Opening Vault Notes. </happy>",
            display_title=lp["notes_title"] if lp else "Navigating to Vault Notes",
            display_detail=lp["notes_detail"] if lp else "Inspect agent intelligence and notes",
        )

    # ─────────────────────────────────────────────────────────────────
    # 2. RUN EXISTING AGENT
    # ─────────────────────────────────────────────────────────────────
    run_match = re.search(r"^(?:run|execute|start|launch)\s+(?:the\s+)?(.+?)(?:\s+agent|\s+workflow)?$", low)
    if run_match and not any(k in low for k in ["create", "build", "generate", "make", "new", "email", "sheet"]):
        target_name = run_match.group(1).strip()
        if target_name and len(target_name) > 2:
            return VoiceAssistantIntentResult(
                intent="run_agent",
                agent_name=target_name,
                route="/agents",
                spoken_acknowledgement=lp["start_agent"].format(name=target_name) if lp else f"<happy> Starting {target_name}. </happy>",
                display_title=lp["start_agent_title"].format(name=target_name) if lp else f"Running Agent: {target_name}",
                display_detail="Executing workflow",
            )

    # ─────────────────────────────────────────────────────────────────
    # 3. WORKFLOW PAUSED IN MIDDLE (needs_input / live_clarification)
    # ─────────────────────────────────────────────────────────────────
    if context.has_live_clarification:
        # Check for explicit approval / rejection if the pending step is confirmation
        is_approval = any(w in low for w in ["approve", "yes", "proceed", "confirm", "continue", "looks good", "allow", "go ahead", "సరే", "ఆమోదించు", "हाँ", "ठीक"])
        is_rejection = any(w in low for w in ["reject", "cancel", "stop", "abort", "don't proceed", "no", "వద్దు", "రద్దు", "नहीं", "रोकें"])

        if is_rejection:
            return VoiceAssistantIntentResult(
                intent="resume_paused",
                action="reject",
                answer="Cancelled by operator voice command",
                agent_id=context.live_agent_id,
                spoken_acknowledgement=lp["action_rejected"] if lp else "<pauses> Action rejected. Workflow stopped. </pauses>",
                display_title=lp["action_rejected_title"] if lp else "Action Rejected",
                display_detail="Halting paused workflow step",
            )

        if is_approval and context.live_input_type in ["confirmation", "approval"]:
            return VoiceAssistantIntentResult(
                intent="resume_paused",
                action="approve",
                answer="Approved",
                agent_id=context.live_agent_id,
                spoken_acknowledgement=lp["action_approved"] if lp else "<happy> Approved. Resuming workflow execution now. </happy>",
                display_title=lp["action_approved_title"] if lp else "Action Approved",
                display_detail="Resuming workflow execution",
            )

        # Otherwise, the user spoke the answer for the paused step (e.g. 'extract full sheet', 'A1:B10', 'mvsviswas@gmail.com')
        clean_answer = normalize_action_parameter(
            app="google_sheets" if "sheet" in (context.live_question or "").lower() else "",
            action="extract",
            parameter_key="range" if "row" in (context.live_question or "").lower() or "sheet" in (context.live_question or "").lower() else "input",
            raw_value=raw,
            parameter_description=context.live_question,
        )

        return VoiceAssistantIntentResult(
            intent="resume_paused",
            action="resume",
            answer=str(clean_answer),
            agent_id=context.live_agent_id,
            spoken_acknowledgement=lp["resuming_step"].format(answer=clean_answer) if lp else f"<happy> Got it. Resuming workflow with {clean_answer}. </happy>",
            display_title=lp["resuming_step_title"] if lp else "Resuming Paused Step",
            display_detail=f"Input: {clean_answer}",
        )

    # ─────────────────────────────────────────────────────────────────
    # 4. DISAMBIGUATION / ADDING MISSING DETAILS TO BLUEPRINT IN STUDIO
    # ─────────────────────────────────────────────────────────────────
    # Check if this input is intended to answer missing parameters of the current blueprint
    if context.has_blueprint and context.missing_parameters and len(context.missing_parameters) > 0:
        # Determine if the user is explicitly asking to start a brand new workflow or if they are providing details
        is_explicit_new = bool(re.search(r"^(?:create|build|generate|make|start)\s+(?:a\s+)?(?:new\s+)?(?:agent|workflow)", low))
        
        if not is_explicit_new:
            # Check if input answers one of the missing parameters
            disambig_res = resolve_disambiguation(
                clarification_question=None,
                missing_parameters=context.missing_parameters,
                spoken_answer=raw,
                existing_values=context.existing_disambig_values or {},
            )

            if disambig_res.get("success") and disambig_res.get("is_valid"):
                resolved = disambig_res.get("resolved_values", {})
                if resolved:
                    # Found at least one matching parameter!
                    sample_param = next(iter(resolved.values()), raw)
                    ack = disambig_res.get("spoken_acknowledgement") or f"<happy> Got it, updated details with {sample_param}. </happy>"
                    return VoiceAssistantIntentResult(
                        intent="update_blueprint",
                        resolved_values=resolved,
                        all_resolved=disambig_res.get("all_resolved", False),
                        spoken_acknowledgement=ack,
                        display_title="Updated Workflow Details",
                        display_detail=", ".join(f"{k.split('::')[-1]}: {v}" for k, v in resolved.items()),
                    )

    # ─────────────────────────────────────────────────────────────────
    # 5. CREATE A NEW AGENT WORKFLOW (DEFAULT GENERATIVE ACTION)
    # ─────────────────────────────────────────────────────────────────
    # Clean the prompt of meta voice preambles
    clean_prompt = re.sub(
        r"^(?:hey\s+voxagent|voxagent|can\s+you\s+(?:please\s+)?|please\s+|create\s+(?:an?\s+)?agent\s+(?:to\s+|that\s+)?|build\s+(?:an?\s+)?agent\s+(?:to\s+|that\s+)?|generate\s+(?:an?\s+)?agent\s+(?:to\s+|that\s+)?|make\s+(?:an?\s+)?agent\s+(?:to\s+|that\s+)?|i\s+want\s+(?:to\s+)?(?:create\s+)?(?:an?\s+)?agent\s+(?:to\s+|that\s+)?)",
        "",
        raw,
        flags=re.I,
    ).strip()

    if not clean_prompt:
        clean_prompt = raw

    return VoiceAssistantIntentResult(
        intent="create_workflow",
        prompt=clean_prompt,
        route="/studio",
        spoken_acknowledgement=lp["create_workflow"].format(prompt=clean_prompt[:60]) if lp else f"<happy> Creating workflow for: {clean_prompt[:60]}. </happy>",
        display_title=lp["create_workflow_title"] if lp else "Creating New Agent",
        display_detail=clean_prompt,
    )

