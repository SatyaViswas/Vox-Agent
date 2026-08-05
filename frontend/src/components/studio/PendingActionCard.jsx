import { useState } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, Send, X } from "lucide-react";
import { Link } from "react-router-dom";

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
  options,
  busy,
  error,
  onResume,
  onApprove,
  onReject,
}) {
  const [answer, setAnswer] = useState("");
  const { text, json } = splitJsonPreview(question);

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
        Needs your input to continue
      </div>
      <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mb-3 whitespace-pre-wrap">{text}</p>

      {json && (
        <div className="mb-3 bg-slate-900/5 dark:bg-black/20 p-2 rounded-lg text-xs font-mono text-slate-600 dark:text-slate-300 overflow-x-auto">
          <pre>{JSON.stringify(json, null, 2)}</pre>
        </div>
      )}

      {reconnectApp ? (
        // A reconnect-type pause (see composio_engine.execute_composio_action)
        // doesn't need a real answer to resolve — retrying after the app is
        // reconnected elsewhere (App Vault) is what actually fixes it.
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/vault"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium px-4 py-2 transition-colors"
          >
            Connect {reconnectApp} in App Vault <ExternalLink size={13} />
          </Link>
          <button
            onClick={handleRetry}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {busy ? "Retrying…" : "I've reconnected it — retry"}
          </button>
        </div>
      ) : inputType === "confirm" ? (
        // The sensitive-action approval gate — a real typed decision, not a
        // magic "Approved"/"Rejected" string piped through the answer box.
        <div className="flex gap-2">
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Approve
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            Reject
          </button>
        </div>
      ) : inputType === "select" && options?.length ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => onResume(opt)}
              disabled={busy}
              className="rounded-lg border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
            disabled={busy}
            className="flex-1 rounded-lg border border-amber-400/40 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/50 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!answer.trim() || busy}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors shrink-0"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {busy ? "Resuming…" : "Resume"}
          </button>
        </form>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  );
}
