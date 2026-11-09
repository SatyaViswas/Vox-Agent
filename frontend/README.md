# 💻 VoxAgent AI Frontend — React Application

The frontend of VoxAgent AI is a modern React web application built with Vite and Tailwind CSS. It provides an intuitive, high-performance interface for planning workflows, connecting applications, monitoring execution steps in real-time, managing the RAG knowledge base, and handling human-in-the-loop interventions.

---

## 📖 Table of Contents
1. [Tech Stack](#-tech-stack)
2. [Key Screens & Features](#-key-screens--features)
3. [Prerequisites](#-prerequisites)
4. [Setup & Installation](#-setup--installation)
5. [Environment Configuration](#-environment-configuration)
6. [Available Scripts](#-available-scripts)

---

## 💻 Tech Stack
*   **Framework:** React 19 (JavaScript)
*   **Build Tool:** Vite + HMR (Hot Module Replacement)
*   **Styling:** Tailwind CSS + Lucide Icons
*   **State Management:** Zustand (lightweight stores for auth, agents, studio, and notifications)
*   **Voice Integration:** Gnani Prisma v3.0 STT & Timbre v3.0 TTS Audio Feedback
*   **API Queries:** Fetch API + WebSocket connections for real-time telemetry streaming & notifications
*   **Routing:** React Router v7
*   **Internationalization:** i18next (supports 10+ languages)
*   **Linter:** Oxlint (high-speed rust-based linter)

---

## 🖥️ Key Screens & Features

The user interface consists of the following key views located in `src/pages/`:

*   **`Landing.jsx` (Welcome & Entry):** Introduces VoxAgent AI and serves as the landing dashboard.
*   **`Auth.jsx` (Secure Access):** Manages user registration and logins integrated with Supabase auth.
*   **`AgentStudio.jsx` (Interactive Builder & Telemetry):** The core playground. Lets users describe an objective via voice (with Gnani Prisma ASR) or text, watch Gemini formulate a multi-step execution blueprint, run the agent, and stream step-by-step progress, screenshots, and logs in real-time. Also handles human-in-the-loop pauses and hands-free voice disambiguation.
*   **`AppVault.jsx` (Application Manager):** A credential manager to connect accounts (Slack, GitHub, Google Drive, Telegram, WhatsApp) using Composio and encrypted storage. Features remote live-view browser authentication for mobile and desktop devices.
*   **`KnowledgeBase.jsx` (RAG Knowledge Hub):** Allows users to upload documents (PDF, CSV, or Web URLs) or record audio memos directly (via Gnani Prisma) to store text embeddings for vector retrieval.
*   **`MyAgents.jsx` (Agent Catalog):** Displays the status (active, paused, completed) of all created agents and lets users manage scheduled cron runs or live event triggers.
*   **`VaultNotes.jsx` (Extracted Notes):** View and search notes or structural outputs compiled by automated scrapers.
*   **Global Layout & Notifications (`AppShell.jsx`, `NotificationsDropdown.jsx`, `BottomNav.jsx`):**
    - **Global Voice FAB:** One-tap voice modal for hands-free workflow generation and agent queries.
    - **Live Notification Hub:** Tracks unattended background executions (scheduled cron runs, incoming Telegram/webhook triggers), dispatches desktop push notifications, and speaks natural voice completion alerts.

---

## 📋 Prerequisites
*   [Node.js v18 or higher](https://nodejs.org/)
*   npm (included with Node.js) or Yarn / pnpm

---

## ⚙️ Setup & Installation

Follow these steps to set up and run the client locally:

1.  **Navigate to the frontend folder:**
    ```bash
    cd frontend
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Configure Environment Variables:**
    *   Create a local env file by duplicating the template:
        ```bash
        cp .env.example .env
        ```
    *   Open `.env` and verify that the API base URL matches your backend instance:
        ```env
        VITE_API_BASE_URL=http://localhost:8000/api/v1
        ```
        *(WebSockets will automatically derive their stream URL from this base API url).*
4.  **Launch the development server:**
    ```bash
    npm run dev
    ```
    *The web application will launch locally at [http://localhost:5173](http://localhost:5173).*

---

## 🛠️ Available Scripts

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `dev` | `npm run dev` | Start Vite dev server with HMR |
| `build` | `npm run build` | Compile and bundle production assets into `/dist` |
| `preview`| `npm run preview` | Spin up a local server to test the production build |
| `lint` | `npm run lint` | Run the Oxlint linter for static code analysis |
