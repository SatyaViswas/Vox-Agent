import { useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, Send } from "lucide-react";
import { Link } from "react-router-dom";

export default function LiveClarificationPanel({ question, step, reconnectApp, onResume, resuming, error }) {
  const [answer, setAnswer] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!answer.trim() || resuming) return;
    onResume(answer.trim());
  };

  // A reconnect-type pause (see composio_engine.execute_composio_action)
  // doesn't need a real answer to resolve — retrying after the app is
  // reconnected elsewhere (App Vault) is what actually fixes it, so the
  // text box is just a "type anything to retry" affordance alongside a
  // direct link to go reconnect it.
  const handleRetry = () => {
    if (resuming) return;
    onResume("reconnected");
  };

  return (
    <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 md:p-5 shadow-[0_0_30px_rgba(245,158,11,0.08)]">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium text-sm mb-1">
        <AlertTriangle size={16} className="shrink-0" />
        Agent paused mid-run — it needs your input to continue
      </div>
      <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mb-3">
        {question || `Step ${step} came back with a question instead of a completed result.`}
      </p>

      {reconnectApp ? (
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
            disabled={resuming}
            className="flex items-center gap-1.5 rounded-lg border border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-40 text-amber-700 dark:text-amber-300 text-sm font-medium px-4 py-2 transition-colors"
          >
            {resuming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {resuming ? "Retrying…" : `I've reconnected it — retry`}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
            disabled={resuming}
            className="flex-1 rounded-lg border border-amber-400/40 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/50 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!answer.trim() || resuming}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors shrink-0"
          >
            {resuming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {resuming ? "Resuming…" : "Resume"}
          </button>
        </form>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  );
}
