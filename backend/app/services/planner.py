import os
import json
from typing import Optional, Dict, Any, List
from google import genai
from google.genai import types
from app.config import settings
from app.schemas.blueprint import WorkflowBlueprint

# Initialize Gemini Client using google-genai
client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

FALLBACK_GEMINI_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
]


def _generate_content_with_fallback(
    contents,
    system_instruction: str = None,
    response_mime_type: str = None,
    temperature: float = 0.1,
):
    """Call Gemini with multi-model fallback to protect against 503 high-demand spikes."""
    if not client:
        raise ValueError("GEMINI_API_KEY is not configured.")

    last_error = None
    for model_name in FALLBACK_GEMINI_MODELS:
        try:
            config_params = {"temperature": temperature}
            if system_instruction:
                config_params["system_instruction"] = system_instruction
            if response_mime_type:
                config_params["response_mime_type"] = response_mime_type

            response = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=types.GenerateContentConfig(**config_params),
            )
            return response
        except Exception as e:
            err_str = str(e)
            print(f"[planner] Gemini model {model_name} failed ({err_str[:120]}), attempting fallback...")
            last_error = e
            continue

    # Secondary fallback to Groq if all Gemini models are experiencing 503 / spikes
    if settings.GROQ_API_KEY:
        for groq_model in ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]:
            try:
                from groq import Groq
                groq_client = Groq(api_key=settings.GROQ_API_KEY)
                messages = []
                if system_instruction:
                    messages.append({"role": "system", "content": system_instruction})
                user_text = ""
                if isinstance(contents, list) and len(contents) > 0:
                    parts = getattr(contents[0], "parts", [])
                    if parts and hasattr(parts[0], "text"):
                        user_text = parts[0].text
                    else:
                        user_text = str(contents)
                else:
                    user_text = str(contents)

                messages.append({"role": "user", "content": user_text})
                print(f"[planner] Gemini unavailable, attempting Groq fallback with {groq_model}...")
                chat_resp = groq_client.chat.completions.create(
                    messages=messages,
                    model=groq_model,
                    response_format={"type": "json_object"} if response_mime_type == "application/json" else None,
                    temperature=temperature,
                )
                raw_out = chat_resp.choices[0].message.content

                class _MockResp:
                    def __init__(self, text):
                        self.text = text

                return _MockResp(raw_out)
            except Exception as groq_err:
                print(f"[planner] Groq model {groq_model} failed: {groq_err}")
                continue

    raise last_error or RuntimeError("All AI models failed to respond.")

def get_system_prompt() -> str:
    schema_json = json.dumps(WorkflowBlueprint.model_json_schema(), indent=2)
    return f"""
You are VoxAgent AI, an expert automation workflow planner. 
Your task is to parse the user's natural language request into a strict structured JSON workflow blueprint.

CORE PRINCIPLE: STRICT PROMPT FIDELITY (NEVER SUMMARIZE OR OMIT STEPS):
1. The user's prompt is the absolute ground truth. Every task, operation, check, data retrieval, generation, conditional logic, and action requested by the user MUST be planned as dedicated, individual workflow steps.
2. The `title` field in the blueprint is STRICTLY a short 3-6 word summary name used for UI cards and database display in the Agents tab only (e.g., 'Bakery Inquiry & Telegram Alert'). NEVER use the title to summarize, simplify, collapse, or omit steps from the user prompt. Always plan all steps directly from the full, exact user prompt.
3. NEVER merge or skip intermediate steps. For example:
   - If the user asks to "check our bakery product catalog in the knowledge base, draft a polite reply with pricing, and send an alert to my Telegram":
     Step 1: Check knowledge base / draft reply with pricing (route: ai_generate)
     Step 2: Send reply email (route: composio_api, app: Gmail)
     Step 3: Send notification alert (route: telegram_client, app: Telegram Bot / Telegram Personal Account)
   Do NOT skip the knowledge check, do NOT skip the Telegram alert, and do NOT omit any action requested by the user.

Rules for route classification:
- 'browser_agent': For websites/portals without public APIs (e.g., college ERPs, WhatsApp Web, Canva, Instagram).
- 'composio_api': For any of the 1000+ SaaS apps with a public API via Composio (e.g. Gmail, Slack, GitHub, Google Sheets, Notion, Trello, ...). Set `app` to the app's plain name (e.g. "Gmail") and `action` to your best guess at that app's Composio action slug, following Composio's standard naming convention: uppercase `{{APPNAME}}_{{VERB}}_{{OBJECT}}` where `{{APPNAME}}` is the app's name with ALL spaces removed (not replaced with underscores) — e.g. "Google Sheets" → prefix `GOOGLESHEETS`, "Google Calendar" → `GOOGLECALENDAR` (so "GOOGLESHEETS_ADD_ROW", "GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE", "GITHUB_CREATE_AN_ISSUE"). This is only a best-effort guess — you do NOT need to know the action's exact slug or parameter names; the execution engine verifies your guess against that app's real tool catalog and self-corrects it if it doesn't exactly match, and aligns parameter keys automatically against the target tool's real schema, asking for anything genuinely missing. Do NOT use 'composio_api' with app "OpenAI" (or any other AI/LLM app) just to generate or draft text/content — use 'ai_generate' for that instead (see below); reserve 'composio_api' + an AI app for when the user explicitly names an AI app they have connected themselves.
- 'ai_generate': For a step whose job is purely to generate, draft, summarize, translate, or rewrite text/content with AI — e.g. "write a caption", "summarize this", "draft a reply" — with NO external app connection required (it runs on VoxAgent's own built-in AI). Set `app` to "VoxAgent AI", `action` to "GENERATE_TEXT", and `parameters` to `{{"prompt": "<full instructions for what to generate, including any context from earlier steps via {{step_N_result}}>"}}`. Never route plain text-generation to 'composio_api' with an OpenAI/Gemini/Anthropic app — those require a connected account the user probably doesn't have; 'ai_generate' needs nothing.
- 'http_webhook': For custom URLs, REST endpoints, or triggering other external software.
- 'telegram_client': For automating the user's OWN personal Telegram account — reading or sending in Saved Messages, DMs, or any chat they're personally part of. See the Telegram rule below.

Telegram rule — there are TWO distinct Telegram identities. YOU MUST pick the right one (BOTH use 'telegram_client' as the route):
- If the user explicitly asks to use their PERSONAL account (e.g. "my telegram", "saved messages", "any message I get on telegram", "send from my account"), set `app` to "Telegram Personal Account".
- If the user explicitly asks to use their BOT (e.g. "my bot", "bot reply", "customer support bot"), set `app` to "Telegram Bot".
- IMPORTANT: If the request is ambiguous or does not explicitly state "bot" or "personal account", DO NOT GUESS. You MUST set `needs_clarification` to true and add a `missing_parameters` entry with: `parameter_key: "telegram_account_type"`, `label: "Telegram Account Type"`, `description: "Should this run on your personal Telegram account, or your connected Telegram Bot?"`, `suggested_type: "select"`, and `options: ["Telegram Bot", "Telegram Personal Account"]`. Leave the step's `app` parameter exactly as `"{{telegram_account_type}}"` and omit it from `required_apps` until resolved.
For both, the action is "SEND_MESSAGE". For the `target` parameter:
- If replying to the person who triggered the event, set it to the EXACT placeholder `{{trigger_chat_id}}`.
- Otherwise, set it to a chat name/username, or "me" for Saved Messages.
Do NOT use 'composio_api' for Telegram.

Rule 1 (Default Storage): If the user asks to extract, scrape, or fetch information from a website or portal but DOES NOT specify where to save/store it, set the final step's target app to "VoxAgent Vault Notes" with route "http_webhook".

Rule 2 (Disambiguation & Missing Params): If an action requires specific parameters that the user did not provide (e.g., target Google Sheet name, the specific TABLE within a named Airtable base or Notion workspace — naming the base alone is not enough to address a table, target WhatsApp phone number, specific threshold value, or ERP portal URL):
- Do NOT invent or guess fake names or numbers.
- If you add a parameter to `missing_parameters`, LEAVE THAT PARAMETER OUT of the step's `parameters` object entirely. Never do both — never list `table_name` as missing while also writing `"table_name": "Invoices"` into the step. A plausible-looking stand-in there is indistinguishable from a value the user actually supplied, and the execution engine will act on it if the clarification is ever skipped or auto-answered. The `missing_parameters` entry IS the value's placeholder; the step body must show the gap.
- This holds for EVERY app and EVERY parameter, not just an Airtable `table_name`, and it holds in every shape — single-step, a Rule 3 two-step handoff, or a Rule 5 fan-out. Concrete example — "Grab the latest orders from our internal API and drop them into one of my spreadsheets": the user never named the spreadsheet, so step 2's `parameters` object is exactly `{{"row_data": "{{step_1_result}}", "headers": ["Order ID", "Customer Name"]}}` — there is NO `spreadsheet_name` key in it at all — and `spreadsheet_name` appears ONLY in `missing_parameters`. Writing `"spreadsheet_name": "Orders"` there is wrong even though the user said the word "orders": they said it to describe the DATA being moved, not to NAME the destination. A word that merely appears somewhere in the request is not a name the user gave; only a value the user stated AS that parameter's identity counts as a literal.
- A step whose destination the user never named is SUPPOSED to come out without a destination key. Do not "complete" it with a plausible default, a topic word lifted from the request, a generic name ("Sheet1", "Orders", "General", "#general"), or an echo placeholder like `"spreadsheet_name": "{{spreadsheet_name}}"`. An intentionally incomplete step body plus a `missing_parameters` entry IS the correct, complete output.
- FINAL CHECK before you emit the JSON: walk every entry in `missing_parameters`, find the step whose `step_number` matches, and confirm that step's `parameters` object does NOT contain that `parameter_key`. If it does, delete the key from `parameters` and keep only the `missing_parameters` entry.
- Set `needs_clarification` to true.
- Add an entry to `missing_parameters` specifying `step_number`, `parameter_key`, `label`, `description`, and `suggested_type`.
- Populate `clarification_question` with a friendly summary message (e.g., "Please specify the Google Sheet name and phone number to complete this setup.").
- NEVER ask the user for an internal ID (a spreadsheet ID, channel ID, database ID, file ID, or similar opaque identifier) — a normal user has no way to know or easily find one. Only ever ask for the human-friendly NAME of the thing (e.g. `parameter_key` "spreadsheet_name" with label "Google Sheet Name", not "spreadsheet_id"); the execution engine resolves the real ID from that name automatically at run time.

Rule 3 (Data Handoff Between Steps): When a later step needs to use data extracted or produced by an earlier step (e.g., emailing text a browser_agent step just scraped, or posting a composio_api tool's output to a webhook), set that parameter's value to the exact placeholder `{{step_N_result}}`, where N is the producing step's `step_number` (e.g. `{{step_1_result}}`). Do NOT paste invented placeholder text or fabricate what the earlier step "found" — use the literal placeholder string and the orchestrator will substitute the real value at execution time. Only use this when a step genuinely depends on another step's output; steps with no such dependency should keep concrete literal parameter values.

Rule 4 (Event-Driven "Whenever X Happens" Automations): If the user describes a REACTIVE automation — "whenever I get a message on...", "every time I receive an email about...", "when someone opens a GitHub issue, ..." — this is fundamentally different from a one-time or scheduled task and must be modeled differently:
- Set `trigger.type` to `"webhook"`.
- Set `trigger.event_app` to the app whose events are being watched — e.g. "Gmail", "Telegram Personal Account", or "Telegram Bot". If it's a Telegram automation and ambiguous, set this to `"{{telegram_account_type}}"` and follow the Telegram rule above to add a `missing_parameters` entry.
- Set `trigger.event_target` to any filter narrowing which events match — e.g. a phone number, a sender address, a specific chat/contact name, or "Saved Messages" for Telegram specifically. Omit it (or leave blank) to match events from ANY chat/sender, which is exactly what "detect any message from any account" means.
- Set `trigger.details` to a short human-readable description of the watched condition (e.g. "Triggered when any message arrives in Telegram Saved Messages").
- Do NOT add a step that "monitors" or "listens" for the event — the trigger itself IS the listener; listening is not an action a step performs. `steps` must contain ONLY the REACTION steps that should run once a matching event fires (e.g., just the "send an email" step).
- The very first reaction step may reference the captured event's content with these placeholders, populated the same way for ANY trigger-capable app (Telegram, Gmail, Slack, GitHub, ...):
  - `{{trigger_result}}` for the event's message text (e.g. an email body or customer inquiry text).
  - `{{trigger_chat_id}}` for the sender/reply-to identifier when a reply needs to go back to whoever/wherever triggered it:
    - For Gmail reply step: set `recipient_email` to `{{trigger_chat_id}}` (or `{{trigger_data.sender}}`). NEVER pass the bare `{{trigger_data}}` object to `recipient_email`.
    - For Telegram reply step: set `target` parameter to `{{trigger_chat_id}}`.
    - For Slack reply step: set `channel` parameter to `{{trigger_chat_id}}`.
  - `{{trigger_data}}` for the full structured event payload when a step needs more than just the text (or use `{{trigger_data.sender}}`, `{{trigger_data.subject}}`). Later steps can still use `{{step_N_result}}` normally for outputs produced by earlier reaction steps.

Rule 4.5 (Extracting Fields from Webhooks): When a reaction step requires a specific parameter (like an email address, phone number, name, etc.) that must be dynamically pulled from the `{{trigger_data}}` payload, DO NOT ask the user for the exact column or field name in `missing_parameters` or `clarification_question`. Instead, YOU MUST add a preliminary 'ai_generate' step whose sole job is to extract that specific piece of data. Set its prompt to: `Extract the [target field] from this data: {{trigger_data}}. Output ONLY the raw [target field] string and nothing else. Do not include quotes.` Then, in the downstream action step, use the placeholder `{{step_N_result}}` for that parameter. If downstream steps need INDIVIDUAL raw strings for multiple specific parameters (e.g., both a `recipient_email` and a drafted email body), add separate 'ai_generate' steps for each required field so they can be individually routed to their respective parameters via their own `{{step_N_result}}` placeholders.

Rule 4.6 (Google Sheets Triggers): For Google Sheets triggers (e.g., "whenever a new row is added"), the trigger requires both the exact spreadsheet name AND the exact sheet tab name (it defaults to 'Sheet1' otherwise, which will fail to trigger if the user's data is actually on a differently named tab).
- If the user explicitly stated the spreadsheet name (e.g. "Outreach Leads Google Sheet"), set `trigger.event_target` to that name. If they did NOT specify the spreadsheet name, add a `missing_parameters` entry with `step_number: "trigger"`, `parameter_key: "event_target"`, `label: "Spreadsheet Name"`, and ask for it.
- Because users rarely specify the tab name (e.g. "Sheet1" or "Leads") in their prompt, you MUST always add a `missing_parameters` entry for the tab name unless they explicitly named it. Use `step_number: "trigger"`, `parameter_key: "sheet_name"`, `label: "Sheet Tab Name"`, and `description: "What is the exact name of the tab inside this spreadsheet? (e.g. 'Sheet1', 'Leads')"` to ensure the trigger watches the correct tab.

Rule 5 (Fan-Out — one AI-generated item per downstream action): If the user asks for MULTIPLE discrete generated items to each be stored/sent individually (e.g., "generate 5 captions and save them to Google Sheets" → 5 separate rows, NOT one row with all 5 crammed together; "draft 3 email subject lines and send each as a separate email"), model it as exactly two steps:
- Step N: route 'ai_generate', producing the whole batch at once (e.g. `parameters.prompt` = "Write 5 engaging Instagram captions for ...").
- Step N+1: the storage/send action (e.g. Google Sheets row-add, an email-send), with its top-level `for_each` field set to the exact placeholder `"{{{{step_N_result}}}}"` (referencing the ai_generate step). Inside THIS step's `parameters`, use the placeholder `{{{{item}}}}` (not `{{{{step_N_result}}}}`) wherever the single per-iteration value belongs (e.g. the row's text cell, or the email body) — the execution engine runs this step once per generated item, substituting `{{{{item}}}}` with that item each time. Any other parameter that should stay the same across every iteration stays a normal literal value drawn from the user's request. IMPORTANT: do NOT invent a value for a constant parameter whose identity the user never gave — if the user named a parent resource but never named a required sub-resource inside it, the sub-resource must go to `missing_parameters` under Rule 2 (leave it out of `parameters` entirely). The rule is: any name or value the user literally said belongs in `parameters` as a concrete literal; only identities the user never gave at all are flagged as missing. Concrete example — "add each title to my Airtable base Content Calendar": `base_name: "Content Calendar"` is a literal (user said it); `table_name` is missing (user never named the table inside that base) → flag `table_name` in `missing_parameters`, keep `base_name: "Content Calendar"` in `parameters`. You do NOT need to know or care whether the target action actually calls once per item or batches all items into one call — the execution engine detects that from the target's real schema and adapts automatically; always express the fan-out the same way regardless.
- Do NOT add a `for_each` field to any step unless it is fanning out over a previous step's result this way; steps that run once should omit it entirely (or leave it null).

Rule 6 (Headers for Spreadsheet/Table Row Writes): Whenever a step writes row(s) of structured data into a spreadsheet/table/database (Google Sheets, Airtable, a Notion database, ...) — whether it's a Rule 5 fan-out (many rows) or a single record (e.g. one row of extracted fields from Rule 3, such as name/email/company) — ALWAYS also include a `headers` parameter alongside the row data: a short list of column-name strings, one per field/column being written (e.g. `["Caption"]` for one column, or `["Name", "Email", "Company"]` for a multi-field record). Many of these tools otherwise treat the very first row of data as the column headers instead of storing it, silently discarding what should have been real data — this is true even for a SINGLE row, which would otherwise be entirely lost. When writing one structured record with multiple fields, reference the WHOLE extraction result as the row-data placeholder (e.g. `{{{{step_N_result}}}}`) rather than trying to pull individual fields out yourself — the execution engine turns a single JSON object into one row with one cell per field, in the same order as `headers`.

Rule 7 (Credentials Are Handled Out-of-Band — Never a Parameter): VoxAgent resolves all login credentials for a 'browser_agent' step at execution time from the user's connected App Vault, keyed by that step's `app` name — the acting browser agent starts an ALREADY-AUTHENTICATED session, so it never needs to be handed a username or password.
- NEVER add a username, password, credential, login, PIN, OTP, API key, token, or secret entry to `missing_parameters`, and NEVER set `needs_clarification` to true because a login is required. Credentials are the one class of value the user must not be asked for at plan time.
- NEVER put a credential-shaped key (`username`, `password`, `credentials`, `username_field`, `password_field`, `api_key`, `token`, `secret`, ...) into any step's `parameters`.
- Do NOT model the login form as its own step and do NOT invent DOM field names for it. When a portal requires a login, just say so inside the browser step's task/instructions text (e.g. "log in to the portal if prompted, then open the Exam Registration page and ...") and let the pre-authenticated session handle it.
- Set the step's `app` to the portal's own recognizable name or host (e.g. "portal.vitap.ac.in") so it matches the user's saved vault entry, and include it in `required_apps` so the UI can prompt them to connect it if they haven't.
- If the user refers to or connects a regional website or domain (e.g. Amazon India / amazon.in), keep the step's task description and parameters strictly bound to that regional domain (e.g. "search on amazon.in") so that the browser agent operates on the user's specified website without defaulting to .com or displaying foreign currency (USD).
- A genuinely non-secret value the user must supply (a specific course name, a roll number, a date) is still a normal Rule 2 clarification — this rule covers ONLY secrets and login credentials.

Rule 8 (Automatic Business Knowledge Grounding — Zero Magic Words Required):
VoxAgent has an active, built-in Business Knowledge Hub containing the owner's company profile, business hours, services & pricing, refund & cancellation policies, and customer FAQs.
- NEVER require the user to say "stored knowledge", "business knowledge", or "knowledge hub".
- Whenever an automation involves:
  1. Customer communication, replying to client emails/messages, or drafting responses (e.g. answering inquiries, sending quotes, client follow-ups).
  2. Evaluating business policies, conditions, or eligibility (e.g. "if it qualifies under our refund policy", "check cancellation rules", "verify if we offer service X").
  3. Quoting prices, packages, business hours, or company details.
- DO NOT ask the user for these business policies, prices, hours, or rules in `missing_parameters` or `needs_clarification`. They are ALREADY stored in the system.
- Model the evaluation/drafting step as route: 'ai_generate', app: 'AI Generator'. In its prompt, instruct the AI to evaluate or draft based on the business's actual rules/policies (e.g. "Analyze the incoming inquiry: {{step_1_result}}. Based on our business refund policy, if the customer qualifies for a refund, respond YES. Otherwise respond NO. Output only YES or NO." or "Draft a polite, professional reply to the customer's question in {{step_1_result}}, answering accurately using our business details, pricing, and policies."). The execution engine automatically injects the matching knowledge context from the user's knowledge base at runtime.

Rule 9 (Conditional Step Guards & Filtering — Phase B): If the automation request involves a condition ("if X, then do Y", "only when...", "filter out...", "skip if not...", "alert only if refund/urgent"):
- Add an 'ai_generate' step prior to the action to classify or evaluate the condition, returning a clean normalized answer like 'YES' or 'NO' (or 'NO_ACTION'). Prompt example: "Analyze the incoming data: {{step_1_result}}. If it is related to a refund request, respond with YES. Otherwise respond with NO. Output only YES or NO."
- On the downstream action step(s), set `condition`: e.g. `"{{step_2_result}} == 'YES'"` or `"{{step_1_result}} != 'NO_ACTION'"`.
- If an action should only run when there is actual data produced (e.g. non-empty items or non-empty search results), set `skip_if_empty: true` on that step.
- When `condition` evaluates to False or `skip_if_empty` is triggered, the execution engine cleanly skips that step without failing the workflow.

Rule 10 (Intelligent Data Extraction & Pagination Limits Across All Apps):
- When fetching, listing, searching, or querying past data across ANY connected app (Gmail, Outlook, Slack, Discord, Google Calendar, Google Sheets, GitHub, Jira, Trello, Notion, Airtable, HubSpot, Google Drive, etc.):
  - On-Demand Manual Triggers: If the prompt asks to "check", "fetch", "find", "read", or "get" existing data on demand (and does NOT say "whenever" or "every time"), set `trigger.type` to "manual".
  - User-Specified Amount: If the user explicitly specifies the amount (e.g. "last 3 Slack messages", "top 10 issues", "first 5 rows", "past 2 calendar events"):
    Set the app's respective limit/count parameter (`limit`, `count`, `max_results`, `maxResults`, `per_page`, `page_size`, `range`) to match the user's requested amount exactly.
  - Safe Intelligent Defaults (when amount is omitted by user): The agent MUST set safe, intelligent defaults tailored to each app category to prevent overwhelming the app or causing payload/timeout errors:
    - Single / latest / newest item ("the latest", "last", "most recent", "newest"): set limit to `1` (e.g. `"max_results": 1`, `"limit": 1`, `"per_page": 1`).
    - Chat & Messaging (Slack, Discord, MS Teams): set `"limit": 5` (never default to 100 which dumps entire channel history).
    - Email (Gmail, Outlook): set `"max_results": 5` (or `1` for latest). Use `query` for Gmail filters (e.g. `query: "from:boss@company.com is:unread"`). When the user asks to "email me a digest" or send results to themselves, set `recipient_email: "me"`. Downstream steps reference `{{step_1_result}}` directly.
    - Calendar (Google Calendar, Outlook): set `"maxResults": 5` (or `1` for next event). Set action to `GOOGLECALENDAR_FIND_EVENT`. For date filtering (e.g. "tomorrow's schedule"), set `calendar_id: "primary"`, `time_min: "tomorrow"`, `time_max: "tomorrow"`. Conversational relative dates are converted to RFC3339 timestamps automatically.
    - Code & Developer (GitHub, GitLab):
      - For checking notifications: set route `composio_api`, app `GitHub`, action `GITHUB_LIST_NOTIFICATIONS`, parameters `{{"per_page": 5}}`.
      - For checking/listing/searching issues across user repos: set route `composio_api`, app `GitHub`, action `GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS`, parameters `{{"q": "is:open is:issue involves:@me", "per_page": 5}}`.
      - For listing repositories: set route `composio_api`, app `GitHub`, action `GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER`, parameters `{{"per_page": 5}}`.
    - Spreadsheets & Databases (Google Sheets, Airtable, Notion):
      - Google Sheets Semantic Intent Decider (Understand user intention across diverse conversational phrasing — never rely on rigid keyword matches like "add" or "read"):
        1. CREATING A NEW SPREADSHEET (Intent: Initialization / Fresh Document / Data Export):
           - Intent: The user wants to set up, initialize, establish, create, make, generate, build, export to, or start a brand-new separate spreadsheet (e.g. "create a spreadsheet with it", "summarise top 10 laptops from amazon and create a spreadsheet with it", "export results to a spreadsheet", "make a fresh spreadsheet named X", "compile data into a spreadsheet").
           - Architecture: Whenever data from earlier step(s) (such as search, extraction, or AI summary) should be placed into a new spreadsheet, this ALWAYS requires TWO steps:
             a. Step N (Create): Set route `composio_api`, app `Google Sheets`, action `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`.
                - Name Rule: If the user specified a name in their prompt, use it for `title` (e.g. `parameters: {{"title": "<Spreadsheet Name>"}}`). If the user did NOT specify what the new sheet should be named (e.g. "create a spreadsheet with it"), omit `title` from parameters and add to `missing_parameters` for this create step: `step_number: <step_number_of_create_step>`, `parameter_key: "spreadsheet_name"`, `label: "Google Spreadsheet Name"`, `description: "What would you like to name your new Google Spreadsheet?"`, `suggested_type: "text"`.
             b. Step N+1 (Append): Set route `composio_api`, app `Google Sheets`, action `GOOGLESHEETS_APPEND_ROW`. Under Rule 3, set its `spreadsheet_name` parameter to `"{{step_<N>_result}}"`, and its `values` parameter to reference the gathered/summarized data (e.g. `["{{step_<data_step>_result}}"]`). Do NOT ask for the spreadsheet name again on Step N+1.
        2. STORING / APPENDING INTO AN EXISTING SPREADSHEET (Intent: Accumulation / Storage):
           - Intent: The user wants to log, store, save, push, deposit, or record data into an ALREADY-EXISTING sheet/database (e.g. "put this in my existing Google Sheet", "save the lead to my tracker spreadsheet", "log orders in our company sheet").
           - Action: DO NOT create a spreadsheet! Set route `composio_api`, app `Google Sheets`, action `GOOGLESHEETS_APPEND_ROW` (or `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`), parameters `{{"spreadsheet_name": "<Spreadsheet Name>", "values": [["..."]]}}`.
           - Name Rule: If the user named the existing sheet, set `spreadsheet_name`. If the user did NOT state which existing sheet to use, omit `spreadsheet_name` from parameters and add to `missing_parameters`: `parameter_key: "spreadsheet_name"`, `label: "Google Spreadsheet Name"`, `description: "Which Google Spreadsheet would you like to update?"`, `suggested_type: "text"`.
        3. INSPECTING / READING FROM AN EXISTING SPREADSHEET (Intent: Inspection / Lookup / Reporting):
           - Intent: The user wants to check, examine, look at, summarize, retrieve, fetch, or report on data already living in a spreadsheet (e.g. "what products are in our inventory sheet", "give me a digest of the spreadsheet", "find out which orders are pending", "check Google Sheets for...").
           - Action: DO NOT create a spreadsheet! Set route `composio_api`, app `Google Sheets`, action `GOOGLESHEETS_BATCH_GET`, parameters `{{"spreadsheet_name": "<Spreadsheet Name>", "range": "A1:Z30"}}`.
           - Name Rule: If the user named the sheet, set `spreadsheet_name`. If not, add `spreadsheet_name` to `missing_parameters`: `label: "Google Spreadsheet Name"`, `description: "Which Google Spreadsheet would you like to check?"`, `suggested_type: "text"`.
      - For Airtable: set `"maxRecords": 10`.
      - For Notion: set `"page_size": 10`.
    - CRM & Cloud Drive (HubSpot, Google Drive): set `"limit": 10` or `"pageSize": 10`.
    - Social Media (Twitter/X, LinkedIn): set `"max_results": 5` or `"count": 5`.

Output exactly in the following JSON schema format:
{schema_json}
"""

# Routes whose `app` names something a real user might connect (an app the
# Required Apps gate should offer a connect flow for). 'ai_generate' runs on
# VoxAgent's own built-in AI (see the 'ai_generate' rule above) and
# 'http_webhook' targets a plain URL, not a connectable app — neither needs
# an entry here even when they appear alongside connectable steps.
_CONNECTABLE_ROUTES = {"composio_api", "browser_agent", "telegram_client"}


def _apply_route_fallback_and_required_apps(parsed_json: dict, prompt: str = "") -> None:
    """Two fixes applied to the raw planner output before validation:

    1. A 'composio_api' step whose app isn't an actual Composio toolkit
       (e.g. the user named an app like "Zomato" that Composio doesn't
       have) is switched to 'browser_agent' in place — the same fallback a
       human would reach for, decided at plan time so the Required Apps
       gate never offers a Composio "Connect" button that can only 500.
    2. `required_apps` is recomputed from the (possibly just-fixed) `steps`
       + trigger, instead of trusting whatever freeform list the LLM wrote
       alongside them — this is the single source of truth from here on,
       so it can't drift from what the steps actually use (an app the LLM
       mentioned but no step references, or a step's app the LLM forgot to
       list, both self-correct here).
    """
    from app.services.composio_engine import slugify_app_name, toolkit_exists

    steps = parsed_json.get("steps") or []
    required = []
    seen = set()

    def _add(name):
        if name and name not in seen and not (isinstance(name, str) and ("{" in name or "}" in name)):
            seen.add(name)
            required.append(name)

    for step in steps:
        app = step.get("app")
        route = step.get("route")
        if route == "composio_api" and app and not toolkit_exists(slugify_app_name(app)):
            step["route"] = "browser_agent"
            route = "browser_agent"
        if route in _CONNECTABLE_ROUTES:
            _add(app)

    trigger = parsed_json.get("trigger") or {}
    if trigger.get("type") == "webhook":
        _add(trigger.get("event_app"))

    parsed_json["required_apps"] = required

    # Check if user prompt intended to create a new spreadsheet, but the LLM only planned an append step
    prompt_creates_sheet = bool(
        prompt and (
            re.search(r"\b(create|make|generate|build|export\s+to|start|put\s+.*in(to)?\s+a\s+new)\b[^\.\n]*\b(spreadsheet|sheet)\b", prompt, re.I)
            or re.search(r"\b(new\s+(google\s+)?(spreadsheet|sheet))\b", prompt, re.I)
        )
    )

    has_create_sheet = any(
        "CREATE" in (s.get("action") or "").upper() and "SHEET" in (s.get("action") or "").upper()
        for s in steps
    )

    if prompt_creates_sheet and not has_create_sheet:
        for idx, s in enumerate(steps):
            act = (s.get("action") or "").upper()
            app_name = (s.get("app") or "").upper()
            if "SHEET" in app_name and any(w in act for w in ("APPEND", "WRITE", "ADD", "ROW", "VALUE")):
                extracted_title = None
                title_match = re.search(r"(?:named|called)\s+['\"]?([^'\",\.]+)", prompt, re.I)
                if title_match:
                    extracted_title = title_match.group(1).strip()

                create_step = {
                    "step_number": s.get("step_number", idx + 1),
                    "route": "composio_api",
                    "app": "Google Sheets",
                    "action": "GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
                    "parameters": {"title": extracted_title} if extracted_title else {},
                }
                steps.insert(idx, create_step)
                for i, step in enumerate(steps):
                    step["step_number"] = i + 1

                missing = parsed_json.get("missing_parameters") or []
                for m in missing:
                    if m.get("parameter_key") in ("spreadsheet_name", "spreadsheet_id", "title"):
                        m["step_number"] = create_step["step_number"]
                        m["label"] = "Google Spreadsheet Name"
                        m["description"] = "What would you like to name your new Google Spreadsheet?"

                if not extracted_title and not any(m.get("parameter_key") in ("spreadsheet_name", "spreadsheet_id", "title") for m in missing):
                    missing.append({
                        "step_number": create_step["step_number"],
                        "parameter_key": "spreadsheet_name",
                        "label": "Google Spreadsheet Name",
                        "description": "What would you like to name your new Google Spreadsheet?",
                        "suggested_type": "text",
                    })
                    parsed_json["missing_parameters"] = missing
                break

    # Auto-link newly created Google Spreadsheets to downstream Google Sheets steps
    create_step_num = None
    for s in steps:
        act = (s.get("action") or "").upper()
        if "CREATE" in act and "SHEET" in act:
            create_step_num = s.get("step_number")
            break

    if create_step_num is not None:
        for s in steps:
            s_num = s.get("step_number")
            if s_num is not None and s_num > create_step_num and "SHEET" in (s.get("app") or "").upper():
                params = s.setdefault("parameters", {})
                if not params.get("spreadsheet_name") and not params.get("spreadsheet_id"):
                    params["spreadsheet_name"] = f"{{{{step_{create_step_num}_result}}}}"
        # Purge any redundant missing parameter for downstream steps referencing the created sheet
        missing = parsed_json.get("missing_parameters") or []
        parsed_json["missing_parameters"] = [
            m for m in missing
            if not (
                m.get("step_number") is not None
                and isinstance(m.get("step_number"), int)
                and m.get("step_number") > create_step_num
                and m.get("parameter_key") in ("spreadsheet_name", "spreadsheet_id", "sheet_name")
            )
        ]
        rem = parsed_json["missing_parameters"]
        if not rem:
            parsed_json["needs_clarification"] = False
            parsed_json["clarification_question"] = None
        else:
            parsed_json["needs_clarification"] = True
            labels = [p.get("label") or p.get("parameter_key", "").replace("_", " ").title() for p in rem]
            if len(labels) == 1:
                parsed_json["clarification_question"] = f"Please specify the {labels[0]} to proceed."
            else:
                parsed_json["clarification_question"] = f"Please specify the {', '.join(labels[:-1])}, and {labels[-1]} to proceed."


def _extract_json_candidate(text: str) -> str:
    """Extracts candidate JSON text from an LLM response, handling markdown fences or preamble."""
    if not text:
        return ""
    text = text.strip()
    
    # 1. Regex to check if wrapped in markdown ```json ... ``` or ``` ... ```
    fence_pattern = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
    match = fence_pattern.search(text)
    if match:
        cand = match.group(1).strip()
        if cand.startswith("{") and cand.endswith("}"):
            return cand

    # 2. Find outermost curly braces
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start:end+1].strip()

    return text


def _local_heuristic_repair(text: str):
    """Attempts local heuristic fixes: unquoted keys, single quotes, trailing commas, Python literals."""
    import ast
    try:
        py_obj = ast.literal_eval(text)
        if isinstance(py_obj, dict):
            return py_obj
    except Exception:
        pass

    try:
        cleaned = text
        # Replace Python booleans/None
        cleaned = re.sub(r'\bTrue\b', 'true', cleaned)
        cleaned = re.sub(r'\bFalse\b', 'false', cleaned)
        cleaned = re.sub(r'\bNone\b', 'null', cleaned)

        # Fix single quotes on dictionary keys: 'key': -> "key":
        cleaned = re.sub(r"([{,]\s*)'([a-zA-Z0-9_]+)'\s*:", r'\1"\2":', cleaned)

        # Fix unquoted keys: { key: or , key: -> { "key": or , "key":
        cleaned = re.sub(r'([{,]\s*)([a-zA-Z0-9_]+)\s*:', r'\1"\2":', cleaned)

        # Fix trailing commas before } or ]
        cleaned = re.sub(r',\s*([}\]])', r'\1', cleaned)

        return json.loads(cleaned)
    except Exception:
        pass

    return None


def _llm_repair_json(raw_text: str):
    """Uses a fast Gemini/Groq call to repair severely distorted or malformed JSON syntax."""
    repair_prompt = (
        "You are a strict JSON syntax repair tool. The following text was supposed to be a JSON object "
        "for a WorkflowBlueprint, but has syntax errors (such as missing quotes, single quotes instead of double, "
        "missing colons, or unescaped characters).\n"
        "Fix it into strictly valid JSON adhering to standard JSON RFC 8259 syntax.\n"
        "CRITICAL: Output ONLY the raw valid JSON string. Do not wrap in markdown code blocks, do not explain, and do not add commentary.\n\n"
        f"Malformed text:\n{raw_text}"
    )
    for model_name in [
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
        "gemini-3-flash-preview",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
    ]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=[types.Content(role="user", parts=[types.Part.from_text(text=repair_prompt)])],
                config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.0)
            )
            cand = _extract_json_candidate(resp.text.strip())
            return json.loads(cand)
        except Exception as e:
            print(f"[planner] Model {model_name} repair failed: {e}")
            continue
    return None


def _parse_and_repair_json(raw_text: str) -> dict:
    """Multi-tiered JSON parsing and repair pipeline ensuring valid dictionary output."""
    candidate = _extract_json_candidate(raw_text)

    # Tier 1: Direct JSON parsing
    try:
        return json.loads(candidate)
    except Exception:
        pass

    # Tier 2: Local heuristic / regex repair
    repaired = _local_heuristic_repair(candidate)
    if repaired and isinstance(repaired, dict):
        print("[planner] JSON successfully repaired via local heuristic recovery.")
        return repaired

    # Tier 3: LLM self-healing repair
    print("[planner] Standard parsing failed, invoking LLM self-healing repair...")
    llm_repaired = _llm_repair_json(raw_text)
    if llm_repaired and isinstance(llm_repaired, dict):
        print("[planner] JSON successfully repaired via LLM self-healing.")
        return llm_repaired

    raise ValueError(f"Could not parse or repair LLM response into valid JSON: {raw_text[:200]}")


def _reconcile_missing_parameters(
    parsed_json: Dict[str, Any],
    current_blueprint: Optional[Dict[str, Any]],
    user_prompt: str,
) -> None:
    """Reconciles missing parameters during workflow amendment.

    Invariants:
    1. If an existing step survived in the new blueprint and its required parameter was not
       provided in user_prompt or the new step's parameters, it MUST be preserved in missing_parameters.
    2. If an existing step was removed/replaced (e.g. Telegram replaced by Gmail), any missing parameter
       for that removed step (e.g. telegram_account_type) is purged.
    3. If any missing parameters exist, needs_clarification is True and clarification_question asks for all of them.
    4. If no missing parameters exist, needs_clarification is False.
    """
    if not current_blueprint or not isinstance(current_blueprint, dict):
        return

    old_missing = current_blueprint.get("missing_parameters") or []
    if not old_missing:
        return

    old_steps = current_blueprint.get("steps") or []
    new_steps = parsed_json.get("steps") or []
    new_missing = parsed_json.get("missing_parameters") or []

    # Map old step_number to old step info
    old_step_by_num = {
        s.get("step_number"): s for s in old_steps if s.get("step_number") is not None
    }

    # Track which parameters are already present in new_missing
    existing_new_keys = {
        (p.get("step_number"), p.get("parameter_key")) for p in new_missing
    }

    for old_p in old_missing:
        old_step_num = old_p.get("step_number")
        param_key = old_p.get("parameter_key")
        if not param_key:
            continue

        # Case 1: Trigger-level missing parameter
        if old_step_num in ("trigger", None):
            old_trig = current_blueprint.get("trigger") or {}
            new_trig = parsed_json.get("trigger") or {}
            same_trigger = (
                new_trig.get("type") == old_trig.get("type") and
                new_trig.get("event_app") == old_trig.get("event_app")
            )
            if same_trigger:
                val = new_trig.get(param_key) or (new_trig.get("trigger_config") or {}).get(param_key)
                if not val or (isinstance(val, str) and ("{" in val or val.strip() == "")):
                    if ("trigger", param_key) not in existing_new_keys:
                        carried = dict(old_p)
                        carried["step_number"] = "trigger"
                        new_missing.append(carried)
                        existing_new_keys.add(("trigger", param_key))
            continue

        # Case 2: Step-level missing parameter
        old_step = old_step_by_num.get(old_step_num)
        if not old_step:
            continue

        old_app = (old_step.get("app") or "").strip().lower()
        old_action = (old_step.get("action") or "").strip().lower()

        # Find matching surviving step in new_steps:
        matching_new_step = None
        for ns in new_steps:
            ns_app = (ns.get("app") or "").strip().lower()
            ns_action = (ns.get("action") or "").strip().lower()
            if ns_app and (ns_app == old_app or old_app in ns_app or ns_app in old_app):
                matching_new_step = ns
                break
            elif ns_action and (ns_action == old_action):
                matching_new_step = ns
                break

        if not matching_new_step:
            # The step was removed/replaced (e.g. Telegram replaced by Gmail)
            continue

        new_step_num = matching_new_step.get("step_number")
        new_params = matching_new_step.get("parameters") or {}
        val = new_params.get(param_key)

        has_concrete_value = (
            val is not None and
            val != "" and
            not (isinstance(val, str) and ("{" in val and "}" in val))
        )

        if not has_concrete_value:
            already_present = any(
                p.get("parameter_key") == param_key and
                (p.get("step_number") == new_step_num or p.get("step_number") == old_step_num)
                for p in new_missing
            )
            if not already_present:
                carried = dict(old_p)
                carried["step_number"] = new_step_num
                new_missing.append(carried)
                existing_new_keys.add((new_step_num, param_key))
            else:
                for p in new_missing:
                    if p.get("parameter_key") == param_key:
                        p["step_number"] = new_step_num

    # Filter out any missing parameters for steps that no longer exist
    valid_step_nums = {s.get("step_number") for s in new_steps if s.get("step_number") is not None}
    filtered_missing = []
    seen_params = set()
    for p in new_missing:
        s_num = p.get("step_number")
        p_key = p.get("parameter_key")
        ident = (s_num, p_key)
        if ident in seen_params:
            continue
        if s_num in ("trigger", None) or s_num in valid_step_nums:
            seen_params.add(ident)
            filtered_missing.append(p)

    # Sort missing parameters by step_number: trigger first, then step 1, 2, ...
    def _sort_key(p):
        s_num = p.get("step_number")
        if s_num in ("trigger", None):
            return -1
        try:
            return int(s_num)
        except (ValueError, TypeError):
            return 999

    filtered_missing.sort(key=_sort_key)
    parsed_json["missing_parameters"] = filtered_missing

    # Ensure Rule 2: parameter_key must NOT be inside step["parameters"] if in missing_parameters
    for p in filtered_missing:
        s_num = p.get("step_number")
        p_key = p.get("parameter_key")
        if isinstance(s_num, int):
            for s in new_steps:
                if s.get("step_number") == s_num and "parameters" in s and isinstance(s["parameters"], dict):
                    if p_key in s["parameters"]:
                        del s["parameters"][p_key]

    # Update needs_clarification and clarification_question
    if filtered_missing:
        parsed_json["needs_clarification"] = True
        labels = [
            p.get("label") or p.get("parameter_key", "").replace("_", " ").title()
            for p in filtered_missing
        ]
        if len(labels) == 1:
            parsed_json["clarification_question"] = f"Please specify the {labels[0]} to proceed."
        elif len(labels) == 2:
            parsed_json["clarification_question"] = f"Please specify the {labels[0]} and {labels[1]} to proceed."
        else:
            parsed_json["clarification_question"] = f"Please specify the {', '.join(labels[:-1])}, and {labels[-1]} to proceed."
    else:
        parsed_json["needs_clarification"] = False
        parsed_json["clarification_question"] = None


def generate_blueprint(prompt: str, current_blueprint: Optional[Dict[str, Any]] = None) -> WorkflowBlueprint:
    user_content = prompt
    if current_blueprint and isinstance(current_blueprint, dict):
        try:
            curr_title = current_blueprint.get("title", "")
            curr_trigger = current_blueprint.get("trigger", {})
            curr_steps = current_blueprint.get("steps", [])
            curr_apps = current_blueprint.get("required_apps", [])
            curr_missing = current_blueprint.get("missing_parameters", [])
            user_content = (
                f"--- EXISTING WORKFLOW BLUEPRINT TO AMEND ---\n"
                f"Title: {curr_title}\n"
                f"Trigger: {json.dumps(curr_trigger, indent=2)}\n"
                f"Required Apps: {json.dumps(curr_apps)}\n"
                f"Steps: {json.dumps(curr_steps, indent=2)}\n"
                f"Active Missing Parameters: {json.dumps(curr_missing, indent=2)}\n"
                f"--- END EXISTING WORKFLOW ---\n\n"
                f"User Amendment Instruction: \"{prompt}\"\n\n"
                f"Task & Rules for Workflow Amendment:\n"
                f"1. Apply the user's amendment to modify, add, remove, reorder, or re-parameterize the steps as requested, "
                f"while keeping intact any unmentioned parts of the existing workflow.\n"
                f"2. MISSING PARAMETERS MANAGEMENT:\n"
                f"   - SURVIVING STEPS: For any step that remains in the workflow (e.g. Google Sheets), any missing parameters that were pending in 'Active Missing Parameters' (e.g. 'spreadsheet_name') MUST STILL BE INCLUDED in 'missing_parameters' unless the user's amendment instruction explicitly supplied a concrete value for it. DO NOT omit missing parameters for surviving steps.\n"
                f"   - REMOVED/REPLACED STEPS: If a step was deleted or replaced by another service (e.g. Telegram replaced by Gmail), remove that deleted step's missing parameters (e.g. 'telegram_account_type').\n"
                f"   - NEW/MODIFIED STEPS: If a new step or modified step needs parameters that the user has not provided (e.g. recipient email or address for Gmail), add them to 'missing_parameters'.\n"
                f"   - STEP NUMBERS: Ensure 'step_number' on each missing parameter corresponds to that step's new 1-based index (or 'trigger').\n"
                f"   - CLARIFICATION QUESTION: If 'missing_parameters' is not empty, set 'needs_clarification' to true and formulate 'clarification_question' asking specifically for all remaining missing parameters across all surviving and new steps.\n"
                f"3. FRESH WORKFLOW OVERRIDE: However, if the user explicitly asks for a completely new, separate, or unrelated workflow from scratch, discard the existing blueprint and generate a fresh workflow for the new request.\n"
                f"Output the complete updated WorkflowBlueprint JSON."
            )
        except Exception as _e:
            print(f"[planner] Failed to format current_blueprint context: {_e}")

    response = _generate_content_with_fallback(
        contents=[
            types.Content(role="user", parts=[types.Part.from_text(text=user_content)])
        ],
        system_instruction=get_system_prompt(),
        response_mime_type="application/json",
        temperature=0.1,
    )
    
    raw_text = response.text.strip()
    
    try:
        parsed_json = _parse_and_repair_json(raw_text)

        # Gracefully handle missing field edge cases
        parsed_json["original_prompt"] = prompt

        if not parsed_json.get("title"):
            parsed_json["title"] = prompt[:50].strip() or "Custom Automation Workflow"

        if "trigger" not in parsed_json:
            parsed_json["trigger"] = {"type": "manual", "details": "Triggered manually by user"}

        if "steps" not in parsed_json:
            parsed_json["steps"] = []

        if "missing_parameters" not in parsed_json:
            parsed_json["missing_parameters"] = []

        try:
            _reconcile_missing_parameters(parsed_json, current_blueprint, prompt)
        except Exception as _reconcile_err:
            print(f"[planner] missing parameters reconciliation skipped: {_reconcile_err}")

        if parsed_json.get("needs_clarification") and not parsed_json.get("clarification_question"):
            parsed_json["clarification_question"] = "Please provide more details to proceed."

        try:
            _apply_route_fallback_and_required_apps(parsed_json, prompt=prompt)
        except Exception as _route_err:
            # Best-effort — a Composio catalog hiccup here shouldn't block
            # blueprint generation; the LLM's own required_apps/route guess
            # is used as a fallback, same as before this pass existed.
            print(f"[planner] route fallback/required_apps derivation skipped: {_route_err}")

        return WorkflowBlueprint.model_validate(parsed_json)
    except Exception as e:
        raise ValueError(f"Failed to parse Gemini response into WorkflowBlueprint. Error: {e}. Raw response: {raw_text}")


_LIST_GENERATION_INSTRUCTION = (
    "Respond with ONLY a JSON array of strings — each element one complete, "
    "standalone item the user asked for (e.g. one caption per element, one "
    "subject line per element). No markdown, no numbering, no surrounding "
    "commentary, no wrapping object — just the bare JSON array."
)


import re
import requests
from bs4 import BeautifulSoup

def _inject_url_content(prompt: str) -> str:
    url_pattern = re.compile(r'https?://[^\s<>"]+|www\.[^\s<>"]+')
    urls = set(url_pattern.findall(prompt))
    if not urls:
        return prompt
    
    appended_content = "\n\n--- External Content Extracted from URLs ---\n"
    added = False
    for url in urls:
        try:
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, 'html.parser')
                text = soup.get_text(separator=' ', strip=True)
                text = text[:25000] # truncate to avoid blowing up context
                appended_content += f"\nContent from {url}:\n{text}\n"
                added = True
        except Exception:
            pass
            
    if added:
        return prompt + appended_content
    return prompt

def generate_ai_content(prompt: str, as_list: bool = False, user_id: str | None = None, knowledge_sources: list[str] | None = None):
    """Runs a plain AI text-generation step directly against Gemini for the
    'ai_generate' route — drafting/summarizing/rewriting content with no
    external app connection required (see planner.py's 'ai_generate' rule).

    If `user_id` is provided, relevant chunks from the user's knowledge base
    are retrieved via semantic search and injected into the prompt BEFORE
    calling Gemini — so any reference like "use template from knowledge base"
    or "use my outreach template" automatically gets the right content,
    and the model can fill in placeholders (e.g. {company name}) with data
    already present in the prompt from prior steps.

    `knowledge_sources`, when given, restricts retrieval to only those named
    knowledge sources — a user's knowledge hub is a single pool per account,
    so an automation dedicated to one business (e.g. a bakery bot) needs this
    to avoid pulling in an unrelated business's content (e.g. a real estate
    listing) that happens to be a closer semantic match for a given message.
    Omit it to search the user's whole knowledge hub (the old behavior).

    as_list=True asks for a JSON array of discrete items instead of one block
    of text, for a step whose result a downstream step fans out over via
    `for_each` (see orchestrator.py) — e.g. one Google Sheets row per
    generated caption rather than all of them crammed into a single cell.
    """
    if not client:
        raise ValueError("GEMINI_API_KEY is not configured.")

    # --- Knowledge Base injection ---
    # Retrieve relevant chunks from the user's knowledge hub and prepend them
    # so the model has the right context (templates, SOPs, brand guidelines,
    # etc.) without any hardcoding per prompt type.
    if user_id:
        try:
            from app.services.context_injector import retrieve_business_context
            knowledge = retrieve_business_context(user_id, prompt, threshold=0.45, limit=5, source_names=knowledge_sources)
            if knowledge:
                prompt = (
                    f"--- BUSINESS KNOWLEDGE BASE CONTEXT ---\n"
                    f"{knowledge}\n"
                    f"--- END BUSINESS KNOWLEDGE BASE CONTEXT ---\n\n"
                    f"CRITICAL BUSINESS GROUNDING INSTRUCTIONS:\n"
                    f"1. You are acting on behalf of the business owner. Use the business knowledge above as the absolute single source of truth for all business details, policies, hours, prices, and FAQs.\n"
                    f"2. Strict Policy Adherence: When evaluating eligibility (e.g. refunds, returns, cancellations, discounts), strictly enforce the business's stated rules. Do NOT approve exceptions or hallucinate terms not supported by the knowledge.\n"
                    f"3. When drafting a customer reply, be polite, professional, and accurate. Fill in placeholders with actual values from the task data.\n"
                    f"4. Do NOT ask the user for information that is already provided in the knowledge base or task data.\n\n"
                    f"Task Instructions:\n{prompt}"
                )
        except Exception as _kb_err:
            print(f"[ai_generate] Knowledge base retrieval skipped: {_kb_err}")

    # Automatically fetch URLs in the prompt so Gemini can summarize them
    prompt = _inject_url_content(prompt)

    if as_list:
        response = _generate_content_with_fallback(
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
            system_instruction=_LIST_GENERATION_INSTRUCTION,
            response_mime_type="application/json",
            temperature=0.7,
        )
        raw_text = response.text.strip()
        try:
            items = json.loads(raw_text)
        except Exception:
            return [raw_text]
        if isinstance(items, list):
            return [item if isinstance(item, str) else json.dumps(item) for item in items]
        return [str(items)]

    system_instruction = (
        "You are a helpful AI assistant executing a step in an automated workflow. "
        "Your input may include a KNOWLEDGE BASE CONTEXT section — if it does, use it. "
        "If a template or document is provided in the knowledge base, use it as-is and replace any "
        "placeholders (like {company name}, {first name}, {product}, {recipient}, etc.) with the "
        "actual values present in the task data. Never ask for values that are already available "
        "in either the knowledge base context or the task data. "
        "Only ask the user for clarification if information is genuinely missing from BOTH the "
        "knowledge base context AND the task data, and even then keep your question EXTREMELY simple, "
        "concise, and non-technical — just state plainly what single piece of information is needed."
    )

    response = _generate_content_with_fallback(
        contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
        temperature=0.7,
        system_instruction=system_instruction,
    )
    text = _strip_markdown_fences(response.text.strip())

    # A prompt that asks for "a structured JSON object" (e.g. Rule 3's
    # extract-fields-from-an-email pattern) gets exactly that back as text —
    # if it happens to parse as real JSON, return the parsed dict/list
    # instead of the literal string. Downstream steps (see
    # composio_engine._coerce_value_type) already know how to turn a real
    # dict into one row per field; a JSON-shaped STRING just gets dumped
    # into a single cell verbatim, fences and all. Plain prose (a caption, a
    # summary) simply won't parse and falls through unchanged.
    try:
        parsed = json.loads(text)
    except Exception:
        return text
    return parsed if isinstance(parsed, (dict, list)) else text


def _strip_markdown_fences(text: str) -> str:
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[: -len("```")]
    return text.strip()
