import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { approvePendingAction, getPausedRuns, rejectPendingAction, resumeAgent } from "../../api/agents";
import PendingActionCard from "../studio/PendingActionCard";

// The Action Center — every pending action a background (scheduled or
// webhook-triggered) run is waiting on, scoped to the current user (see
// GET /paused). Renders each item with the same PendingActionCard used
// for a live in-Studio pause, instead of a bespoke free-text-only form.
export default function NotificationsDropdown() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [errors, setErrors] = useState({});
  const dropdownRef = useRef(null);

  const fetchNotifications = async () => {
    try {
      const data = await getPausedRuns();
      if (data && data.paused_runs) {
        const arr = Object.values(data.paused_runs);
        setNotifications(arr);
        return arr;
      }
    } catch (e) {
      console.error("Failed to fetch notifications:", e);
    }
    return null;
  };

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const withBusyState = async (notif, action) => {
    setBusyId(notif.id);
    setErrors((prev) => ({ ...prev, [notif.id]: null }));
    try {
      await action();
      const newArr = await fetchNotifications();
      if (newArr && newArr.length === 0) setIsOpen(false);
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
        onClick={() => setIsOpen(!isOpen)}
        className="relative flex items-center justify-center w-9 h-9 rounded-full text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
      >
        <Bell size={18} />
        {notifications.length > 0 && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-slate-900" />
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 max-w-[90vw] bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200/70 dark:border-white/10 overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-slate-200/70 dark:border-white/10 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
              {t("notifications.actionCenter", { count: notifications.length })}
            </h3>
          </div>

          <div className="max-h-[70vh] overflow-y-auto p-3 space-y-3">
            {notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">{t("notifications.noPendingTasks")}</div>
            ) : (
              notifications.map((notif) => (
                <PendingActionCard
                  key={notif.id}
                  question={notif.question}
                  inputType={notif.input_type}
                  reconnectApp={notif.reconnect_app}
                  busy={busyId === notif.id}
                  error={errors[notif.id]}
                  onResume={(answer) => handleResume(notif, answer)}
                  onApprove={() => handleApprove(notif)}
                  onReject={() => handleReject(notif)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
