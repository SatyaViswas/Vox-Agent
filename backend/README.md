# 🐍 VoxAgent AI Backend — FastAPI Service

The backend of VoxAgent AI is a Python-based FastAPI service that runs the Triple-Engine Hybrid Automation planner and handles integrations, database synchronization, and the self-healing workflow execution loop.

---

## 📖 Table of Contents
1. [Tech Stack](#-tech-stack)
2. [Prerequisites](#-prerequisites)
3. [Setup & Installation](#-setup--installation)
4. [Environment Variables Reference](#%EF%B8%8F-environment-variables-reference)
5. [Directory Layout](#-directory-layout)
6. [MutAgent Integration & Config](#-mutagent-integration--config)
7. [Running & Testing](#-running--testing)

---

## 💻 Tech Stack
*   **Web Framework:** FastAPI + Uvicorn
*   **Database:** Supabase PostgreSQL Client (`supabase-py`)
*   **Voice Intelligence:** Gnani AI SDK (Prisma v3.0 ASR, Timbre v3.0 Streaming Expressive TTS, Speaker Embedding Voice Cloning)
*   **AI Models:** Google Gemini 2.0 Flash / 1.5 Pro (Core Planner), Groq Llama-3.3 (Self-Healing Repair)
*   **Integrations:** Composio SDK (250+ standard APIs), Playwright Stealth + `browser-use` (GUI automation)
*   **Task Scheduling & Triggers:** APScheduler (Cron tasks), Telethon (Telegram Client Engine), Webhooks

---

## 📋 Prerequisites
*   Python 3.10+
*   pip or [uv](https://github.com/astral-sh/uv) (recommended for faster package installation)
*   Playwright system dependencies (installed via Playwright CLI)

---

## ⚙️ Setup & Installation

Follow these steps to set up the backend service locally:

1.  **Navigate to the backend folder:**
    ```bash
    cd backend
    ```
2.  **Create a Python Virtual Environment:**
    ```bash
    python3 -m venv venv
    ```
3.  **Activate the Virtual Environment:**
    *   **Linux/macOS:**
        ```bash
        source venv/bin/activate
        ```
    *   **Windows (Command Prompt):**
        ```cmd
        venv\Scripts\activate.bat
        ```
    *   **Windows (PowerShell):**
        ```powershell
        .\venv\Scripts\Activate.ps1
        ```
4.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```
5.  **Install Playwright browser binaries:**
    ```bash
    playwright install chromium
    ```
    *Note: If you run into system dependency issues, run `playwright install-deps chromium`.*
6.  **Create your Environment File:**
    ```bash
    cp .env.example .env
    ```
7.  **Configure environment variables** in the newly created `.env` file (see the [Environment Variables](#%EF%B8%8F-environment-variables-reference) section below).

---

## 🛠️ Environment Variables Reference

| Variable | Description | Required? |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Google Gemini API key. Powers the workflow planner and browser agent engines. | **Yes** |
| `SUPABASE_URL` | The URL of your Supabase project (from Settings > API). | **Yes** |
| `SUPABASE_SERVICE_ROLE_KEY` | The privileged service role secret (do not expose this key). | **Yes** |
| `COMPOSIO_API_KEY` | Key for Composio SDK integration (250+ third-party tools). | **Yes** |
| `GNANI_API_KEY` | Gnani AI API key. Powers Prisma v3.0 ASR, Timbre v3.0 Expressive TTS, and Voice Cloning. | **Yes (Voice)** |
| `GNANI_BASE_URL` | Gnani AI API base endpoint (default: `https://api.vachana.ai`). | Optional |
| `GROQ_API_KEY` | Groq API key. Powers the Llama-3.3 repair engine for MutAgent self-healing. | Optional |
| `TELEGRAM_API_ID` | Telegram Client API ID (from my.telegram.org) for automated chat logins. | Optional |
| `TELEGRAM_API_HASH` | Telegram Client API Hash. | Optional |
| `PORT` | Local port for FastAPI server (default: `8000`). | Optional |
| `ALLOWED_ORIGINS` | Comma-separated list of CORS-permitted origins. | Optional |

---

## 📁 Directory Layout

```text
├── main.py                   # FastAPI application initialization & watchdog loops
├── requirements.txt          # Third-party package definitions
├── render-build.sh           # Deployment build script for hosting (e.g. Render)
├── app/
│   ├── config.py             # App configuration loading and Pydantic validation
│   ├── database.py           # Supabase DB client initializer
│   ├── routers/              # FastAPI API endpoints
│   │   ├── auth.py           # User authentication routes
│   │   ├── execution.py      # Agent setup, deletion, logs, and /recent-executions background notifications
│   │   ├── planner.py        # Generation of executable JSON blueprints & voice transcription
│   │   ├── vault.py          # connected_apps credentials and vault_notes endpoints
│   │   ├── knowledge.py      # RAG-based business knowledge ingestion & audio transcription routes
│   │   ├── translate.py      # Multilingual IndicTrans2 and text translation endpoints
│   │   └── tts.py            # Gnani Timbre streaming TTS and speech endpoints
│   ├── schemas/              # Pydantic schemas for request/response validation
│   └── services/             # Core orchestration logic
│       ├── orchestrator.py   # Primary workflow execution loop & step runner
│       ├── gnani_service.py  # Gnani AI Prisma STT, Timbre TTS & voice cloning client
│       ├── asr_context.py    # Dynamic user entity booster for Prisma v3.0 STT
│       ├── disambiguation.py # Conversational voice disambiguation & Hinglish entity extractor
│       ├── execution_events.py# Real-time background execution event ring buffer & persister
│       ├── composio_engine.py# Composio tool integration handler & self-healing sheet creator
│       ├── browser_engine.py # Playwright Stealth & browser-use GUI agent handler
│       ├── browser_login_engine.py # Interactive remote browser session manager
│       ├── telegram_client_engine.py # Telethon personal Telegram listener & sender
│       ├── knowledge_ingestion.py # File parsing (PDF/CSV/Audio) and vector embedding
│       ├── context_injector.py   # Semantic similarity context ranker for RAG
│       └── mutagent/         # MutAgent self-healing engine modules
```

---

## 🤖 MutAgent Integration & Config

The project is integrated with both the **MutAgent Helix Agent Development Lifecycle (ADL)** for developer-time optimization and the runtime **MutAgent self-healing module**.

### 🔄 MutAgent Helix ADL Optimization Framework

Our system prompt for the planner (`app/services/planner.py`) is verified and optimized using MutAgent Helix. The assets reside under `.mutagent/specs/voxagent-planner/`:

*   **`agentspec.yaml`**: Declares 9 binary evaluation criteria and 8 test scenarios.
*   **`checks/verify_build_alignment.py`**: A hermetic script performing 13 AST-based structural validations of the prompt at build-time.
*   **`tier0_code_checks.py`**: Evaluation code check script running the target criteria.
*   **`run_dataset_through_planner.py`**: Runs the 24 adversarial prompt dataset and outputs traces.

#### Running the Optimizer & Evaluation Suite
To run the evaluation suite and view the scorecard:
```bash
# From the backend directory
source .venv/bin/activate
python3 ../.mutagent/specs/voxagent-planner/run_dataset_through_planner.py

cd ../.mutagent/specs/voxagent-planner
python3 tier0_code_checks.py
python3 aggregate_scorecard_final.py
```

---

### 🛡️ Runtime Self-Healing Engine

The **MutAgent** module resides in `app/services/mutagent/` and acts as an interceptor around all action dispatchers. When an automation step fails, MutAgent attempts to heal the workflow without aborting the run:

1.  **Classification (`classifier.py`):** Translates exceptions into structured failure states (Transient, Rate Limit, Selector Drift, Schema Mismatch, etc.).
2.  **Retry Interception (`controller.py`):** Executes retry-with-backoff for transient issues.
3.  **Learned Memory (`memory.py`):** Saves human resolutions for ambiguous requests into the `mutation_memory` table and automatically applies them next time.
4.  **LLM-based Healing (`llm_repair.py`):** Connects to Groq (`llama-3.3-70b-versatile`) to repair selectors, HTML paths, and parameters.
5.  **Circuit Breaker (`circuit_breaker.py`):** Protects API quotas by blocking retries on systemically broken integrations.

### Config Options in `.env`:
*   `MUTAGENT_ENABLED`: Set to `true` to enable self-healing (default: `false`).
*   `MUTAGENT_MAX_RETRY_ATTEMPTS`: Total retry limit (default: `3`).
*   `MUTAGENT_LLM_REPAIR_ENABLED`: Set to `true` to allow LLM-proposed parameter corrections.
*   `MUTAGENT_SHADOW_MODE`: If `true`, self-healing will run in "shadow mode," logging suggested fixes without applying them to execution.

---

## 🚀 Running & Testing

### Start the FastAPI Dev Server:
```bash
uvicorn main:app --reload --port 8000
```
API endpoints are exposed locally at [http://localhost:8000](http://localhost:8000).

### Sanity Checks & Testing Scripts:
A collection of test scripts is provided in the backend root directory for verification:
*   `python test_db.py`: Verifies the database connection and connection pool.
*   `python test_active.py`: Tests retrieval of active event and scheduled triggers.
*   `python test_fetch.py`: Verifies raw HTTP fetch capabilities.
*   `python test_composio.py`: Tests the Composio API integration state.
*   `python test_google.py`: Verifies Gemini planner connection and blueprint generation.
*   `python test_embed.py`: Asserts correct embedding generation dimensions (768 dimensions).
*   `python test_telegram_start.py`: Validates user account login setup.
