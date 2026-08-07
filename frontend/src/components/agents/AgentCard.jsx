import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Clock, History, Loader2, Pencil, PlayCircle, Radio, Trash2, XCircle } from "lucide-react";
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
        <Loader2 size={12} className="animate-spin" />
        {t("agentCard.checkingLastRun")}
      </span>
    );
  }
  if (!lastRun) {
    return <span className="text-xs text-slate-400">{t("agentCard.neverRunYet")}</span>;
  }
  const isNeedsInput = lastRun.status === "needs_input";
  const success = lastRun.status === "success";

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
        isNeedsInput
          ? "text-brand-500 dark:text-brand-400"
          : success
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-500 dark:text-red-400"
      }`}
    >
      {isNeedsInput ? <Clock size={13} /> : success ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {isNeedsInput ? t("agentCard.paused") : success ? t("agentCard.success") : t("agentCard.failed")} · {timeAgo}
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
      setTimeout(() => setConfirmingDelete(false), 3000);
    }
  };

  return (
    <div className="glass-panel p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold truncate">{agent.title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{agent.original_prompt}</p>
        </div>
        {(isScheduled || isEvent) && (
          <Switch
            checked={isActive}
            onChange={() => onToggleStatus(agent)}
            label={t("agentCard.toggleActiveLabel", { title: agent.title })}
          />
        )}
      </div>

      <RouteBadges blueprint={agent.json_blueprint} />

      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Clock size={13} />
        {isEvent ? eventTriggerDescription : describeSchedule(agent.trigger_type, agent.cron_schedule)}
      </div>

      {isEvent && isActive && (
        <span
          className={`inline-flex items-start gap-1.5 text-xs font-medium ${
            isListening ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
          }`}
          title={!isListening ? listeningReason : undefined}
        >
          <Radio size={12} className={`shrink-0 mt-0.5 ${isListening ? "animate-pulse" : ""}`} />
          <span>
            {isListening ? t("agentCard.listeningLive") : t("agentCard.notListening")}
            {!isListening && listeningReason && (
              <span className="block text-[11px] font-normal text-amber-600/80 dark:text-amber-400/80 mt-0.5">
                {listeningReason}
              </span>
            )}
          </span>
        </span>
      )}

      <LastRunIndicator lastRun={lastRun} loading={lastRunLoading} />

      <div className="flex items-center gap-1.5 mt-1 pt-3 border-t border-slate-200/70 dark:border-white/10">
        <button
          onClick={() => onRunNow(agent)}
          disabled={isRunning}
          title={t("agentCard.runNow")}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-xs font-medium py-2 transition-colors"
        >
          {isRunning ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
          {isRunning ? t("agentCard.running") : t("agentCard.runNow")}
        </button>
        <button
          onClick={() => onEdit(agent)}
          title={t("agentCard.editAgent")}
          className="flex items-center justify-center w-9 h-9 rounded-lg border border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors shrink-0"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => onViewHistory(agent)}
          title={t("agentCard.viewHistory")}
          className="flex items-center justify-center w-9 h-9 rounded-lg border border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors shrink-0"
        >
          <History size={14} />
        </button>
        <button
          onClick={handleDeleteClick}
          title={confirmingDelete ? t("agentCard.confirmDelete") : t("agentCard.deleteAgent")}
          className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors shrink-0 ${
            confirmingDelete
              ? "border-red-400 bg-red-500 text-white"
              : "border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-red-500 hover:bg-red-500/10"
          }`}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
