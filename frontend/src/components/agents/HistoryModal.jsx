import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ChevronDown,
  CheckCircle2,
  Clock,
  HelpCircle,
  ImageIcon,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { getAgentLogs } from "../../api/agents";

const PAGE_SIZE = 10;

function formatRunTimestamp(iso, unknownLabel) {
  if (!iso) return unknownLabel;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatStepTimestamp(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stepStatus(entry) {
  const status = entry.result?.status;
  if (status === "error") return "failed";
  if (status === "needs_input") return "needs_input";
  return "success";
}

const STEP_STATUS_CONFIG = {
  success: { icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400" },
  failed: { icon: XCircle, color: "text-red-500 dark:text-red-400" },
  needs_input: { icon: HelpCircle, color: "text-amber-600 dark:text-amber-400" },
};

function StepChip({ entry }) {
  const { t } = useTranslation();
  const status = stepStatus(entry);
  const { icon: Icon, color } = STEP_STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-900/5 dark:bg-white/5 ${color}`}>
      <Icon size={11} />
      {t("history.step", { number: entry.step })}
    </span>
  );
}

function StepDetail({ entry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const status = stepStatus(entry);
  const { icon: Icon, color } = STEP_STATUS_CONFIG[status];
  const time = formatStepTimestamp(entry.at);

  const summary =
    status === "needs_input"
      ? entry.result?.question
      : status === "failed"
        ? entry.result?.error || entry.result?.message
        : null;
  const raw = JSON.stringify(entry.result, null, 2);

  return (
    <div className="rounded-lg border border-slate-200/60 dark:border-white/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
          <Icon size={13} className="shrink-0" />
          <span>
            {t("history.step", { number: entry.step })}
            {entry.action ? `: ${entry.action}` : ""}
            {entry.app ? ` on ${entry.app}` : ""}
          </span>
        </div>
        {time && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 shrink-0">
            <Clock size={11} />
            {time}
          </span>
        )}
      </div>

      {summary && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">{summary}</p>}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 text-[11px] text-brand-500 hover:text-brand-600 transition-colors"
      >
        {expanded ? t("history.hideRawOutput") : t("history.showRawOutput")}
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-slate-900/5 dark:bg-black/30 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          {raw}
        </pre>
      )}
    </div>
  );
}

function RunRow({ run, defaultOpen, onOpenScreenshot }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const success = run.status === "success";
  const needsInput = run.status === "needs_input";
  const steps = Array.isArray(run.log_messages) ? run.log_messages : [];

  return (
    <div className="rounded-xl border border-slate-200/70 dark:border-white/10 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 flex-wrap p-4 text-left hover:bg-slate-900/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center gap-1.5 text-sm font-medium ${
              success ? "text-emerald-600 dark:text-emerald-400" : needsInput ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400"
            }`}
          >
            {success ? <CheckCircle2 size={15} /> : needsInput ? <HelpCircle size={15} /> : <XCircle size={15} />}
            {success ? t("history.success") : needsInput ? t("history.needsInput") : t("history.failed")}
          </span>
          <span className="text-xs text-slate-400">{formatRunTimestamp(run.executed_at, t("history.unknownTime"))}</span>
          {steps.length > 0 && (
            <span className="text-xs text-slate-400">
              · {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!open && steps.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {steps.map((entry, i) => (
                <StepChip key={i} entry={entry} />
              ))}
            </div>
          )}
          <ChevronDown size={16} className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2 border-t border-slate-200/70 dark:border-white/10 pt-3">
          {steps.length === 0 ? (
            <p className="text-xs text-slate-400">{t("history.noStepDetail")}</p>
          ) : (
            steps.map((entry, i) => <StepDetail key={i} entry={entry} />)
          )}

          {run.proof_screenshot_url && (
            <button
              onClick={() => onOpenScreenshot(run.proof_screenshot_url)}
              className="mt-1 flex items-center gap-1.5 text-xs text-brand-500 hover:text-brand-600 transition-colors self-start"
            >
              <ImageIcon size={13} />
              {t("history.viewScreenshot")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function HistoryModal({ agent, onClose }) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);

  useEffect(() => {
    if (!agent) return;
    setLogs([]);
    setError(null);
    setLoading(true);
    getAgentLogs(agent.id, { limit: PAGE_SIZE, offset: 0 })
      .then((res) => {
        setLogs(res?.logs || []);
        setTotal(res?.total ?? (res?.logs || []).length);
        setHasMore(Boolean(res?.has_more));
      })
      .catch((err) => setError(err.message || t("history.loadFailed")))
      .finally(() => setLoading(false));
  }, [agent]);

  const handleLoadMore = () => {
    if (!agent || loadingMore) return;
    setLoadingMore(true);
    getAgentLogs(agent.id, { limit: PAGE_SIZE, offset: logs.length })
      .then((res) => {
        setLogs((prev) => [...prev, ...(res?.logs || [])]);
        setHasMore(Boolean(res?.has_more));
      })
      .catch((err) => setError(err.message || t("history.loadMoreFailed")))
      .finally(() => setLoadingMore(false));
  };

  if (!agent) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative glass-panel w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 h-16 border-b border-slate-200/70 dark:border-white/10 shrink-0">
          <div>
            <h2 className="font-semibold">{t("history.title")}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {agent.title}
              {total > 0 && ` · ${total} run${total === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("history.close")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 text-sm text-slate-400 py-10">
              <Loader2 size={16} className="animate-spin" />
              {t("history.loading")}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          {!loading && !error && logs.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-10">{t("history.noRuns")}</p>
          )}

          {logs.map((run, i) => (
            <RunRow key={run.id} run={run} defaultOpen={i === 0} onOpenScreenshot={setLightboxUrl} />
          ))}

          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-slate-300/70 dark:border-white/15 text-sm font-medium py-2.5 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 transition-colors"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              {loadingMore ? t("history.loadingMore") : t("history.loadOlder")}
            </button>
          )}
        </div>
      </div>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/80"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt={t("history.viewScreenshot")}
            className="max-w-full max-h-full rounded-xl shadow-2xl"
          />
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-6 right-6 flex items-center justify-center w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            aria-label={t("history.closeScreenshot")}
          >
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
