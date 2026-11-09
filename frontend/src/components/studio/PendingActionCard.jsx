import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ExternalLink, Loader2, Mic, Send, Volume2, X } from "lucide-react";
import { Link } from "react-router-dom";
import PortalSessionFormModal from "../vault/PortalSessionFormModal";
import useSpeechRecognition from "../../hooks/useSpeechRecognition";

// The sensitive-action approval gate's question (see orchestrator.py's
// SENSITIVE_ACTIONS check) embeds a formatted ```json block of the
// parameters being approved — pull that out into its own preview instead
// of showing it as part of the question text.
function splitJsonPreview(question) {
  const match = question?.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return { text: question, json: null };
  try {
    return { text: question.replace(/```json\n[\s\S]*?\n```/, "").trim(), json: JSON.parse(match[1]) };
  } catch {
    return { text: question, json: null };
  }
}

// One typed renderer for every "the system needs your input" surface —
// a live mid-run pause in Agent Studio, or an item in the Action Center
// (NotificationsDropdown) for a scheduled/triggered run nobody's watching.
// Which controls it shows is driven entirely by `inputType` (from the
// pending_actions row's `input_type` column) instead of every caller
// re-implementing its own free-text-only form.
export default function PendingActionCard({
  question,
  inputType = "text",
  reconnectApp,
  reconnectRoute,
  userId,
  options,
  busy,
  error,
  onResume,
  onApprove,
  onReject,
  onSpeak,
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState("");
  const [browserLoginOpen, setBrowserLoginOpen] = useState(false);
  const { text, json } = splitJsonPreview(question);

  const {
    isRecording,
    isProcessing,
    interimTranscript,
    start: startVoice,
    stop: stopVoice,
    toggle: toggleVoice,
  } = useSpeechRecognition({
    onFinalTranscript: (spokenText) => {
      const clean = (spokenText || "").trim();
      if (!clean) return;
      setAnswer(clean);
      if (inputType === "confirm") {
        const lower = clean.toLowerCase();
        if (lower.includes("yes") || lower.includes("approve") || lower.includes("confirm") || lower.includes("proceed")) {
          onApprove?.();
          return;
        } else if (lower.includes("no") || lower.includes("reject") || lower.includes("cancel") || lower.includes("stop")) {
          onReject?.();
          return;
        }
      }
      onResume(clean);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!answer.trim() || busy) return;
    onResume(answer.trim());
  };

  const handleRetry = () => {
    if (busy) return;
    onResume("reconnected");
  };

  return (
    <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 md:p-5 shadow-[0_0_30px_rgba(245,158,11,0.08)]">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium text-sm mb-1">
        <AlertTriangle size={16} className="shrink-0" />
        {t("pendingAction.needsInput")}
      </div>
      <div className="flex items-start justify-between gap-2 mb-3">
        <p className="text-xs text-amber-700/80 dark:text-amber-300/80 whitespace-pre-wrap">{text}</p>
        {onSpeak && text && (
          <button
            type="button"
            onClick={() => onSpeak(text)}
            className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 hover:text-amber-800 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 rounded-md font-medium shrink-0 transition-colors"
            title="Listen with Gnani Timbre"
          >
            <Volume2 size={12} />
            <span>Listen</span>
          </button>
        )}
      </div>

      {json && (
        <div className="mb-3 bg-slate-900/5 dark:bg-black/20 p-2 rounded-lg text-xs font-mono text-slate-600 dark:text-slate-300 overflow-x-auto">
          <pre>{JSON.stringify(json, null, 2)}</pre>
        </div>
      )}

      {reconnectApp && reconnectRoute === "browser_agent" ? (
        // A browser_agent app's stored session expired mid-run (see
        // orchestrator.py's auth-required detection) — reconnecting means
        // logging in again in a real browser window (see
        // browser_login_engine.py), same one-click flow as the initial
        // connect. Retrying is folded into the connect flow itself
        // (PortalSessionFormModal's onConnected below) instead of a
        // separate "I've reconnected" click.
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setBrowserLoginOpen(true)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {t("pendingAction.connectAppInVault", { app: reconnectApp })}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-red-400/50 hover:bg-red-400/10 disabled:opacity-40 text-red-600 dark:text-red-400 text-sm font-medium px-4 py-2 transition-colors ml-auto"
            >
              <X size={14} /> {t("common.cancel")}
            </button>
          </div>
          <PortalSessionFormModal
            open={browserLoginOpen}
            mode="create"
            initialName={reconnectApp}
            lockName
            userId={userId}
            onClose={() => setBrowserLoginOpen(false)}
            onConnected={() => {
              setBrowserLoginOpen(false);
              onResume("reconnected");
            }}
          />
        </>
      ) : reconnectApp ? (
        // A composio_api app's connection expired/was disconnected mid-run
        // (see composio_engine.execute_composio_action) — that's a
        // Composio OAuth/credential reconnect, done from the App Vault
        // page, not the browser-login flow above.
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/vault"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium px-4 py-2 transition-colors"
          >
            {t("pendingAction.connectAppInVault", { app: reconnectApp })} <ExternalLink size={13} />
          </Link>
          <button
            onClick={handleRetry}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {busy ? t("pendingAction.retrying") : t("pendingAction.reconnectedRetry")}
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-red-400/50 hover:bg-red-400/10 disabled:opacity-40 text-red-600 dark:text-red-400 text-sm font-medium px-4 py-2 transition-colors ml-auto"
          >
            <X size={14} /> {t("common.cancel")}
          </button>
        </div>
      ) : inputType === "confirm" ? (
        // The sensitive-action approval gate — a real typed decision, with optional voice approval
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={onApprove}
              disabled={busy || isProcessing}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-semibold px-4 py-3 sm:py-2 transition-all active:scale-95 shadow-sm"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {t("pendingAction.approve")}
            </button>
            <button
              onClick={onReject}
              disabled={busy || isProcessing}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-semibold px-4 py-3 sm:py-2 transition-all active:scale-95"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
              {t("pendingAction.reject")}
            </button>
            <button
              type="button"
              onClick={toggleVoice}
              disabled={busy || isProcessing}
              className={`flex items-center gap-1.5 rounded-xl text-sm font-semibold px-3.5 py-3 sm:py-2 transition-all active:scale-95 ${
                isRecording
                  ? "bg-red-500 hover:bg-red-600 text-white animate-pulse shadow-md"
                  : "bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-400/50"
              }`}
              title="Speak 'Approve' or 'Reject' with Gnani Prisma"
            >
              {isProcessing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Mic size={16} className={isRecording ? "animate-bounce" : ""} />
              )}
              <span>{isRecording ? "Listening..." : "Voice"}</span>
            </button>
          </div>
          {isRecording && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              <span>Say &ldquo;Approve&rdquo; or &ldquo;Reject&rdquo; — stops automatically when you pause.</span>
            </div>
          )}
        </div>
      ) : inputType === "select" && options?.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {options.map((opt) => (
              <button
                key={opt}
                onClick={() => onResume(opt)}
                disabled={busy}
                className="rounded-lg border border-amber-400/50 hover:bg-amber-400/10 active:scale-95 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-all shadow-sm"
              >
                {opt}
              </button>
            ))}
            <button
              type="button"
              onClick={toggleVoice}
              disabled={busy || isProcessing}
              className={`flex items-center gap-1.5 rounded-lg text-sm font-medium px-3 py-2 transition-all active:scale-95 ${
                isRecording
                  ? "bg-red-500 hover:bg-red-600 text-white animate-pulse shadow-md"
                  : "bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-400/50"
              }`}
              title="Speak your choice with Gnani Prisma"
            >
              {isProcessing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Mic size={14} className={isRecording ? "animate-bounce" : ""} />
              )}
              <span>{isRecording ? "Listening..." : "Voice"}</span>
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-red-400/50 hover:bg-red-400/10 disabled:opacity-40 text-red-600 dark:text-red-400 text-sm font-medium px-4 py-2 transition-colors ml-auto"
            >
              <X size={14} /> {t("common.cancel")}
            </button>
          </div>
          {isRecording && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              <span>Say your choice (e.g. &ldquo;Create New Spreadsheet&rdquo; or &ldquo;Add to Existing Spreadsheet&rdquo;) — stops automatically when you pause.</span>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={isRecording && interimTranscript ? interimTranscript : answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={isRecording ? "Listening via Gnani Prisma... Speak now" : t("pendingAction.answerPlaceholder")}
              disabled={busy || isProcessing}
              className={`flex-1 rounded-xl border bg-white/70 dark:bg-black/20 px-3.5 py-2.5 text-sm outline-none focus:ring-2 disabled:opacity-60 transition-colors ${
                isRecording
                  ? "border-amber-500 ring-2 ring-amber-400/50 bg-amber-500/10 text-amber-900 dark:text-amber-100"
                  : "border-amber-400/40 focus:ring-amber-400/50"
              }`}
            />
            <button
              type="button"
              onClick={toggleVoice}
              disabled={busy || isProcessing}
              className={`flex items-center gap-1.5 rounded-xl text-sm font-semibold px-3.5 py-2.5 transition-all shrink-0 active:scale-95 ${
                isRecording
                  ? "bg-red-500 hover:bg-red-600 text-white animate-pulse shadow-md"
                  : "bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-400/50"
              }`}
              title="Speak your answer with Gnani Prisma STT"
            >
              {isProcessing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Mic size={14} className={isRecording ? "animate-bounce" : ""} />
              )}
              <span>{isRecording ? "Listening..." : "Speak"}</span>
            </button>
            <button
              type="submit"
              disabled={!answer.trim() || busy || isProcessing}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2.5 transition-all shrink-0 active:scale-95 shadow-sm"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {busy ? t("pendingAction.resuming") : t("pendingAction.resume")}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-red-400/50 hover:bg-red-400/10 disabled:opacity-40 text-red-600 dark:text-red-400 text-sm font-medium px-4 py-2 transition-colors shrink-0"
            >
              <X size={14} /> {t("common.cancel")}
            </button>
          </div>
          {isRecording && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              <span>Gnani Prisma listening — speak naturally (e.g. &ldquo;extract full sheet&rdquo;, &ldquo;mvsviswas@gmail.com&rdquo;). Stops automatically on pause.</span>
            </div>
          )}
        </form>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  );
}
