import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Clock,
  History,
  Loader2,
  Pencil,
  PlayCircle,
  Radio,
  Trash2,
  Webhook,
  XCircle,
  Zap,
} from "lucide-react";
import Switch from "../Switch";
import RouteBadges from "./RouteBadges";
import { describeSchedule } from "../../lib/cron";

function useEventTriggerDescription(blueprint) {
  const { t } = useTranslation();
  const trigger = blueprint?.trigger || {};
  if (trigger.event_app) {
    return trigger.event_target
      ? t("agentCard.watchingFor", { app: trigger.event_app, target: trigger.event_target })
      : t("agentCard.watching", { app: trigger.event_app });
  }
  return trigger.details || t("agentCard.waitingOnEvent");
}

function useTimeAgo(isoString) {
  const { t } = useTranslation();
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t("agentCard.justNow");
  if (mins < 60) return t("agentCard.minsAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("agentCard.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("agentCard.daysAgo", { count: days });
}

function LastRunIndicator({ lastRun, loading }) {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo(lastRun?.executed_at);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
        <Loader2 size={12} className="animate-spin text-brand-500" />
        {t("agentCard.checkingLastRun")}
      </span>
    );
  }
  if (!lastRun) {
    return <span className="text-xs text-slate-400 font-medium">{t("agentCard.neverRunYet")}</span>;
  }
  const isNeedsInput = lastRun.status === "needs_input";
  const success = lastRun.status === "success";

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
        isNeedsInput
          ? "bg-brand-500/10 text-brand-600 dark:text-brand-400"
          : success
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-red-500/10 text-red-600 dark:text-red-400"
      }`}
    >
      {isNeedsInput ? <Clock size={12} /> : success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {isNeedsInput ? t("agentCard.paused") : success ? t("agentCard.success") : t("agentCard.failed")}
      {timeAgo && <span className="font-normal opacity-80">· {timeAgo}</span>}
    </span>
  );
}

export default function AgentCard({
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
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isActive = agent.status === "active";
  const isScheduled = agent.trigger_type === "scheduled";
  const isEvent = agent.trigger_type === "event_trigger";
  const eventTriggerDescription = useEventTriggerDescription(agent.json_blueprint);

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      onDelete(agent);
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3500);
    }
  };

  const TriggerIcon = isEvent ? Webhook : isScheduled ? Clock : Zap;

  return (
    <div className="glass-panel rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-3.5 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/40 transition-all shadow-sm hover:shadow-md">
      {/* Top Header Row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-xs ${
              isEvent
                ? isListening && isActive
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-2 ring-emerald-500/30"
                  : "bg-slate-200/60 dark:bg-white/10 text-slate-500"
                : isScheduled
                ? isActive
                  ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 ring-2 ring-indigo-500/30"
                  : "bg-slate-200/60 dark:bg-white/10 text-slate-500"
                : "bg-brand-500/15 text-brand-600 dark:text-brand-400"
            }`}
          >
            <TriggerIcon size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm sm:text-base tracking-tight truncate leading-tight">
              {agent.title}
            </h3>
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {isEvent ? (
                <span className="truncate">{eventTriggerDescription}</span>
              ) : (
                <span>{describeSchedule(agent.trigger_type, agent.cron_schedule)}</span>
              )}
            </div>
          </div>
        </div>

        {(isScheduled || isEvent) && (
          <div className="shrink-0 pt-0.5">
            <Switch
              checked={isActive}
              onChange={() => onToggleStatus(agent)}
              label={t("agentCard.toggleActiveLabel", { title: agent.title })}
            />
          </div>
        )}
      </div>

      {/* Prompt Summary */}
      <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
        {agent.original_prompt || agent.json_blueprint?.original_prompt || agent.title}
      </p>

      {/* Route Badges */}
      <RouteBadges blueprint={agent.json_blueprint} />

      {/* Live Event Indicator (if active event) */}
      {isEvent && isActive && (
        <div
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-xl ${
            isListening
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
          }`}
          title={!isListening ? listeningReason : undefined}
        >
          <Radio size={13} className={`shrink-0 ${isListening ? "animate-pulse" : ""}`} />
          <span className="truncate">
            {isListening ? t("agentCard.listeningLive") : t("agentCard.notListening")}
            {!isListening && listeningReason && ` · ${listeningReason}`}
          </span>
        </div>
      )}

      {/* Last Run Status */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <LastRunIndicator lastRun={lastRun} loading={lastRunLoading} />
        <span className="text-[11px] text-slate-400 font-mono">
          {(agent.json_blueprint?.steps || []).length} steps
        </span>
      </div>

      {/* Action Footer */}
      <div className="flex items-center gap-2 pt-3 border-t border-slate-200/70 dark:border-white/10">
        <button
          onClick={() => onRunNow(agent)}
          disabled={isRunning}
          title={t("agentCard.runNow")}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 active:scale-[0.98] disabled:opacity-50 text-white text-xs sm:text-sm font-semibold min-h-[44px] shadow-sm shadow-brand-500/20 transition-all touch-manipulation"
        >
          {isRunning ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
          <span>{isRunning ? t("agentCard.running") : t("agentCard.runNow")}</span>
        </button>

        <button
          onClick={() => onEdit(agent)}
          title={t("agentCard.editAgent")}
          className="flex items-center justify-center w-11 h-11 rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all shrink-0 touch-manipulation"
          aria-label={t("agentCard.editAgent")}
        >
          <Pencil size={16} />
        </button>

        <button
          onClick={() => onViewHistory(agent)}
          title={t("agentCard.viewHistory")}
          className="flex items-center justify-center w-11 h-11 rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all shrink-0 touch-manipulation"
          aria-label={t("agentCard.viewHistory")}
        >
          <History size={16} />
        </button>

        <button
          onClick={handleDeleteClick}
          title={confirmingDelete ? t("agentCard.confirmDelete") : t("agentCard.deleteAgent")}
          className={`flex items-center justify-center h-11 rounded-xl border transition-all shrink-0 touch-manipulation active:scale-95 ${
            confirmingDelete
              ? "px-3 border-red-400 bg-red-500 text-white text-xs font-semibold animate-pulse"
              : "w-11 border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-red-500 hover:bg-red-500/10"
          }`}
          aria-label={confirmingDelete ? t("agentCard.confirmDelete") : t("agentCard.deleteAgent")}
        >
          {confirmingDelete ? (
            <span className="flex items-center gap-1">
              <Trash2 size={15} />
              <span>Del?</span>
            </span>
          ) : (
            <Trash2 size={16} />
          )}
        </button>
      </div>
    </div>
  );
}
