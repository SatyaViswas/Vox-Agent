import { useEffect, useRef } from "react";
import { getRecentExecutions } from "../api/agents";
import { useNotificationStore } from "../store/notificationStore";

const POLL_INTERVAL_MS = 4000;
const SESSION_START_TIME = Date.now();

export function useBackgroundExecutionMonitor() {
  const isFirstMountRef = useRef(true);
  const seenEventKeysRef = useRef(new Set());
  const lastPollTimeRef = useRef(0);
  const isPollingRef = useRef(false);

  useEffect(() => {
    // Request browser notification permission non-intrusively if not decided
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().catch(() => {});
    }

    const checkExecutions = async () => {
      if (isPollingRef.current) return;
      isPollingRef.current = true;

      try {
        const isFirst = isFirstMountRef.current;
        const sinceParam = isFirst ? undefined : Math.max(0, lastPollTimeRef.current - 10000);
        const res = await getRecentExecutions({ since: sinceParam, limit: 15 });
        const events = res?.events || [];

        if (isFirst) {
          isFirstMountRef.current = false;
          // On cold start / refresh:
          // Mark past events as seen so we don't spam audio
          events.forEach((evt) => {
            const key = evt.dedup_key || evt.id;
            seenEventKeysRef.current.add(key);

            // If the event completed very recently (within 5 minutes), add to dropdown history without spoken audio
            const eventAge = Date.now() - (evt.timestamp || 0);
            if (eventAge < 5 * 60 * 1000) {
              useNotificationStore.getState().addNotification({
                agentId: evt.agent_id,
                title: evt.agent_title || "Agent Workflow",
                status: evt.status,
                triggerType: evt.trigger_type,
                message: evt.message,
                spokenMessage: null, // do not speak past notifications on initial load
                dedupKey: evt.dedup_key,
                timestamp: evt.timestamp,
              });
            }
          });
          lastPollTimeRef.current = Date.now();
        } else {
          // Process live events in chronological order (oldest to newest)
          const sorted = [...events].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

          for (const evt of sorted) {
            const key = evt.dedup_key || evt.id;
            if (seenEventKeysRef.current.has(key)) {
              continue;
            }
            seenEventKeysRef.current.add(key);

            // Freshness check: only voice events that occurred during/near the active session
            const isFresh = (evt.timestamp || 0) >= SESSION_START_TIME - 15000;
            const spokenMsg = isFresh ? evt.spoken_message : null;

            useNotificationStore.getState().addNotification({
              agentId: evt.agent_id,
              title: evt.agent_title || "Agent Workflow",
              status: evt.status,
              triggerType: evt.trigger_type,
              message: evt.message,
              spokenMessage: spokenMsg,
              dedupKey: evt.dedup_key,
              timestamp: evt.timestamp,
            });

            if (evt.timestamp && evt.timestamp > lastPollTimeRef.current) {
              lastPollTimeRef.current = evt.timestamp;
            }
          }
          lastPollTimeRef.current = Math.max(lastPollTimeRef.current, Date.now() - 5000);
        }
      } catch (err) {
        // Silently tolerate transient polling errors
      } finally {
        isPollingRef.current = false;
      }
    };

    // Initial check
    checkExecutions();

    // Regular poll
    const interval = setInterval(checkExecutions, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}

