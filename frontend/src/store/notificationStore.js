import { create } from "zustand";
import { queueVoiceNotification } from "../hooks/useVoiceFeedback";

const NOTIFICATIONS_STORAGE_KEY = "voxagent_execution_notifications";
const DEDUP_WINDOW_MS = 15000; // 15 seconds sliding window to suppress duplicate notifications

function loadSavedNotifications() {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];

    // Deduplicate any historical duplicate items from localStorage
    const deduped = [];
    const seen = new Set();
    for (const item of list) {
      const key =
        item.dedupKey ||
        `${item.agentId || "global"}_${item.status || "info"}_${Math.floor((item.timestamp || 0) / 10000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }
    return deduped;
  } catch {
    return [];
  }
}

function persistNotifications(items) {
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {
    // ignore
  }
}

// In-memory cache for recent notification dedup keys with timestamps
const recentDedupMap = new Map();

export const useNotificationStore = create((set, get) => ({
  notifications: loadSavedNotifications(),

  addNotification: ({
    agentId,
    title,
    status = "success",
    triggerType = "on_demand",
    message,
    spokenMessage,
    dedupKey,
    timestamp,
  }) => {
    const now = Date.now();
    const eventTime = timestamp || now;
    const effectiveDedupKey =
      dedupKey || `${agentId || "global"}_${status}_${message || ""}`;

    // 1. Guard against burst duplicates via in-memory sliding window
    const lastTimestamp = recentDedupMap.get(effectiveDedupKey);
    if (lastTimestamp && now - lastTimestamp < DEDUP_WINDOW_MS) {
      return;
    }

    // 2. Guard against existing identical notifications in state
    const currentList = get().notifications;
    const hasDuplicate = currentList.some((item) => {
      if (dedupKey && item.dedupKey === dedupKey) return true;
      if (
        agentId &&
        item.agentId === agentId &&
        item.status === status &&
        now - (item.timestamp || 0) < DEDUP_WINDOW_MS
      ) {
        return true;
      }
      return false;
    });

    if (hasDuplicate) {
      return;
    }

    // Register into ephemeral dedup map
    recentDedupMap.set(effectiveDedupKey, now);

    // Prune entries older than 1 minute to prevent memory leak
    for (const [key, time] of recentDedupMap.entries()) {
      if (now - time > 60000) {
        recentDedupMap.delete(key);
      }
    }

    const newNotif = {
      id: "notif_" + now + "_" + Math.random().toString(36).slice(2, 7),
      dedupKey: effectiveDedupKey,
      agentId,
      title: title || "Agent Workflow",
      status, // "success" | "failed" | "info" | "needs_input"
      triggerType, // "scheduled" | "event_trigger" | "on_demand"
      message:
        message ||
        (status === "success"
          ? "Workflow completed successfully."
          : "Workflow failed."),
      timestamp: eventTime,
      read: false,
    };

    set((state) => {
      const updated = [newNotif, ...state.notifications].slice(0, 50);
      persistNotifications(updated);
      return { notifications: updated };
    });

    // Native browser system notification if user allowed
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(newNotif.title, {
          body: newNotif.message,
          icon: "/favicon.ico",
        });
      } catch {
        // ignore
      }
    }

    // Spoken voice update (queued: if voice is already speaking, completes sentence first)
    if (spokenMessage) {
      queueVoiceNotification(spokenMessage);
    }
  },

  markAllAsRead: () => {
    set((state) => {
      const updated = state.notifications.map((n) => ({ ...n, read: true }));
      persistNotifications(updated);
      return { notifications: updated };
    });
  },

  clearAll: () => {
    persistNotifications([]);
    recentDedupMap.clear();
    set({ notifications: [] });
  },

  removeNotification: (id) => {
    set((state) => {
      const updated = state.notifications.filter((n) => n.id !== id);
      persistNotifications(updated);
      return { notifications: updated };
    });
  },
}));

