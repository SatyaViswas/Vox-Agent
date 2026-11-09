import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Clock,
  Loader2,
  Mic,
  Plus,
  Radio,
  Search,
  Sparkles,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import useSpeechRecognition from "../hooks/useSpeechRecognition";
import {
  deleteAgent,
  executeAgent,
  getAgentLogs,
  getAgents,
  getTriggerStatus,
  updateAgent,
  updateAgentSchedule,
} from "../api/agents";
import { useNotificationStore } from "../store/notificationStore";
import AgentCard from "../components/agents/AgentCard";
import EditAgentDrawer from "../components/agents/EditAgentDrawer";
import HistoryModal from "../components/agents/HistoryModal";
import MobileAgentCard from "../components/agents/MobileAgentCard";
import MobileAgentsControls from "../components/agents/MobileAgentsControls";

const TAB_DEFS = [
  { id: "on-demand", labelKey: "myAgents.onDemand", icon: Zap },
  { id: "scheduled", labelKey: "myAgents.scheduled", icon: Clock },
  { id: "event", labelKey: "myAgents.eventTriggers", icon: Webhook },
];

const STATUS_FILTERS = ["all", "active", "paused"];

function matchesAgent(agent, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
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

  // Tracking refs to ensure zero duplicate notifications and single-flight execution polling
  const activeTrackingRef = useRef(new Set());
  const pollTimeoutsRef = useRef({});
  const notifiedRunIdsRef = useRef(new Set());

  useEffect(() => {
    return () => {
      Object.values(pollTimeoutsRef.current).forEach((t) => clearTimeout(t));
      activeTrackingRef.current.clear();
    };
  }, []);

  // Voice Search with Gnani Prisma
  const {
    isRecording: isVoiceSearching,
    isProcessing: isVoiceProcessing,
    interimTranscript,
    toggle: toggleVoiceSearch,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      const clean = (text || "").trim();
      if (!clean) return;

      const lower = clean.toLowerCase();
      // Intelligent voice command routing
      if (lower.includes("show active") || lower === "active") {
        setStatusFilter("active");
        return;
      }
      if (lower.includes("show paused") || lower === "paused") {
        setStatusFilter("paused");
        return;
      }
      if (lower.includes("show all") || lower === "all") {
        setStatusFilter("all");
        return;
      }
      if (lower.includes("scheduled") || lower.includes("cron")) {
        setActiveTab("scheduled");
        return;
      }
      if (lower.includes("event") || lower.includes("webhook")) {
        setActiveTab("event");
        return;
      }
      if (lower.includes("on demand") || lower.includes("manual")) {
        setActiveTab("on-demand");
        return;
      }
      if (lower.includes("new agent") || lower.includes("create agent")) {
        navigate("/studio");
        return;
      }

      setSearch(clean);
    },
  });

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
  }, [userId, fetchLastRuns, fetchTriggerStatuses, t]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    const hasEventAgents = agents.some((a) => a.trigger_type === "event_trigger");
    if (!hasEventAgents) return;
    const interval = setInterval(() => fetchTriggerStatuses(agents), 15000);
    return () => clearInterval(interval);
  }, [agents, fetchTriggerStatuses]);

  // Tab counts
  const tabCounts = useMemo(() => {
    return {
      "on-demand": agents.filter(
        (a) => a.trigger_type !== "scheduled" && a.trigger_type !== "event_trigger"
      ).length,
      scheduled: agents.filter((a) => a.trigger_type === "scheduled").length,
      event: agents.filter((a) => a.trigger_type === "event_trigger").length,
    };
  }, [agents]);

  // Status counts for active tab
  const statusCounts = useMemo(() => {
    const tabAgents = agents.filter((a) =>
      activeTab === "scheduled"
        ? a.trigger_type === "scheduled"
        : activeTab === "event"
        ? a.trigger_type === "event_trigger"
        : a.trigger_type !== "scheduled" && a.trigger_type !== "event_trigger"
    );
    return {
      all: tabAgents.length,
      active: tabAgents.filter((a) => a.status === "active").length,
      paused: tabAgents.filter((a) => a.status === "paused").length,
    };
  }, [agents, activeTab]);

  const filteredAgents = useMemo(
    () =>
      agents.filter((a) => {
        const matchesTab =
          activeTab === "scheduled"
            ? a.trigger_type === "scheduled"
            : activeTab === "event"
            ? a.trigger_type === "event_trigger"
            : a.trigger_type !== "scheduled" && a.trigger_type !== "event_trigger";
        return (
          matchesTab &&
          (statusFilter === "all" || a.status === statusFilter) &&
          matchesAgent(a, search)
        );
      }),
    [agents, activeTab, statusFilter, search]
  );

  const handleToggleStatus = async (agent) => {
    const currentStatus = agent.status || "active";
    const nextStatus = currentStatus === "active" ? "paused" : "active";

    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, status: nextStatus } : a)));
    setActionError(null);
    try {
      await updateAgentSchedule(agent.id, {
        triggerType: agent.trigger_type || "scheduled",
        cronSchedule: agent.cron_schedule || null,
        status: nextStatus,
      });
      if (agent.trigger_type === "event_trigger") {
        setTimeout(() => fetchTriggerStatuses([agent]), 1500);
      }
    } catch (err) {
      console.error("Failed to toggle agent status:", err);
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, status: currentStatus } : a)));
      setActionError(err.message || t("myAgents.statusFailed"));
    }
  };

  const handleRunNow = async (agent) => {
    if (!agent?.id) return;

    // Strict single-flight guard: prevent duplicate runs or polls for the same agent
    if (runningIds.has(agent.id) || activeTrackingRef.current.has(agent.id)) {
      return;
    }

    setRunningIds((prev) => new Set(prev).add(agent.id));
    activeTrackingRef.current.add(agent.id);
    setActionError(null);

    // Save previous latest log before starting to ensure we only notify on the NEW run
    const priorLog = lastRuns[agent.id];
    const priorLogId = priorLog?.id || null;
    const startTime = Date.now();

    try {
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }

      await executeAgent(agent.id, userId);

      // Cancel any existing poll timeout for this agent
      if (pollTimeoutsRef.current[agent.id]) {
        clearTimeout(pollTimeoutsRef.current[agent.id]);
        delete pollTimeoutsRef.current[agent.id];
      }

      let isFinished = false;
      let attempts = 0;

      // Sequential async poll loop (guarantees zero concurrent tick races)
      const pollLogs = async () => {
        if (isFinished) return;
        attempts++;

        try {
          const res = await getAgentLogs(agent.id);
          if (isFinished) return;

          const rows = res?.logs || [];
          if (rows.length > 0) {
            const latest = rows[0];
            const logExecutedAt = latest.executed_at ? new Date(latest.executed_at).getTime() : 0;

            // Strict New Run Verification:
            // 1. Must not have already notified this exact log ID
            // 2. If priorLogId existed, latest.id must be different
            // 3. Its executed_at timestamp must be >= startTime - 4000ms (or after attempts >= 2)
            const alreadyNotified = latest.id && notifiedRunIdsRef.current.has(latest.id);
            const isDifferentFromPrior = priorLogId ? latest.id !== priorLogId : true;
            const isTimely = logExecutedAt > 0 ? logExecutedAt >= startTime - 4000 : attempts >= 2;

            if (!alreadyNotified && isDifferentFromPrior && isTimely) {
              if (latest.status === "success" || latest.status === "failed") {
                isFinished = true;
                if (latest.id) {
                  notifiedRunIdsRef.current.add(latest.id);
                }
                activeTrackingRef.current.delete(agent.id);
                delete pollTimeoutsRef.current[agent.id];

                fetchLastRuns([agent]);
                const isSuccess = latest.status === "success";
                const agentTitle = agent.title || "Workflow";

                const logEntries = Array.isArray(latest.log_messages) ? latest.log_messages : [];
                const skippedSteps = logEntries
                  .filter((e) => e.result?.status === "skipped" && e.step != null)
                  .map((e) => e.step);

                let notifMessage = `Workflow "${agentTitle}" executed successfully!`;
                let spokenMsg = `Notification: Workflow ${agentTitle} completed successfully.`;

                if (!isSuccess) {
                  notifMessage = `Workflow "${agentTitle}" encountered an error during execution.`;
                  spokenMsg = `Notification: Workflow ${agentTitle} failed.`;
                } else if (skippedSteps.length > 0) {
                  const skippedStr = skippedSteps.join(", ");
                  notifMessage = `Workflow "${agentTitle}" completed with step ${skippedStr} skipped.`;
                  spokenMsg = `Notification: Workflow ${agentTitle} completed. Step ${skippedStr} was skipped as condition was not met.`;
                }

                useNotificationStore.getState().addNotification({
                  dedupKey: `run_${agent.id}_${latest.id || logExecutedAt || Date.now()}`,
                  agentId: agent.id,
                  title: agentTitle,
                  status: isSuccess ? "success" : "failed",
                  message: notifMessage,
                  spokenMessage: spokenMsg,
                });
                return;
              }
            }
          }
        } catch {
          // ignore transient poll error
        }

        if (!isFinished) {
          if (attempts < 30) {
            pollTimeoutsRef.current[agent.id] = setTimeout(pollLogs, 2000);
          } else {
            isFinished = true;
            activeTrackingRef.current.delete(agent.id);
            delete pollTimeoutsRef.current[agent.id];
            fetchLastRuns([agent]);
          }
        }
      };

      // Initial poll after 1.5s
      pollTimeoutsRef.current[agent.id] = setTimeout(pollLogs, 1500);
    } catch (err) {
      activeTrackingRef.current.delete(agent.id);
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
    <div className="flex flex-col gap-3.5 sm:gap-4 max-w-6xl mx-auto pb-12 sm:pb-0">
      {/* 1. Mobile-Native Header & Segmented Controls (< sm) */}
      <div className="sm:hidden">
        <MobileAgentsControls
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          tabCounts={tabCounts}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          statusCounts={statusCounts}
          search={search}
          setSearch={setSearch}
          isVoiceSearching={isVoiceSearching}
          isVoiceProcessing={isVoiceProcessing}
          interimTranscript={interimTranscript}
          toggleVoiceSearch={toggleVoiceSearch}
          onNewAgent={() => navigate("/studio")}
          totalAgentsCount={agents.length}
        />
      </div>

      {/* 2. Desktop Controls (>= sm) */}
      <div className="hidden sm:flex flex-col gap-4">
        {/* Top Header - Quick Action Banner */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{t("myAgents.title")}</h1>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                {agents.length}
              </span>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {t("myAgents.subtitle")}
            </p>
          </div>

          <button
            onClick={() => navigate("/studio")}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 active:scale-95 text-white text-sm font-semibold px-4 py-2.5 shadow-sm shadow-brand-500/25 transition-all touch-manipulation min-h-[42px]"
          >
            <Plus size={16} />
            <span>{t("myAgents.newAgent")}</span>
          </button>
        </div>

        {/* Voice Search Bar & Controls */}
        <div className="flex flex-col gap-3">
          <div className="relative flex items-center w-full">
            <Search size={18} className="absolute left-3.5 text-slate-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isVoiceSearching
                  ? interimTranscript || "Listening for agent name or command..."
                  : t("myAgents.searchPlaceholder")
              }
              className={`w-full rounded-2xl border bg-white/70 dark:bg-black/20 pl-10 pr-24 py-3 text-sm outline-none transition-all shadow-xs ${
                isVoiceSearching
                  ? "border-emerald-500 ring-2 ring-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : "border-slate-300/70 dark:border-white/15 focus:ring-2 focus:ring-brand-400/50"
              }`}
            />
            <div className="absolute right-2 flex items-center gap-1">
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 active:scale-95 transition-all"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
              <button
                onClick={() => toggleVoiceSearch()}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all active:scale-95 ${
                  isVoiceSearching
                    ? "bg-emerald-500 text-white animate-pulse shadow-sm shadow-emerald-500/40"
                    : isVoiceProcessing
                    ? "bg-brand-500/20 text-brand-500"
                    : "text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
                title="Voice search with Gnani Prisma"
                aria-label="Voice search with Gnani Prisma"
              >
                {isVoiceProcessing ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Mic size={17} className={isVoiceSearching ? "animate-bounce" : ""} />
                )}
              </button>
            </div>
          </div>

          {/* Tab Switcher & Status Filter Bar */}
          <div className="flex items-center justify-between gap-2.5">
            <div className="inline-flex glass-panel p-1 rounded-2xl gap-1 overflow-x-auto no-scrollbar shrink-0">
              {TAB_DEFS.map(({ id, labelKey, icon: Icon }) => {
                const count = tabCounts[id] || 0;
                const isSelected = activeTab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold whitespace-nowrap transition-all touch-manipulation min-h-[38px] ${
                      isSelected
                        ? "bg-brand-500 text-white shadow-sm"
                        : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                    }`}
                  >
                    <Icon size={14} className={isSelected ? "text-white" : "text-brand-500"} />
                    <span>{t(labelKey)}</span>
                    <span
                      className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono ${
                        isSelected ? "bg-white/20 text-white" : "bg-slate-200/60 dark:bg-white/10 text-slate-500"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="inline-flex glass-panel p-1 rounded-2xl gap-1 overflow-x-auto no-scrollbar">
              {STATUS_FILTERS.map((s) => {
                const count = statusCounts[s] || 0;
                const isSelected = statusFilter === s;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold capitalize transition-all touch-manipulation min-h-[36px] ${
                      isSelected
                        ? "bg-brand-500 text-white shadow-xs"
                        : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                    }`}
                  >
                    <span>{t(`common.${s}`)}</span>
                    <span
                      className={`text-[10px] font-mono px-1 rounded-full ${
                        isSelected ? "bg-white/20 text-white" : "text-slate-400"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-xs sm:text-sm text-red-600 dark:text-red-400 animate-fadeIn">
          <AlertCircle size={16} className="shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Main Agent Feed */}
      {loading ? (
        <div className="glass-panel rounded-2xl p-12 flex flex-col items-center justify-center gap-3 text-sm text-slate-400">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span>{t("myAgents.loadingAgents")}</span>
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 p-6 flex flex-col items-center justify-center gap-3 text-center text-red-600 dark:text-red-400">
          <AlertCircle size={28} />
          <p className="text-sm font-semibold">{loadError}</p>
          <button
            onClick={fetchAgents}
            className="px-4 py-2 rounded-xl bg-red-500 text-white text-xs font-semibold hover:bg-red-600 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 sm:p-12 text-center flex flex-col items-center justify-center gap-3 border border-slate-200/70 dark:border-white/10 shadow-sm">
          <div className="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mb-1">
            {search ? <Search size={26} /> : <Sparkles size={26} />}
          </div>
          <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white">
            {search
              ? `No agents found matching "${search}"`
              : agents.length === 0
              ? "No Agents Created Yet"
              : t("myAgents.noAgents")}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md">
            {search
              ? "Try clearing your search or tap the 🎙️ mic to search for another workflow or trigger."
              : agents.length === 0
              ? "Create your first voice-directed AI agent in seconds. Speak your workflow prompt and let VoxAgent build it for you."
              : "No workflows match the active tab and status filters. Try selecting 'All' or switch tabs."}
          </p>

          <div className="flex items-center gap-2 mt-2 flex-wrap justify-center">
            {search ? (
              <button
                onClick={() => setSearch("")}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all"
              >
                Clear Search
              </button>
            ) : agents.length === 0 ? (
              <button
                onClick={() => navigate("/studio")}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 px-5 py-3 text-white text-xs sm:text-sm font-semibold shadow-md shadow-brand-500/25 active:scale-95 transition-all touch-manipulation min-h-[44px]"
              >
                <Plus size={16} />
                <span>Build with Voice Studio</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  setStatusFilter("all");
                  setSearch("");
                }}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all"
              >
                Reset Filters
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Mobile-Native Cards Feed (< sm) */}
          <div className="sm:hidden flex flex-col gap-3 pb-8">
            {filteredAgents.map((agent) => (
              <MobileAgentCard
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

          {/* Desktop Responsive Grid Feed (>= sm) */}
          <div className="hidden sm:grid grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4">
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
        </>
      )}

      {/* Slide-out Edit Drawer & Mobile History Sheet */}
      <EditAgentDrawer agent={editingAgent} onClose={() => setEditingAgent(null)} onSave={handleSaveEdit} />
      <HistoryModal agent={historyAgent} onClose={() => setHistoryAgent(null)} />
    </div>
  );
}
