# VoxAgent AI - Project Context

## 1. Vision & Core Concept
VoxAgent AI converts casual speech or plain-text descriptions into fully executed digital workflows across any web app or service using a Triple-Engine Hybrid Automation Architecture:
- Engine 1 (Browser GUI Agent): `browser-use` + Playwright for web apps lacking public APIs (College ERPs, WhatsApp Web, Canva, Instagram).
- Engine 2 (Dynamic API Tools): Composio SDK for 250+ standard APIs (Google Workspace, Notion, Slack, GitHub, Trello).
- Engine 3 (Autonomous HTTP): FastAPI / n8n HTTP requests for custom webhooks and REST endpoints.

## 2. Full Tech Stack
- **Backend**: FastAPI (Python 3.10+), Uvicorn, Playwright, `browser-use`, Composio SDK, Google Gemini 1.5/2.0 Flash API, Groq Whisper API, Supabase Python Client.
- **Frontend**: React + Vite + Tailwind CSS.
- **Database & Vault**: Supabase PostgreSQL.

## 3. Database Schema Overview
Tables:
- `users`: Stores user information.
- `connected_apps`: Manages connected third-party applications.
- `agents`: Stores configured agents and their properties.
- `execution_logs`: Logs execution history of automated workflows.

## 4. Folder Structure
- `backend/`: Python FastAPI app, requirements, environment variables (`.env`).
- `frontend/`: React Vite app, environment variables (`.env`).
