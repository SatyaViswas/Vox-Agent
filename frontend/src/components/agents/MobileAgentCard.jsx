import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  MoreVertical,
  Pencil,
  PlayCircle,
  Radio,
  Trash2,
  Webhook,
  XCircle,
  Zap,
} from "lucide-react";
import Switch from "../Switch";
import { describeSchedule } from "../../lib/cron";
import RouteBadges from "./RouteBadges";

function useTimeAgo(isoString) {
  const { t } = useTranslation();
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t("agentCard.justNow") || "Just now";
  if (mins < 60) return t("agentCard.minsAgo", { count: mins }) || `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("agentCard.hoursAgo", { count: hours }) || `${hours}h ago`;
  const days = Math.round(hours / 24);
  return t("agentCard.daysAgo", { count: days }) || `${days}d ago`;
}

function MobileLastRunPill({ lastRun, loading }) {
  const timeAgo = useTimeAgo(lastRun?.executed_at);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
        <Loader2 size={11} className="animate-spin text-brand-500" />
        <span>Checking...</span>
      </span>
    );
  }
  if (!lastRun) {
    return <span className="text-[11px] text-slate-400 font-medium">Never run yet</span>;
  }
  const isNeedsInput = lastRun.status === "needs_input";
  const success = lastRun.status === "success";

  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        isNeedsInput
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
          : success
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
          : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
      }`}
    >
      {isNeedsInput ? <Clock size={11} /> : success ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      <span>{isNeedsInput ? "Waiting Input" : success ? "Success" : "Failed"}</span>
      {timeAgo && <span className="font-normal opacity-75">· {timeAgo}</span>}
    </span>
  );
}

export default function MobileAgentCard({
  agent,
  lastRun,
  lastRunLoading,
  isRunning,
  isListening,
  listeningReason,
  onToggleStatus,
  onRunNow,
  onEdit,
  onViewHistory,
  onDelete,
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = agent.status === "active";
  const isScheduled = agent.trigger_type === "scheduled";
  const isEvent = agent.trigger_type === "event_trigger";
  const steps = agent.json_blueprint?.steps || [];

  const TriggerIcon = isEvent ? Webhook : isScheduled ? Clock : Zap;

  const handleDelete = () => {
    if (confirmingDelete) {
      onDelete(agent);
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3500);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-4 border border-slate-200/80 dark:border-white/10 shadow-sm flex flex-col justify-between gap-3 transition-all active:scale-[0.99] touch-manipulation">
      {/* 1. Header Row */}
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-start gap-2.5 min-w-0">
          {/* Avatar Icon */}
          <div
            className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 shadow-sm ${
              isEvent
                ? isListening && isActive
                  ? "bg-emerald-500 text-white shadow-emerald-500/20 ring-4 ring-emerald-400/20"
                  : "bg-slate-200 dark:bg-white/10 text-slate-500"
                : isScheduled
                ? isActive
                  ? "bg-indigo-500 text-white shadow-indigo-500/20 ring-4 ring-indigo-400/20"
                  : "bg-slate-200 dark:bg-white/10 text-slate-500"
                : "bg-gradient-to-tr from-brand-600 to-fuchsia-600 text-white shadow-brand-500/20 ring-4 ring-brand-400/20"
            }`}
          >
            <TriggerIcon size={18} />
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-sm text-slate-900 dark:text-white truncate leading-snug">
              {agent.title}
            </h3>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {isEvent ? (
                <span className="truncate flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                  <Radio size={10} className={isListening ? "animate-pulse" : ""} />
                  {isListening ? "Listening Live" : "Event Trigger"}
                </span>
              ) : isScheduled ? (
                <span className="truncate text-indigo-600 dark:text-indigo-400 font-medium">
                  {describeSchedule(agent.trigger_type, agent.cron_schedule)}
                </span>
              ) : (
                <span className="truncate text-brand-600 dark:text-brand-400 font-medium">
                  On-Demand Execution
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Toggle Switch for Scheduled / Event Agents */}
        {(isScheduled || isEvent) && (
          <div className="shrink-0 pt-0.5">
            <Switch
              checked={isActive}
              onChange={() => onToggleStatus(agent)}
              label={`Toggle ${agent.title}`}
            />
          </div>
        )}
      </div>

      {/* 2. Prompt Description */}
      {(agent.original_prompt || agent.json_blueprint?.original_prompt || agent.title) && (
        <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
          {agent.original_prompt || agent.json_blueprint?.original_prompt || agent.title}
        </p>
      )}

      {/* 3. Route Badges / App Pipeline Flow */}
      <div className="py-0.5">
        <RouteBadges blueprint={agent.json_blueprint} />
      </div>

      {/* 4. Last Run & Step Info */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-white/5">
        <MobileLastRunPill lastRun={lastRun} loading={lastRunLoading} />
        <span className="text-[11px] font-mono text-slate-400">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
        </span>
      </div>

      {/* 5. Mobile Action Buttons */}
      <div className="flex items-center gap-2 pt-1">
        {/* Primary CTA Run Button */}
        <button
          type="button"
          onClick={() => onRunNow(agent)}
          disabled={isRunning}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 disabled:opacity-50 text-white font-bold text-xs shadow-md shadow-brand-500/20 active:scale-[0.98] transition-all"
        >
          {isRunning ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <PlayCircle size={15} />
          )}
          <span>{isRunning ? "Running..." : "Run Workflow"}</span>
        </button>

        {/* View History */}
        <button
          type="button"
          onClick={() => onViewHistory(agent)}
          className="flex items-center justify-center w-11 h-11 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:text-brand-500 active:scale-95 transition-all shrink-0"
          aria-label="View history"
          title="Run history"
        >
          <History size={16} />
        </button>

        {/* Edit */}
        <button
          type="button"
          onClick={() => onEdit(agent)}
          className="flex items-center justify-center w-11 h-11 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:text-brand-500 active:scale-95 transition-all shrink-0"
          aria-label="Edit agent"
          title="Edit agent"
        >
          <Pencil size={16} />
        </button>

        {/* Delete */}
        <button
          type="button"
          onClick={handleDelete}
          className={`flex items-center justify-center h-11 rounded-xl transition-all shrink-0 active:scale-95 ${
            confirmingDelete
              ? "px-3 bg-red-500 text-white text-xs font-bold animate-pulse shadow-md"
              : "w-11 bg-slate-100 dark:bg-white/5 text-slate-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20"
          }`}
          aria-label="Delete agent"
          title="Delete agent"
        >
          {confirmingDelete ? <span>Del?</span> : <Trash2 size={16} />}
        </button>
      </div>
    </div>
  );
}

