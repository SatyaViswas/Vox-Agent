import { useState, useEffect } from "react";
import { Bell, Check, X } from "lucide-react";
import { apiClient, BASE_URL } from "../../api/client";

export default function NotificationsDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchNotifications = async () => {
    try {
      // Updated from /execution/paused to /paused since the router is mounted directly on /api/v1
      const data = await apiClient.get(`/paused`);
      if (data && data.paused_runs) {
        const arr = Object.values(data.paused_runs);
        setNotifications(arr);
      }
    } catch (e) {
      console.error("Failed to fetch notifications:", e);
    }
  };

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (agentId) => {
    setLoading(true);
    try {
      await apiClient.post(`/agents/${agentId}/resume`, { answer: "Approved" });
      await fetchNotifications();
    } catch (e) {
      console.error("Failed to approve:", e);
    }
    setLoading(false);
  };

  const handleReject = async (agentId) => {
    setLoading(true);
    try {
      await apiClient.post(`/agents/${agentId}/resume`, { answer: "Rejected" });
      await fetchNotifications();
    } catch (e) {
      console.error("Failed to reject:", e);
    }
    setLoading(false);
  };

  return (
    <div className="relative">
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
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200/70 dark:border-white/10 overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-slate-200/70 dark:border-white/10 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
              Pending Approvals ({notifications.length})
            </h3>
          </div>
          
          <div className="max-h-[60vh] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                No pending tasks
              </div>
            ) : (
              notifications.map((notif) => {
                // Try to extract JSON preview if it's formatted as ```json ... ```
                let preview = notif.question;
                let parsedJson = null;
                const jsonMatch = preview.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch) {
                  try {
                    parsedJson = JSON.parse(jsonMatch[1]);
                    preview = preview.replace(/```json\n[\s\S]*?\n```/, "").trim();
                  } catch (e) {
                    // Ignore JSON parse error
                  }
                }

                return (
                  <div key={notif.agent_id} className="p-4 border-b border-slate-100 dark:border-white/5 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200 mb-2">
                      {preview}
                    </p>
                    
                    {parsedJson && (
                      <div className="mb-3 bg-slate-100 dark:bg-slate-800 p-2 rounded-lg text-xs font-mono text-slate-600 dark:text-slate-400 overflow-x-auto">
                        <pre>{JSON.stringify(parsedJson, null, 2)}</pre>
                      </div>
                    )}
                    
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprove(notif.agent_id)}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Check size={14} />
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(notif.agent_id)}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg transition-colors"
                      >
                        <X size={14} />
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
