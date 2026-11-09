import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bell, CheckCircle2, AlertCircle, X, Trash2, Clock, Radio, Zap, HelpCircle } from "lucide-react";
import { approvePendingAction, getPausedRuns, rejectPendingAction, resumeAgent } from "../../api/agents";
import { useAuth } from "../../context/AuthContext";
import { useNotificationStore } from "../../store/notificationStore";
import PendingActionCard from "../studio/PendingActionCard";

function formatTimeAgo(ts) {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 45) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export default function NotificationsDropdown() {
  const { t } = useTranslation();
  const { userId } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [pausedRuns, setPausedRuns] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [errors, setErrors] = useState({});
  const dropdownRef = useRef(null);

  const executionNotifications = useNotificationStore((state) => state.notifications);
  const markAllAsRead = useNotificationStore((state) => state.markAllAsRead);
  const clearAllNotifications = useNotificationStore((state) => state.clearAll);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  const unreadCount = executionNotifications.filter((n) => !n.read).length;
  const totalBadges = pausedRuns.length + unreadCount;

  const fetchPausedRuns = async () => {
    try {
      const data = await getPausedRuns();
      if (data && data.paused_runs) {
        const arr = Object.values(data.paused_runs);
        setPausedRuns(arr);
        return arr;
      }
    } catch (e) {
      console.error("Failed to fetch paused runs:", e);
    }
    return null;
  };

  useEffect(() => {
    fetchPausedRuns();
    const interval = setInterval(fetchPausedRuns, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      markAllAsRead();
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, markAllAsRead]);

  const withBusyState = async (notif, action) => {
    setBusyId(notif.id);
    setErrors((prev) => ({ ...prev, [notif.id]: null }));
    try {
      await action();
      const newArr = await fetchPausedRuns();
      if (newArr && newArr.length === 0 && executionNotifications.length === 0) {
        setIsOpen(false);
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [notif.id]: e.message || t("notifications.somethingWrong") }));
    } finally {
      setBusyId(null);
    }
  };

  const handleResume = (notif, answer) => withBusyState(notif, () => resumeAgent(notif.agent_id, answer));
  const handleApprove = (notif) => withBusyState(notif, () => approvePendingAction(notif.id));
  const handleReject = (notif) => withBusyState(notif, () => rejectPendingAction(notif.id, "Rejected by user"));

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative flex items-center justify-center w-9 h-9 rounded-full text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {totalBadges > 0 && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-slate-900" />
        )}
      </button>

      {isOpen && (
        <>
          {/* Mobile Backdrop */}
          <div
            className="sm:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-xs transition-opacity"
            onClick={() => setIsOpen(false)}
          />

          {/* Responsive Dropdown Container */}
          <div className="fixed sm:absolute left-3 right-3 sm:left-auto sm:right-0 top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] sm:top-auto sm:mt-2 sm:w-96 max-w-[calc(100vw-1.5rem)] sm:max-w-[90vw] bg-white dark:bg-slate-900 rounded-2xl sm:rounded-xl shadow-2xl border border-slate-200/80 dark:border-white/10 overflow-hidden z-50">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200/70 dark:border-white/10 bg-slate-50/70 dark:bg-slate-800/50">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
                  {t("notifications.notifications", "Notifications")}
                </h3>
                {totalBadges > 0 && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                    {totalBadges}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {executionNotifications.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAllNotifications}
                    className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center gap-1 transition-colors"
                    title="Clear history"
                  >
                    <Trash2 size={12} />
                    <span>Clear</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="sm:hidden flex items-center justify-center w-6 h-6 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  aria-label="Close notification panel"
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className="max-h-[65vh] sm:max-h-[70vh] overflow-y-auto p-3 space-y-3">
              {/* 1. Pending Approvals & Clarifications */}
              {pausedRuns.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold tracking-wider uppercase text-amber-600 dark:text-amber-400 px-1">
                    Action Required ({pausedRuns.length})
                  </div>
                  {pausedRuns.map((notif) => (
                    <PendingActionCard
                      key={notif.id}
                      question={notif.question}
                      inputType={notif.input_type}
                      reconnectApp={notif.reconnect_app}
                      reconnectRoute={notif.reconnect_route}
                      userId={userId}
                      options={notif.options}
                      busy={busyId === notif.id}
                      error={errors[notif.id]}
                      onResume={(answer) => handleResume(notif, answer)}
                      onApprove={() => handleApprove(notif)}
                      onReject={() => handleReject(notif)}
                    />
                  ))}
                </div>
              )}

              {/* 2. On-Demand Execution Results */}
              {executionNotifications.length > 0 && (
                <div className="space-y-2">
                  {pausedRuns.length > 0 && (
                    <div className="text-[11px] font-semibold tracking-wider uppercase text-slate-400 px-1 pt-1 border-t border-slate-100 dark:border-white/5">
                      Workflow Activity
                    </div>
                  )}
                  {executionNotifications.map((n) => {
                    const isSuccess = n.status === "success";
                    const isInfo = n.status === "info";
                    const isNeedsInput = n.status === "needs_input";
                    const isFailed = n.status === "failed";

                    let iconEl = <CheckCircle2 size={16} />;
                    let iconBg = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

                    if (isFailed) {
                      iconEl = <AlertCircle size={16} />;
                      iconBg = "bg-red-500/10 text-red-600 dark:text-red-400";
                    } else if (isNeedsInput) {
                      iconEl = <HelpCircle size={16} />;
                      iconBg = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
                    } else if (isInfo) {
                      iconBg = "bg-brand-500/10 text-brand-600 dark:text-brand-400";
                      if (n.triggerType === "scheduled") {
                        iconEl = <Clock size={16} />;
                      } else if (n.triggerType === "event_trigger") {
                        iconEl = <Radio size={16} className="animate-pulse" />;
                      } else {
                        iconEl = <Zap size={16} />;
                      }
                    }

                    return (
                      <div
                        key={n.id}
                        className="group relative flex items-start gap-3 p-3 rounded-xl border border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100/60 dark:hover:bg-white/[0.04] transition-all"
                      >
                        <div className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${iconBg}`}>
                          {iconEl}
                        </div>
                        <div className="flex-1 min-w-0 pr-5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 truncate">
                              <h4 className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                                {n.title}
                              </h4>
                              {n.triggerType === "scheduled" && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                  <Clock size={9} />
                                  Scheduled
                                </span>
                              )}
                              {n.triggerType === "event_trigger" && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400">
                                  <Radio size={9} />
                                  Triggered
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-400 whitespace-nowrap">
                              {formatTimeAgo(n.timestamp)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-relaxed">
                            {n.message}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeNotification(n.id)}
                          className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-opacity"
                          title="Dismiss"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty State */}
              {pausedRuns.length === 0 && executionNotifications.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
                  <Bell size={24} className="mx-auto mb-2 opacity-30" />
                  <p className="font-medium">No new notifications</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Workflow activity and action items will appear here.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
