import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, Clock, Loader2, Plus, Webhook, Zap } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  deleteAgent,
  executeAgent,
  getAgentLogs,
  getAgents,
  getTriggerStatus,
  updateAgent,
  updateAgentSchedule,
} from "../api/agents";
import AgentCard from "../components/agents/AgentCard";
import EditAgentDrawer from "../components/agents/EditAgentDrawer";
import HistoryModal from "../components/agents/HistoryModal";

const TAB_DEFS = [
  { id: "on-demand", labelKey: "myAgents.onDemand", icon: Zap },
  { id: "scheduled", labelKey: "myAgents.scheduled", icon: Clock },
  { id: "event", labelKey: "myAgents.eventTriggers", icon: Webhook },
];

const STATUS_FILTERS = ["all", "active", "paused"];

function matchesAgent(agent, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const apps = (agent.json_blueprint?.steps || []).map((s) => s.app).join(" ");
  return (
    agent.title?.toLowerCase().includes(q) ||
    agent.original_prompt?.toLowerCase().includes(q) ||
    apps.toLowerCase().includes(q)
  );
}

export default function MyAgents() {
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { t } = useTranslation();

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [activeTab, setActiveTab] = useState("on-demand");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [lastRuns, setLastRuns] = useState({});
  const [lastRunsLoading, setLastRunsLoading] = useState(false);
  const [runningIds, setRunningIds] = useState(new Set());
  const [actionError, setActionError] = useState(null);

  const [editingAgent, setEditingAgent] = useState(null);
  const [historyAgent, setHistoryAgent] = useState(null);

  const [listeningStatus, setListeningStatus] = useState({});

  const fetchLastRuns = useCallback((list) => {
    if (list.length === 0) return;
    setLastRunsLoading(true);
    Promise.all(
      list.map((a) =>
        getAgentLogs(a.id)
          .then((res) => [a.id, res?.logs?.[0] || null])
          .catch(() => [a.id, null])
      )
    ).then((pairs) => {
      setLastRuns(Object.fromEntries(pairs));
      setLastRunsLoading(false);
    });
  }, []);

  const fetchTriggerStatuses = useCallback((list) => {
    const eventAgents = list.filter((a) => a.trigger_type === "event_trigger");
    if (eventAgents.length === 0) return;
    Promise.all(
      eventAgents.map((a) =>
        getTriggerStatus(a.id)
          .then((res) => [a.id, { listening: !!res?.listening, reason: res?.reason || null }])
          .catch(() => [a.id, { listening: false, reason: null }])
      )
    ).then((pairs) => {
      setListeningStatus((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
  }, []);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getAgents(userId);
      const list = res?.agents || [];
      setAgents(list);
      fetchLastRuns(list);
      fetchTriggerStatuses(list);
    } catch (err) {
      setLoadError(err.message || t("myAgents.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [userId, fetchLastRuns, fetchTriggerStatuses]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    const hasEventAgents = agents.some((a) => a.trigger_type === "event_trigger");
    if (!hasEventAgents) return;
    const interval = setInterval(() => fetchTriggerStatuses(agents), 15000);
    return () => clearInterval(interval);
  }, [agents, fetchTriggerStatuses]);

  const filteredAgents = useMemo(
    () =>
      agents.filter((a) => {
        const matchesTab =
          activeTab === "scheduled"
            ? a.trigger_type === "scheduled"
            : activeTab === "event"
              ? a.trigger_type === "event_trigger"
              : a.trigger_type !== "scheduled" && a.trigger_type !== "event_trigger";
        return matchesTab && (statusFilter === "all" || a.status === statusFilter) && matchesAgent(a, search);
      }),
    [agents, activeTab, statusFilter, search]
  );

  const handleToggleStatus = async (agent) => {
    const nextStatus = agent.status === "active" ? "paused" : "active";
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, status: nextStatus } : a)));
    setActionError(null);
    try {
      await updateAgentSchedule(agent.id, {
        triggerType: agent.trigger_type,
        cronSchedule: agent.cron_schedule,
        status: nextStatus,
      });
      if (agent.trigger_type === "event_trigger") {
        setTimeout(() => fetchTriggerStatuses([agent]), 1500);
      }
    } catch (err) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, status: agent.status } : a)));
      setActionError(err.message || t("myAgents.statusFailed"));
    }
  };

  const handleRunNow = async (agent) => {
    setRunningIds((prev) => new Set(prev).add(agent.id));
    setActionError(null);
    try {
      await executeAgent(agent.id, userId);
      setTimeout(() => fetchLastRuns([agent]), 4000);
    } catch (err) {
      setActionError(err.message || t("myAgents.runFailed"));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(agent.id);
        return next;
      });
    }
  };

  const handleDelete = async (agent) => {
    const prevAgents = agents;
    setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    setActionError(null);
    try {
      await deleteAgent(agent.id);
    } catch (err) {
      setAgents(prevAgents);
      setActionError(err.message || t("myAgents.deleteFailed"));
    }
  };

  const handleSaveEdit = async (payload) => {
    await updateAgent(editingAgent.id, payload);
    setAgents((prev) => prev.map((a) => (a.id === editingAgent.id ? { ...a, ...payload } : a)));
    setEditingAgent(null);
  };

  return (
    <div className="flex flex-col gap-5 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("myAgents.title")}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t("myAgents.subtitle")}</p>
        </div>
        <button
          onClick={() => navigate("/studio")}
          className="flex items-center gap-1.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5 transition-colors"
        >
          <Plus size={16} />
          {t("myAgents.newAgent")}
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex glass-panel p-1 gap-1 w-fit">
          {TAB_DEFS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === id
                  ? "bg-brand-500 text-white"
                  : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
              }`}
            >
              <Icon size={15} />
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("myAgents.searchPlaceholder")}
            className="rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 w-56"
          />
          <div className="inline-flex glass-panel p-1 gap-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  statusFilter === s
                    ? "bg-brand-500 text-white"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
              >
                {t(`common.${s}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={16} className="shrink-0" />
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="glass-panel p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t("myAgents.loadingAgents")}
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={16} className="shrink-0" />
          {loadError}
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          {t("myAgents.noAgents")}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              lastRun={lastRuns[agent.id]}
              lastRunLoading={lastRunsLoading && !(agent.id in lastRuns)}
              isRunning={runningIds.has(agent.id)}
              isListening={listeningStatus[agent.id]?.listening}
              listeningReason={listeningStatus[agent.id]?.reason}
              onToggleStatus={handleToggleStatus}
              onRunNow={handleRunNow}
              onEdit={setEditingAgent}
              onViewHistory={setHistoryAgent}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <EditAgentDrawer agent={editingAgent} onClose={() => setEditingAgent(null)} onSave={handleSaveEdit} />
      <HistoryModal agent={historyAgent} onClose={() => setHistoryAgent(null)} />
    </div>
  );
}
