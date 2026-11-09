import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, Mic, MinusCircle, PlayCircle, Radio, SendHorizontal, Sparkles, Workflow } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useVoiceFeedback } from "../hooks/useVoiceFeedback";
import { useVoiceLanguage } from "../hooks/useVoiceLanguage";
import { useLanguage } from "../context/LanguageContext";
import { translateText } from "../api/translate";
import { resolveDisambiguation } from "../api/voice";
import { needsTranslation } from "../lib/textLanguage";
import VoiceLanguagePicker from "../components/shared/VoiceLanguagePicker";
import VoiceFeedbackBar from "../components/studio/VoiceFeedbackBar";
import {
  approvePendingAction,
  createAgent,
  executeAgent,
  getAgentLogs,
  getPausedRuns,
  planWorkflow,
  rejectPendingAction,
  resumeAgent,
  telemetrySocketUrl,
} from "../api/agents";
import { getRequiredAppsStatus, introspectAppResources } from "../api/vault";
import BlueprintFlow from "../components/studio/BlueprintFlow";
import DisambiguationPanel, { paramKey } from "../components/studio/DisambiguationPanel";
import PendingActionCard from "../components/studio/PendingActionCard";
import RequiredAppsGate from "../components/studio/RequiredAppsGate";
import TelemetryPanel from "../components/studio/TelemetryPanel";
import MobileStudioHero from "../components/studio/MobileStudioHero";
import MobileWorkflowHub from "../components/studio/MobileWorkflowHub";
import WorkflowUpdateModal from "../components/studio/WorkflowUpdateModal";

const POLL_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

const STUDIO_QUICK_PROMPTS = [
  { label: "📧 Email Report", text: "Send an email with a project summary to mvsviswas@gmail.com" },
  { label: "📊 Google Sheets", text: "Extract full sheet from Google Sheets and create a summary in Google Docs" },
  { label: "⚡ Telegram Alert", text: "Send a message on Telegram personal account with today's status" },
  { label: "📝 Notion & Slack", text: "Read recent items from Notion and post an update to Slack" },
];

function cloneBlueprint(blueprint) {
  return typeof structuredClone === "function" ? structuredClone(blueprint) : JSON.parse(JSON.stringify(blueprint));
}

// Apps a step route actually needs a connection for — matches
// planner.py's _CONNECTABLE_ROUTES exactly. 'ai_generate' runs on
// VoxAgent's own built-in AI and 'http_webhook' targets a plain URL, not a
// connectable app.
const CONNECTABLE_ROUTES = new Set(["composio_api", "browser_agent", "telegram_client"]);

// Required-apps list for RequiredAppsGate, derived straight from the
// blueprint's own steps (+ an event trigger's watched app) instead of
// trusting the planner LLM's freeform `required_apps` field — it can never
// drift from what the workflow actually runs, and it carries each app's
// route so the gate can tell a browser-session app (needs a saved App
// Vault session) apart from a Composio API app (needs an OAuth/credential
// connection) instead of treating every entry as the latter.
function deriveRequiredApps(blueprint) {
  if (!blueprint) return [];
  const byApp = new Map();
  (blueprint.steps || []).forEach((step) => {
    const app = step?.app;
    const route = step?.route;
    if (!app || typeof app !== "string" || app.includes("{") || app.includes("}")) return;
    if (!CONNECTABLE_ROUTES.has(route)) return;
    if (!byApp.has(app)) byApp.set(app, route);
  });
  const trigger = blueprint.trigger;
  if (trigger?.type === "webhook" && trigger.event_app && !trigger.event_app.includes("{")) {
    if (!byApp.has(trigger.event_app)) byApp.set(trigger.event_app, "composio_api");
  }
  return Array.from(byApp.entries()).map(([app, route]) => ({ app, route }));
}

function needsAttention(blueprint) {
  if (!blueprint) return false;
  return (
    Boolean(blueprint.needs_clarification) ||
    Boolean(blueprint.needs_human_approval) ||
    (blueprint.missing_parameters?.length || 0) > 0
  );
}

function summarizeLogMessages(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "no step detail returned";
  const failed = entries.filter((e) => e.result?.status === "error").length;
  const skipped = entries.filter((e) => e.result?.status === "skipped").length;
  const succeeded = entries.filter((e) => e.result?.status === "success" || (!e.result?.status && !e.result?.error)).length;

  if (failed > 0) {
    return `${failed} of ${entries.length} step(s) failed`;
  }
  if (skipped > 0) {
    return `${succeeded} step(s) executed, ${skipped} skipped`;
  }
  return `${entries.length} step(s) executed successfully`;
}

function isRunCommand(text) {
  if (!text) return false;
  let clean = text.toLowerCase().trim().replace(/[.,!?;:।]/g, "");
  clean = clean.replace(/^(ok|okay|please|voxagent|vox agent|hey voxagent|hey vox)\s+/, "").trim();
  const enRegex = /^(run|run it|run this|save and run|execute|start|start workflow|proceed|go ahead|launch)$/i;
  const indicRegex = /^(రన్ చేయి|రన్|స్టార్ట్|స్టార్ట్ చేయి|ఆమోదించు|మొదలుపెట్టు|ప్రారంభించు|నడుపు|చలావు|చలావ్|चलाओ|रन करो|रन|शुरू करो|स्टार्ट|आगे बढ़ो|स्टार्ट करो)$/i;
  return enRegex.test(clean) || indicRegex.test(clean);
}

import { useStudioStore } from "../store/studioStore";

export default function AgentStudio() {
  const location = useLocation();
  const { userId } = useAuth();
  const { t } = useTranslation();
  const { siteLanguage } = useLanguage();
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();

  const activeWebsiteLanguage = siteLanguage || "te";

  const {
    enabled: ttsEnabled,
    setEnabled: setTtsEnabled,
    voice: ttsVoice,
    setVoice: setTtsVoice,
    isPlaying: ttsPlaying,
    isLoading: ttsLoading,
    speak,
    stop: stopSpeaking,
  } = useVoiceFeedback();

  const {
    prompt, setPrompt,
    originalPrompt, setOriginalPrompt,
    planning, setPlanning,
    planError, setPlanError,
    blueprint, setBlueprint,
    disambigValues, setDisambigValues,
    approved, setApproved,
    disambigResolved, setDisambigResolved,
    requiredAppsConnected, setRequiredAppsConnected,
    agentId, setAgentId,
    runStatus, setRunStatus,
    runError, setRunError,
    logs, setLogs, appendLog,
    stepStatuses, setStepStatuses,
    stepSkipReasons, setStepSkipReasons,
    liveClarification, setLiveClarification,
    resuming, setResuming,
    resumeError, setResumeError,
    requireApproval, setRequireApproval,
    clearStudio
  } = useStudioStore();

  const [isListeningForDisambig, setIsListeningForDisambig] = useState(false);
  const [activeParamListening, setActiveParamListening] = useState(null);
  const [disambigResolving, setDisambigResolving] = useState(false);
  const [mobileStudioTab, setMobileStudioTab] = useState("blueprint");
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  const isListeningForDisambigRef = useRef(false);
  const activeParamListeningRef = useRef(null);
  const disambigValuesRef = useRef(disambigValues);
  disambigValuesRef.current = disambigValues;
  const blueprintRef = useRef(blueprint);
  blueprintRef.current = blueprint;
  const startVoiceClarificationRef = useRef(null);
  const startRecordingRef = useRef(null);
  const handleVoiceDisambigResponseRef = useRef(null);
  const handleSaveAndRunRef = useRef(null);
  const planningRef = useRef(planning);
  planningRef.current = planning;
  const runStatusRef = useRef(runStatus);
  runStatusRef.current = runStatus;
  const requiredAppsConnectedRef = useRef(requiredAppsConnected);
  requiredAppsConnectedRef.current = requiredAppsConnected;
  const disambigResolvedRef = useRef(disambigResolved);
  disambigResolvedRef.current = disambigResolved;
  const stepStatusesRef = useRef(stepStatuses);
  stepStatusesRef.current = stepStatuses;
  const stepSkipReasonsRef = useRef(stepSkipReasons);
  stepSkipReasonsRef.current = stepSkipReasons;
  const prevAppsConnectedRef = useRef(null);

  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const lastLogIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const activeAgentIdRef = useRef(null);
  const announcedPauseIdsRef = useRef(new Set());
  const hasAnnouncedCompletionRef = useRef(false);

  const announceExecutionFinished = useCallback(
    (status, logMessages = null) => {
      if (hasAnnouncedCompletionRef.current) return;
      hasAnnouncedCompletionRef.current = true;

      const currentStatuses = { ...(stepStatusesRef.current || {}) };
      if (Array.isArray(logMessages)) {
        logMessages.forEach((entry) => {
          if (entry.step != null) {
            const entryStatus = entry.result?.status;
            currentStatuses[entry.step] =
              entryStatus === "error"
                ? "failed"
                : entryStatus === "skipped"
                ? "skipped"
                : entryStatus === "needs_input"
                ? "needs_input"
                : "success";
          }
        });
      }

      const skippedEntries = Object.entries(currentStatuses).filter(
        ([_, st]) => st === "skipped"
      );
      const totalSteps = Object.keys(currentStatuses).length;
      const allSkipped = totalSteps > 0 && skippedEntries.length === totalSteps;

      if (status === "success") {
        if (allSkipped) {
          speak(
            t(
              "spoken.executionAllSkipped",
              "Workflow completed. All steps were skipped because the conditions were not met."
            ),
            { force: true }
          );
        } else if (skippedEntries.length > 0) {
          const stepListStr = skippedEntries.map(([s]) => s).join(", ");
          speak(
            t(
              "spoken.executionSucceededWithSkips",
              { steps: stepListStr },
              `Workflow completed. Step ${stepListStr} was skipped as the condition was not met, and no further action was needed.`
            ),
            { force: true }
          );
        } else {
          speak(
            t(
              "spoken.executionSucceeded",
              "Workflow execution completed successfully! All actions were carried out."
            ),
            { force: true }
          );
        }
      } else if (status === "failed") {
        const failedEntries = Object.entries(currentStatuses).filter(
          ([_, st]) => st === "failed"
        );
        const failedStr = failedEntries.map(([s]) => s).join(", ");
        speak(
          failedStr
            ? t(
                "spoken.executionFailedAtStep",
                { step: failedStr },
                `The workflow encountered an error at Step ${failedStr}.`
              )
            : t(
                "spoken.executionFailed",
                "The workflow encountered an error during execution."
              ),
          { force: true }
        );
      }
    },
    [speak, t]
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    clearReconnectTimer();
    activeAgentIdRef.current = null;
    if (wsRef.current) {
      const socket = wsRef.current;
      wsRef.current = null;
      // Detach onclose first so this intentional close never triggers a reconnect.
      socket.onclose = null;
      socket.close();
    }
  }, [clearReconnectTimer]);

  useEffect(
    () => () => {
      stopPolling();
      closeSocket();
    },
    [stopPolling, closeSocket]
  );

  const applyStatusFromMessage = useCallback(
    (message) => {
      const executingMatch = message.match(/^Executing Step (\d+)/);
      const completedMatch = message.match(/^Step (\d+) completed/);
      const failedMatch = message.match(/^Step (\d+) failed/);
      const skippedMatch = message.match(/^Step (\d+) skipped(?::\s*(.*))?/);
      const needsInputMatch = message.match(/^Step (\d+) needs clarification/);
      if (executingMatch) {
        const stepNum = Number(executingMatch[1]);
        setStepStatuses((prev) => ({ ...prev, [stepNum]: "executing" }));
        stepStatusesRef.current = { ...stepStatusesRef.current, [stepNum]: "executing" };
      } else if (completedMatch) {
        const stepNum = Number(completedMatch[1]);
        setStepStatuses((prev) => ({ ...prev, [stepNum]: "success" }));
        stepStatusesRef.current = { ...stepStatusesRef.current, [stepNum]: "success" };
      } else if (skippedMatch) {
        const stepNum = Number(skippedMatch[1]);
        const reason = (skippedMatch[2] || "").trim();
        setStepStatuses((prev) => ({ ...prev, [stepNum]: "skipped" }));
        stepStatusesRef.current = { ...stepStatusesRef.current, [stepNum]: "skipped" };
        if (reason) {
          setStepSkipReasons((prev) => ({ ...prev, [stepNum]: reason }));
          stepSkipReasonsRef.current = { ...stepSkipReasonsRef.current, [stepNum]: reason };
        }
      } else if (failedMatch) {
        const stepNum = Number(failedMatch[1]);
        setStepStatuses((prev) => ({ ...prev, [stepNum]: "failed" }));
        stepStatusesRef.current = { ...stepStatusesRef.current, [stepNum]: "failed" };
      } else if (needsInputMatch) {
        const stepNum = Number(needsInputMatch[1]);
        setStepStatuses((prev) => ({ ...prev, [stepNum]: "needs_input" }));
        stepStatusesRef.current = { ...stepStatusesRef.current, [stepNum]: "needs_input" };
        setRunStatus("needs_input");
        stopPolling();
      } else if (message === "Workflow execution completed.") {
        setRunStatus("success");
        announceExecutionFinished("success");
        stopPolling();
        closeSocket();
      } else if (message === "Workflow execution failed.") {
        setRunStatus("failed");
        announceExecutionFinished("failed");
        stopPolling();
        closeSocket();
      }
    },
    [stopPolling, closeSocket, announceExecutionFinished, setStepStatuses, setStepSkipReasons, setRunStatus]
  );

  // Single source of truth for "what does this pause actually look like" —
  // GET /paused (scoped to the current user, see execution.py) already has
  // the pending action's real id and typed input_type; both the WS event
  // and the poll fallback below just trigger this rather than each
  // building their own partial liveClarification shape from whatever
  // fields happened to be in their own payload.
  const fetchAndSetLiveClarification = useCallback(async (id) => {
    try {
      const data = await getPausedRuns();
      const entry = data?.paused_runs?.[id];
      if (entry) {
        setResumeError(null);
        setLiveClarification({
          id: entry.id,
          question: entry.question,
          reconnectApp: entry.reconnect_app,
          reconnectRoute: entry.reconnect_route,
          inputType: entry.input_type,
          options: entry.options,
        });
        if (entry.question && !announcedPauseIdsRef.current.has(entry.id)) {
          announcedPauseIdsRef.current.add(entry.id);
          const cleanQ = entry.question.replace(/```json[\s\S]*?```/g, "").trim();
          speak(
            `${t("spoken.actionPaused", "The agent paused and needs your input.")} ${cleanQ}`
          );
        }
      }
    } catch {
      // Transient fetch error — whatever detection path triggered this call
      // (WS event or poll) will likely fire again shortly.
    }
  }, [speak]);

  const openSocket = useCallback(
    (id) => {
      try {
        const ws = new WebSocket(telemetrySocketUrl(id));
        ws.onopen = () => {
          reconnectAttemptsRef.current = 0;
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            appendLog({ level: data.level, message: data.message, screenshotUrl: data.screenshot_url });
            applyStatusFromMessage(data.message);
            const eventType = data.data?.type;
            if (eventType === "step_skipped") {
              const step = data.data?.step;
              const reason = data.data?.reason;
              if (step != null) {
                setStepStatuses((prev) => ({ ...prev, [Number(step)]: "skipped" }));
                stepStatusesRef.current = { ...stepStatusesRef.current, [Number(step)]: "skipped" };
                if (reason) {
                  setStepSkipReasons((prev) => ({ ...prev, [Number(step)]: reason }));
                  stepSkipReasonsRef.current = { ...stepSkipReasonsRef.current, [Number(step)]: reason };
                }
                speak(
                  t("spoken.stepSkipped", {
                    step,
                    reason: reason || "condition not met",
                    defaultValue: `Step ${step} was skipped because ${reason || "the condition was not met"}.`,
                  }),
                  { force: true }
                );
              }
            } else if (eventType === "clarification_needed") {
              fetchAndSetLiveClarification(id);
            } else if (
              eventType === "mutation_attempt" ||
              eventType === "mutation_memory_applied" ||
              eventType === "mutation_shadow"
            ) {
              // MutAgent retrying/mutating a step on its own (Phases 2-4) —
              // show it distinctly from plain "Executing" so it's visible
              // rather than silent; the next normal log line
              // (Step N completed/failed/needs clarification) overwrites
              // this via applyStatusFromMessage once it resolves.
              const step = data.data?.step;
              if (step != null) {
                setStepStatuses((prev) => ({ ...prev, [step]: "mutating" }));
              }
            }
          } catch {
            // ignore malformed frame
          }
        };
        ws.onerror = () => {
          // onclose fires right after and drives the reconnect decision —
          // REST polling also still covers status in the meantime.
        };
        ws.onclose = () => {
          wsRef.current = null;
          const runStillActive = activeAgentIdRef.current === id;
          if (!runStillActive) return;

          if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
            appendLog({
              level: "warning",
              message: "Telemetry stream lost — giving up after repeated reconnect attempts. Status will keep updating via polling.",
            });
            return;
          }

          const attempt = reconnectAttemptsRef.current + 1;
          reconnectAttemptsRef.current = attempt;
          const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
          appendLog({
            level: "warning",
            message: `Telemetry connection dropped — reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})…`,
          });
          reconnectTimerRef.current = setTimeout(() => openSocket(id), delay);
        };
        wsRef.current = ws;
      } catch {
        // WebSocket unsupported/unreachable — REST polling is the fallback
      }
    },
    [appendLog, applyStatusFromMessage, fetchAndSetLiveClarification]
  );

  const connectTelemetrySocket = useCallback(
    (id) => {
      closeSocket();
      activeAgentIdRef.current = id;
      reconnectAttemptsRef.current = 0;
      openSocket(id);
    },
    [closeSocket, openSocket]
  );

  const startPolling = useCallback(
    (id) => {
      stopPolling();
      lastLogIdRef.current = null;
      pollRef.current = setInterval(async () => {
        try {
          const res = await getAgentLogs(id);
          const rows = res?.logs || [];
          if (rows.length === 0) return;
          const latest = rows[0];
          if (latest.id === lastLogIdRef.current) return;
          lastLogIdRef.current = latest.id;

          const updatedStatuses = { ...(stepStatusesRef.current || {}) };
          const updatedSkipReasons = { ...(stepSkipReasonsRef.current || {}) };
          (latest.log_messages || []).forEach((entry) => {
            if (entry.step != null) {
              const entryStatus = entry.result?.status;
              const mappedStatus =
                entryStatus === "error"
                  ? "failed"
                  : entryStatus === "skipped"
                  ? "skipped"
                  : entryStatus === "needs_input"
                  ? "needs_input"
                  : "success";
              updatedStatuses[entry.step] = mappedStatus;
              if (entryStatus === "skipped" && entry.result?.reason) {
                updatedSkipReasons[entry.step] = entry.result.reason;
              }
            }
          });
          setStepStatuses(updatedStatuses);
          stepStatusesRef.current = updatedStatuses;
          setStepSkipReasons(updatedSkipReasons);
          stepSkipReasonsRef.current = updatedSkipReasons;

          if (latest.status === "needs_input") {
            // The WS clarification_needed event usually surfaces this first;
            // either way, fetchAndSetLiveClarification pulls the
            // authoritative, fully-typed pause from GET /paused rather than
            // building a partial shape from this log row (which only ever
            // has {status, question} — no id/input_type to drive
            // PendingActionCard's typed rendering or the approve/reject
            // endpoints).
            setRunStatus("needs_input");
            fetchAndSetLiveClarification(id);
            stopPolling();
            return;
          }

          appendLog({
            level: latest.status === "success" ? "success" : "error",
            message: `Execution ${latest.status}: ${summarizeLogMessages(latest.log_messages)}`,
            screenshotUrl: latest.proof_screenshot_url,
          });

          setRunStatus(latest.status === "success" ? "success" : "failed");
          announceExecutionFinished(latest.status === "success" ? "success" : "failed", latest.log_messages);
          stopPolling();
          closeSocket();
        } catch {
          // transient network/poll error — keep trying on next tick
        }
      }, POLL_INTERVAL_MS);
    },
    [appendLog, stopPolling, closeSocket, fetchAndSetLiveClarification, announceExecutionFinished]
  );

  useEffect(() => {
    if ((runStatus === "running" || runStatus === "starting" || runStatus === "listening") && agentId) {
      if (!wsRef.current && !pollRef.current) {
        connectTelemetrySocket(agentId);
        startPolling(agentId);
      }
    }
  }, [runStatus, agentId, connectTelemetrySocket, startPolling]);

  const handleGenerate = useCallback(
    async (rawPrompt, isAmendment = false) => {
      const text = (rawPrompt ?? "").trim();
      if (!text || planning) return;

      const currentBp = isAmendment ? blueprintRef.current : null;
      const prevDisambigValues = isAmendment ? (disambigValuesRef.current || disambigValues || {}) : {};
      stopPolling();
      closeSocket();
      setPlanning(true);
      setPlanError(null);

      // Preserve the user's exact original prompt for UI display, cards, and edit drawer
      const finalPromptToSave = isAmendment
        ? (originalPrompt ? `${originalPrompt} | Update: ${text}` : text)
        : text;
      setOriginalPrompt(finalPromptToSave);

      // Instant conversational acknowledgement so the user knows their voice was heard immediately
      speak(
        currentBp
          ? t("spoken.updatingWorkflow", "Updating your workflow blueprint with new steps now...")
          : t("spoken.planningWorkflow", "Drafting your workflow blueprint now...")
      );

      if (!currentBp) {
        setBlueprint(null);
        setDisambigValues({});
      }
      setApproved(false);
      setDisambigResolved(false);
      setRequiredAppsConnected(null);
      setAgentId(null);
      setRunStatus("idle");
      setRunError(null);
      setLogs([]);
      setStepStatuses({});
      setLiveClarification(null);
      setResumeError(null);

      try {
        // The visible prompt stays in whatever language the user spoke/typed
        // it in — translation to English happens here, once, invisibly,
        // right before the planner call. If an existing blueprint is present,
        // it is passed as context so amendments refine the plan rather than wipe it out.
        const englishText = needsTranslation(text, voiceLanguage.uiCode)
          ? await translateText(text, "auto")
          : text;
        const data = await planWorkflow(englishText, userId, currentBp);
        if (data) {
          data.original_prompt = finalPromptToSave;
        }

        // Language Continuity: Localize clarification question for voice & display if non-English
        if (data.needs_clarification && data.clarification_question && activeWebsiteLanguage && activeWebsiteLanguage !== "en") {
          try {
            const localizedQ = await translateText(
              data.clarification_question,
              "en",
              activeWebsiteLanguage
            );
            if (localizedQ) {
              data.clarification_question = localizedQ;
            }
          } catch (locErr) {
            console.warn("Failed to localize clarification question:", locErr);
          }
        }

        setBlueprint(data);
        setStepStatuses(Object.fromEntries((data.steps || []).map((s) => [s.step_number, "pending"])));
        setPrompt("");

        // Migrate and retain previously entered values for surviving missing parameters
        const migratedValues = {};
        const missingParams = data.missing_parameters || [];
        missingParams.forEach((param) => {
          const newKey = paramKey(param);
          if (prevDisambigValues[newKey]) {
            migratedValues[newKey] = prevDisambigValues[newKey];
          } else {
            // Check if same parameter_key was filled under an earlier step number
            const matchedOldKey = Object.keys(prevDisambigValues).find(
              (oldKey) => oldKey.endsWith(`::${param.parameter_key}`) || oldKey === param.parameter_key
            );
            if (matchedOldKey && prevDisambigValues[matchedOldKey]) {
              migratedValues[newKey] = prevDisambigValues[matchedOldKey];
            }
          }
        });
        setDisambigValues(migratedValues);
        disambigValuesRef.current = migratedValues;

        const allFilled = missingParams.length > 0 && missingParams.every(
          (p) => (migratedValues[paramKey(p)] || "").trim().length > 0
        );
        setDisambigResolved(allFilled);

        const unfilledParams = missingParams.filter(
          (p) => !(migratedValues[paramKey(p)] || "").trim()
        );

        if (data.needs_clarification && !allFilled) {
          const q = data.clarification_question || t("spoken.needDetail", "Please specify the missing parameters to proceed.");
          speak(
            `${t("spoken.needDetail", "I have mapped out the workflow, but I need one detail.")} ${q}`,
            {
              onEnd: () => {
                const targetKey = unfilledParams.length > 0 ? paramKey(unfilledParams[0]) : null;
                startVoiceClarificationRef.current?.(targetKey);
              },
            }
          );
        } else {
          const stepCount = (data.steps || []).length;
          const reqApps = deriveRequiredApps(data);
          if (reqApps.length > 0) {
            try {
              const names = reqApps.map((a) => a.app);
              const routes = reqApps.map((a) => a.route);
              const statusRes = await getRequiredAppsStatus(userId, names, routes);
              const missingApps = (statusRes?.apps || []).filter((a) => !a.connected);
              if (missingApps.length > 0) {
                const missingNames = missingApps.map((a) => a.app).join(", ");
                speak(
                  t("spoken.connectAppsRequired", {
                    apps: missingNames,
                    defaultValue: `I have prepared your workflow. Before running, please connect ${missingNames} below.`,
                  })
                );
              } else {
                speak(
                  t("spoken.blueprintCreated", {
                    steps: stepCount,
                    defaultValue: `Great! I generated your workflow blueprint with ${stepCount} steps. Say 'Run it' or tap below to start.`,
                  })
                );
              }
            } catch (_statusErr) {
              speak(
                t("spoken.blueprintCreated", {
                  steps: stepCount,
                  defaultValue: `Great! I generated your workflow blueprint with ${stepCount} steps. Ready to run.`,
                })
              );
            }
          } else {
            speak(
              t("spoken.blueprintCreated", {
                steps: stepCount,
                defaultValue: `Great! I generated your workflow blueprint with ${stepCount} steps. Say 'Run it' or tap below to start.`,
              })
            );
          }
        }
      } catch (err) {
        setPlanError(err.message || "Failed to generate a blueprint.");
      } finally {
        setPlanning(false);
      }
    },
    [planning, userId, stopPolling, closeSocket, voiceLanguage, activeWebsiteLanguage, speak, t, setPrompt, originalPrompt, setOriginalPrompt]
  );

  const lastHandledPromptKeyRef = useRef(null);

  useEffect(() => {
    const initPrompt = location.state?.initialPrompt;
    if (!initPrompt) return;
    const promptKey = location.state?.timestamp
      ? `${initPrompt}_${location.state.timestamp}`
      : initPrompt;
    if (lastHandledPromptKeyRef.current !== promptKey) {
      lastHandledPromptKeyRef.current = promptKey;
      setPrompt(initPrompt);
      handleGenerate(initPrompt);
    }
  }, [location.state, handleGenerate, setPrompt]);

  const {
    isSupported: speechSupported,
    isRecording,
    isProcessing: speechProcessing,
    detectedLanguage: speechDetectedLanguage,
    boostInfo: speechBoostInfo,
    interimTranscript,
    error: speechError,
    toggle: toggleRecording,
    start: startRecording,
    stop: stopRecording,
  } = useSpeechRecognition({
    lang: voiceLanguage.speechCode,
    onFinalTranscript: (finalText) => {
      if (isListeningForDisambigRef.current) {
        handleVoiceDisambigResponseRef.current?.(finalText);
        return;
      }

      const currentBp = blueprintRef.current;
      if (currentBp && !planningRef.current && isRunCommand(finalText)) {
        const isBlockedDisambig = needsAttention(currentBp) && !disambigResolvedRef.current;
        const isBlockedApps = requiredAppsConnectedRef.current !== true;
        if (isBlockedDisambig) {
          speak(t("spoken.needClarificationFirst", "Please provide the missing details before running."));
          return;
        }
        if (isBlockedApps) {
          speak(t("spoken.connectAppsFirst", "Please connect the required accounts below before running."));
          return;
        }
        const status = runStatusRef.current;
        if (status === "idle" || status === "failed") {
          speak(t("spoken.startingWorkflow", "Starting your workflow now..."));
          handleSaveAndRunRef.current?.();
        }
        return;
      }

      setPrompt((prev) => (prev ? prev + " " + finalText : finalText).trim());
    },
  });
  startRecordingRef.current = startRecording;

  const handleStartVoiceClarification = useCallback(
    (paramKeyTarget = null) => {
      setActiveParamListening(paramKeyTarget);
      activeParamListeningRef.current = paramKeyTarget;
      setIsListeningForDisambig(true);
      isListeningForDisambigRef.current = true;
      startRecordingRef.current?.();
    },
    []
  );
  startVoiceClarificationRef.current = handleStartVoiceClarification;

  const handleStopVoiceClarification = useCallback(() => {
    setIsListeningForDisambig(false);
    isListeningForDisambigRef.current = false;
    setActiveParamListening(null);
    activeParamListeningRef.current = null;
    stopRecording();
  }, [stopRecording]);

  const applyValuesToBlueprint = useCallback((baseBlueprint, valuesMap) => {
    if (!baseBlueprint) return null;
    const updated = cloneBlueprint(baseBlueprint);
    (updated.missing_parameters || []).forEach((param) => {
      const key = paramKey(param);
      const value = valuesMap[key];
      if (value !== undefined && value !== "") {
        if (param.step_number === null || param.step_number === undefined || param.step_number === 'trigger') {
          if (!updated.trigger) updated.trigger = {};
          if (param.parameter_key === 'event_app') {
            updated.trigger.event_app = value;
            if (!updated.required_apps.includes(value)) {
              updated.required_apps.push(value);
            }
          } else if (param.parameter_key === 'event_target') {
            updated.trigger.event_target = value;
          } else {
            if (!updated.trigger.trigger_config) updated.trigger.trigger_config = {};
            updated.trigger.trigger_config[param.parameter_key] = value;
          }
        } else {
          const stepIndex = updated.steps.findIndex((s) => s.step_number === param.step_number);
          if (stepIndex !== -1) {
            updated.steps[stepIndex].parameters = {
              ...updated.steps[stepIndex].parameters,
              [param.parameter_key]: value,
            };
          }
        }

        updated.steps.forEach((step) => {
          if (step.app?.includes(param.parameter_key)) {
            step.app = value;
            if (!updated.required_apps.includes(value)) {
              updated.required_apps.push(value);
            }
          }
        });

        if (updated.trigger?.event_app?.includes && updated.trigger?.event_app?.includes(param.parameter_key)) {
          updated.trigger.event_app = value;
          if (!updated.required_apps.includes(value)) {
            updated.required_apps.push(value);
          }
        }
      }
    });

    if (updated.required_apps) {
      updated.required_apps = updated.required_apps.filter(app => !app.includes('{') && !app.includes('}'));
    }

    updated.needs_clarification = false;
    return updated;
  }, []);

  const handleVoiceDisambigResponse = useCallback(
    async (spokenText) => {
      const currentBlueprint = blueprintRef.current;
      if (!currentBlueprint || !currentBlueprint.missing_parameters?.length) return;
      setDisambigResolving(true);

      try {
        const targetedParamKey = activeParamListeningRef.current;
        // Always pass all missing parameters so that if the user speaks multiple or all details
        // at the same time, they are all extracted and filled simultaneously.
        const targetParams = currentBlueprint.missing_parameters;

        const targetedParam = targetedParamKey
          ? currentBlueprint.missing_parameters.find((p) => paramKey(p) === targetedParamKey)
          : null;
        const dynamicQuestion = targetedParam
          ? `Please specify ${targetedParam.label || targetedParam.parameter_key}. ${currentBlueprint.clarification_question || ""}`
          : currentBlueprint.clarification_question;

        // Full hands-free disambiguation extraction + validation + normalization
        const res = await resolveDisambiguation({
          clarificationQuestion: dynamicQuestion,
          missingParameters: targetParams,
          spokenAnswer: spokenText,
          existingValues: disambigValuesRef.current,
        });

        if (res?.is_valid === false) {
          speak(
            res.spoken_acknowledgement ||
              t(
                "spoken.couldNotExtract",
                "I didn't quite catch the specific detail for that. Could you please state it again?"
              ),
            {
              onEnd: () => {
                startVoiceClarificationRef.current?.(targetedParamKey || null);
              },
            }
          );
          return;
        }

        if (res?.resolved_values && Object.keys(res.resolved_values).length > 0) {
          const merged = { ...disambigValuesRef.current, ...res.resolved_values };
          setDisambigValues(merged);
          disambigValuesRef.current = merged;

          // Immediately reflect newly filled values on the blueprint step parameters
          const updated = applyValuesToBlueprint(currentBlueprint, merged);
          setBlueprint(updated);

          const allFilled = currentBlueprint.missing_parameters.every(
            (p) => (merged[paramKey(p)] || "").trim().length > 0
          );

          if (allFilled) {
            setDisambigResolved(true);
            speak(
              `${res.spoken_acknowledgement || ""} ${t("spoken.blueprintCreated", {
                steps: (currentBlueprint.steps || []).length,
                defaultValue: "Workflow blueprint updated and ready to run.",
              })}`
            );
          } else {
            const remainingParams = currentBlueprint.missing_parameters.filter(
              (p) => !(merged[paramKey(p)] || "").trim()
            );
            const nextParam = remainingParams[0];
            const nextPrompt = nextParam
              ? ` ${t("spoken.specifyParam", {
                  param: nextParam.label || nextParam.parameter_key,
                  defaultValue: `Please specify ${nextParam.label || nextParam.parameter_key}.`,
                })}`
              : ` ${t("spoken.provideRemaining", "Please provide the remaining details.")}`;

            speak(`${res.spoken_acknowledgement || "<happy> Got it."}${nextPrompt}`, {
              onEnd: () => {
                startVoiceClarificationRef.current?.(nextParam ? paramKey(nextParam) : null);
              },
            });
          }
        } else {
          speak(
            t(
              "spoken.couldNotExtract",
              "I could not extract that parameter. Could you please state it again?"
            ),
            {
              onEnd: () => {
                startVoiceClarificationRef.current?.(targetedParamKey || null);
              },
            }
          );
        }
      } catch (err) {
        console.error("Failed to resolve voice disambiguation:", err);
        speak(
          t(
            "spoken.troubleUnderstanding",
            "I had trouble understanding that. You can also type the value directly into the form."
          )
        );
      } finally {
        setDisambigResolving(false);
        setIsListeningForDisambig(false);
        isListeningForDisambigRef.current = false;
        setActiveParamListening(null);
        activeParamListeningRef.current = null;
      }
    },
    [applyValuesToBlueprint, speak, setDisambigValues, setBlueprint, setDisambigResolved, t]
  );
  handleVoiceDisambigResponseRef.current = handleVoiceDisambigResponse;

  const handleTextSubmit = (e) => {
    e.preventDefault();
    handleGenerate(prompt);
  };

  const handleDisambigChange = (key, value) => {
    setDisambigValues((prev) => {
      const merged = { ...prev, [key]: value };
      disambigValuesRef.current = merged;
      if (blueprintRef.current) {
        const updated = applyValuesToBlueprint(blueprintRef.current, merged);
        setBlueprint(updated);
      }
      return merged;
    });
  };

  const handleUpdateBlueprint = () => {
    if (!blueprint) return;
    const updated = applyValuesToBlueprint(blueprint, disambigValues);
    setBlueprint(updated);
    setDisambigResolved(true);
    speak(t("spoken.workflowSaved", "Workflow details saved. Ready to run."));
  };

  const blockedByDisambiguation = needsAttention(blueprint) && !disambigResolved;
  const blockedByRequiredApps = Boolean(blueprint) && requiredAppsConnected !== true;

  const handleSaveAndRun = async () => {
    if (!blueprint || blockedByDisambiguation || blockedByRequiredApps) return;
    announcedPauseIdsRef.current.clear();
    hasAnnouncedCompletionRef.current = false;
    speak(t("spoken.startingWorkflow", "Starting your workflow now..."));
    setMobileStudioTab("telemetry");
    setRunError(null);
    setLogs([]);
    setStepStatuses(Object.fromEntries(blueprint.steps.map((s) => [s.step_number, "pending"])));
    setLiveClarification(null);
    setResumeError(null);
    setRunStatus("saving");

    try {
      const currentVals = disambigValuesRef.current || disambigValues;
      const latestBlueprint = Object.keys(currentVals).length > 0
        ? applyValuesToBlueprint(blueprint, currentVals)
        : blueprint;
      const effectivePrompt = originalPrompt || latestBlueprint.original_prompt || prompt || latestBlueprint.title || "Untitled Agent";
      const payloadBlueprint = { ...latestBlueprint, original_prompt: effectivePrompt, require_approval: requireApproval };
      const { agent_id: newAgentId } = await createAgent({
        title: latestBlueprint.title || "Untitled Agent",
        originalPrompt: effectivePrompt,
        blueprint: payloadBlueprint,
        userId: userId,
      });
      setAgentId(newAgentId);

      connectTelemetrySocket(newAgentId);

      if (blueprint.trigger?.type === "webhook") {
        // Event-driven ("whenever X happens") agents don't run on the real
        // trigger yet — that depends on an actual external event, which
        // for most apps is itself a periodic poll on Composio's side (real
        // detection can take a couple of minutes even once everything's
        // wired correctly). Rather than leave the user with nothing but
        // "Listening…" and no way to know whether it actually works, run
        // one labeled test now with an AI-generated realistic sample event
        // through the exact same reaction steps (see
        // composio_engine.generate_sample_trigger_payload) — the live
        // listener stays armed for the real thing regardless of this
        // test's outcome.
        appendLog({
          level: "info",
          message: "Listener armed for real events. Running one test now with a sample event so you can confirm this works…",
        });
        setRunStatus("starting");
        await executeAgent(newAgentId, userId);
        setRunStatus("running");
        startPolling(newAgentId);
        return;
      }

      setRunStatus("starting");
      await executeAgent(newAgentId, userId);

      setRunStatus("running");
      startPolling(newAgentId);
    } catch (err) {
      setRunStatus("failed");
      setRunError(err.message || "Failed to save or start the agent.");
    }
  };
  handleSaveAndRunRef.current = handleSaveAndRun;

  const handleRequiredAppsStatusChange = useCallback(
    (allConnected) => {
      setRequiredAppsConnected(allConnected);
      if (
        prevAppsConnectedRef.current === false &&
        allConnected === true &&
        blueprintRef.current &&
        !needsAttention(blueprintRef.current)
      ) {
        speak(t("spoken.allAppsConnected", "All accounts are connected. Say 'Run it' or tap below to start."));
      }

      // Phase B: When apps become connected, introspect resources for open missing parameters that lack options
      const currBp = blueprintRef.current;
      if (currBp?.missing_parameters?.some((p) => !p.options || p.options.length === 0)) {
        const stepMap = {};
        (currBp.steps || []).forEach((s) => {
          if (s.step_number != null) stepMap[s.step_number] = s.app;
        });

        currBp.missing_parameters.forEach(async (param) => {
          if (param.options && param.options.length > 0) return;
          const app = param.step_number === "trigger" ? currBp.trigger?.event_app : stepMap[param.step_number];
          if (app) {
            try {
              const res = await introspectAppResources(userId, app, param.parameter_key);
              const found = res.data?.resources;
              if (found && found.length > 0) {
                setBlueprint((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    missing_parameters: (prev.missing_parameters || []).map((p) =>
                      p.step_number === param.step_number && p.parameter_key === param.parameter_key
                        ? { ...p, options: found, suggested_type: "select" }
                        : p
                    ),
                  };
                });
              }
            } catch {
              // best-effort introspection
            }
          }
        });
      }

      prevAppsConnectedRef.current = allConnected;
    },
    [setRequiredAppsConnected, speak, t, userId, setBlueprint]
  );

  const handleResume = async (answer) => {
    if (!agentId) return;
    speak(t("spoken.resumingWorkflow", "Resuming your workflow now..."));
    setResuming(true);
    setResumeError(null);
    try {
      await resumeAgent(agentId, answer);
      setLiveClarification(null);
      setRunStatus("running");
      startPolling(agentId);
    } catch (err) {
      setResumeError(err.message || "Failed to resume the agent with that answer.");
    } finally {
      setResuming(false);
    }
  };

  // Approve/Reject are typed actions against the pending action's own id
  // (POST /pending-actions/{id}/approve|reject) rather than free text piped
  // through /resume — rejecting genuinely halts/skips the step server-side
  // instead of being treated as if it were an answer.
  const handleApprove = async () => {
    if (!liveClarification?.id) return;
    speak(t("spoken.resumingWorkflow", "Resuming your workflow now..."));
    setResuming(true);
    setResumeError(null);
    try {
      await approvePendingAction(liveClarification.id);
      setLiveClarification(null);
      setRunStatus("running");
      startPolling(agentId);
    } catch (err) {
      setResumeError(err.message || "Failed to approve.");
    } finally {
      setResuming(false);
    }
  };

  const handleReject = async () => {
    if (!liveClarification?.id) return;
    setResuming(true);
    setResumeError(null);
    try {
      await rejectPendingAction(liveClarification.id, "Rejected by user");
      setLiveClarification(null);
      setRunStatus("running");
      startPolling(agentId);
    } catch (err) {
      setResumeError(err.message || "Failed to reject.");
    } finally {
      setResuming(false);
    }
  };

  const handleResetStudio = useCallback(() => {
    stopSpeaking();
    stopPolling();
    closeSocket();
    announcedPauseIdsRef.current.clear();
    hasAnnouncedCompletionRef.current = false;
    clearStudio();
  }, [stopSpeaking, stopPolling, closeSocket, clearStudio]);

  const isRunning =
    runStatus === "saving" || runStatus === "starting" || runStatus === "running" || runStatus === "needs_input";
  const runButtonLabel =
    runStatus === "saving"
      ? t("studio.saving")
      : runStatus === "starting"
      ? t("studio.starting")
      : runStatus === "running"
      ? t("studio.running")
      : runStatus === "needs_input"
      ? t("studio.waitingOnAnswer")
      : runStatus === "listening"
      ? t("studio.listeningForEvents")
      : blockedByRequiredApps
      ? t("studio.connectAppsFirst")
      : t("studio.saveAndRun");

  return (
    <div className="flex flex-col gap-4 md:gap-5 max-w-7xl mx-auto">
      {/* ─────────────────────────────────────────────────────────────
          1. MOBILE-NATIVE INTERFACE (< md)
          Gives 100% native mobile app feel:
          - Idle / Prompting: Focused Hero Voice Studio with Orb & Inspiration
          - Blueprint Active: Workflow Hub with Steps Timeline & Sticky Floating Action Bar
          ───────────────────────────────────────────────────────────── */}
      <div className="md:hidden">
        {!blueprint ? (
          <MobileStudioHero
            prompt={prompt}
            setPrompt={setPrompt}
            isRecording={isRecording}
            speechProcessing={speechProcessing}
            speechDetectedLanguage={speechDetectedLanguage}
            speechBoostInfo={speechBoostInfo}
            interimTranscript={interimTranscript}
            speechError={speechError}
            toggleRecording={toggleRecording}
            speechSupported={speechSupported}
            planning={planning}
            planError={planError}
            voiceLanguage={voiceLanguage}
            setVoiceLanguage={setVoiceLanguage}
            handleGenerate={handleGenerate}
            ttsEnabled={ttsEnabled}
            setTtsEnabled={setTtsEnabled}
            ttsVoice={ttsVoice}
            ttsPlaying={ttsPlaying}
          />
        ) : (
          <MobileWorkflowHub
            blueprint={blueprint}
            stepStatuses={stepStatuses}
            stepSkipReasons={stepSkipReasons}
            runStatus={runStatus}
            runError={runError}
            agentId={agentId}
            logs={logs}
            clearStudio={handleResetStudio}
            handleSaveAndRun={handleSaveAndRun}
            runButtonLabel={runButtonLabel}
            isRunning={isRunning}
            blockedByDisambiguation={blockedByDisambiguation}
            blockedByRequiredApps={blockedByRequiredApps}
            requireApproval={requireApproval}
            setRequireApproval={setRequireApproval}
            ttsEnabled={ttsEnabled}
            setTtsEnabled={setTtsEnabled}
            ttsVoice={ttsVoice}
            prompt={prompt}
            setPrompt={setPrompt}
            isRecording={isRecording}
            speechProcessing={speechProcessing}
            interimTranscript={interimTranscript}
            toggleRecording={toggleRecording}
            speechSupported={speechSupported}
            handleGenerate={handleGenerate}
            planning={planning}
            onOpenUpdateModal={() => setUpdateModalOpen(true)}
            disambiguationSlot={
              blueprint ? (
                <DisambiguationPanel
                  blueprint={blueprint}
                  values={disambigValues}
                  onChange={handleDisambigChange}
                  onUpdate={handleUpdateBlueprint}
                  approved={approved}
                  onApprovedChange={setApproved}
                  resolved={disambigResolved}
                  onSpeak={speak}
                  isListeningForDisambig={isListeningForDisambig}
                  onStartVoiceClarification={handleStartVoiceClarification}
                  onStopVoiceClarification={handleStopVoiceClarification}
                  disambigResolving={disambigResolving}
                  activeParamListening={activeParamListening}
                />
              ) : null
            }
            requiredAppsSlot={
              blueprint && !agentId ? (
                <RequiredAppsGate
                  requiredApps={deriveRequiredApps(blueprint)}
                  userId={userId}
                  onStatusChange={handleRequiredAppsStatusChange}
                />
              ) : null
            }
            pendingActionSlot={
              liveClarification ? (
                <PendingActionCard
                  question={liveClarification.question}
                  inputType={liveClarification.inputType}
                  reconnectApp={liveClarification.reconnectApp}
                  reconnectRoute={liveClarification.reconnectRoute}
                  userId={userId}
                  options={liveClarification.options}
                  onResume={handleResume}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onSpeak={speak}
                  busy={resuming}
                  error={resumeError}
                />
              ) : null
            }
          />
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────
          2. DESKTOP-NATIVE INTERFACE (>= md)
          Streamlined dual-column studio view for widescreen displays
          ───────────────────────────────────────────────────────────── */}
      <div className="hidden md:flex flex-col gap-5">
        {/* Header bar */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("studio.title")}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t("studio.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {blueprint && (
              <button
                type="button"
                onClick={() => setUpdateModalOpen(true)}
                disabled={planning || isRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 text-brand-600 dark:text-brand-300 border border-brand-500/20 text-sm font-semibold transition-all active:scale-95 shadow-2xs"
                title="Open popup to update workflow with new steps"
              >
                <Sparkles size={14} className="text-brand-500" />
                <span>{t("studio.updateWorkflow", "Update Steps")}</span>
              </button>
            )}
            {(blueprint || prompt || logs.length > 0) && (
              <button
                onClick={handleResetStudio}
                className="text-sm font-medium text-slate-500 hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                {t("studio.clear")}
              </button>
            )}
          </div>
        </div>

        {/* Desktop Streamlined Prompt Bar */}
        <form onSubmit={handleTextSubmit} className="glass-panel flex items-center gap-2 p-2 pl-4 relative z-20">
          <SendHorizontal size={18} className="text-slate-400 shrink-0" />
          <input
            value={
              isRecording || speechProcessing
                ? (interimTranscript ? `${prompt ? prompt + " " : ""}${interimTranscript}` : prompt)
                : prompt
            }
            onChange={(e) => setPrompt(e.target.value)}
            type="text"
            placeholder={t("studio.promptPlaceholder")}
            disabled={isRecording || speechProcessing}
            className="flex-1 bg-transparent outline-none text-base placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-60"
          />
          <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} className="shrink-0" />
          <button
            type="button"
            onClick={toggleRecording}
            disabled={!speechSupported || speechProcessing}
            aria-pressed={isRecording}
            aria-label={t("voice.toggleRecording")}
            title={speechSupported ? "Speak prompt with Gnani Prisma v3.0" : t("voice.notSupported")}
            className={`flex items-center justify-center w-10 h-10 rounded-xl transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
              isRecording
                ? "bg-red-500 text-white animate-pulse"
                : speechProcessing
                ? "bg-amber-500 text-white"
                : "bg-slate-900/5 dark:bg-white/5 text-slate-500 hover:text-brand-500"
            }`}
          >
            {speechProcessing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
          </button>
          <button
            type="submit"
            disabled={planning || !prompt.trim() || isRecording || speechProcessing}
            className="flex items-center gap-2 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 transition-colors shrink-0"
          >
            {planning && <Loader2 size={15} className="animate-spin" />}
            {planning ? t("studio.generating") : blueprint ? t("studio.updatePlan", "Update Plan") : t("studio.generate")}
          </button>
        </form>

        {speechDetectedLanguage && !isRecording && (
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium px-2 -mt-2">
            <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400">
              <Sparkles size={12} className="text-brand-500 shrink-0" />
              <span>
                Gnani Prisma v3.0:{" "}
                <span className="font-semibold uppercase tracking-wider">{speechDetectedLanguage}</span> (Code-Mix)
              </span>
            </span>
            {speechBoostInfo?.userEntitiesBoosted > 0 ? (
              <span
                className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shadow-sm"
                title={`Context boosted with vault entities: ${speechBoostInfo.keytermsApplied?.join(", ")}`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>
                  Context Boosted ({speechBoostInfo.userEntitiesBoosted} Vault Entities
                  {speechBoostInfo.keytermsApplied?.length ? `: ${speechBoostInfo.keytermsApplied.slice(0, 3).join(", ")}...` : ""})
                </span>
              </span>
            ) : (
              <span
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-500/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10"
                title="Gnani Prisma v3.0 automation keyterms active"
              >
                <span>Domain Keyterms Active</span>
              </span>
            )}
          </div>
        )}

        <VoiceFeedbackBar
          enabled={ttsEnabled}
          onToggleEnabled={setTtsEnabled}
          voice={ttsVoice}
          onVoiceChange={setTtsVoice}
          isPlaying={ttsPlaying}
          isLoading={ttsLoading}
          onStop={stopSpeaking}
        />

        {speechError && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertCircle size={16} className="shrink-0" />
            {speechError}
          </div>
        )}

        {planError && (
          <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={16} className="shrink-0" />
            {planError}
          </div>
        )}

        {blueprint && (
          <DisambiguationPanel
            blueprint={blueprint}
            values={disambigValues}
            onChange={handleDisambigChange}
            onUpdate={handleUpdateBlueprint}
            approved={approved}
            onApprovedChange={setApproved}
            resolved={disambigResolved}
            onSpeak={speak}
            isListeningForDisambig={isListeningForDisambig}
            onStartVoiceClarification={handleStartVoiceClarification}
            onStopVoiceClarification={handleStopVoiceClarification}
            disambigResolving={disambigResolving}
            activeParamListening={activeParamListening}
          />
        )}

        {blueprint && !agentId && (
          <RequiredAppsGate
            requiredApps={deriveRequiredApps(blueprint)}
            userId={userId}
            onStatusChange={handleRequiredAppsStatusChange}
          />
        )}

        {liveClarification && (
          <PendingActionCard
            question={liveClarification.question}
            inputType={liveClarification.inputType}
            reconnectApp={liveClarification.reconnectApp}
            reconnectRoute={liveClarification.reconnectRoute}
            userId={userId}
            options={liveClarification.options}
            onResume={handleResume}
            onApprove={handleApprove}
            onReject={handleReject}
            onSpeak={speak}
            busy={resuming}
            error={resumeError}
          />
        )}

        {blueprint && (
          <div className="glass-panel p-4 flex items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <div className="flex items-center gap-2 truncate">
                <Sparkles size={16} className="text-brand-500 shrink-0" />
                <span className="font-semibold truncate max-w-[260px]">{blueprint.title}</span>
              </div>
              <div className="w-px h-4 bg-slate-200 dark:bg-white/10 mx-2" />
              <label className="flex items-center gap-1.5 cursor-pointer hover:text-brand-600 transition-colors text-xs whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.target.checked)}
                  className="w-4 h-4 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 dark:bg-slate-700 focus:ring-brand-500 focus:ring-2 cursor-pointer"
                />
                <span className="text-slate-600 dark:text-slate-300">{t("studio.requireApproval")}</span>
              </label>
            </div>

            <div className="flex items-center gap-2.5 justify-end">
              {runStatus === "success" && (
                Object.values(stepStatuses || {}).includes("skipped") ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-700 dark:text-slate-300 border border-slate-400/30">
                    <MinusCircle size={13} className="text-slate-400 shrink-0" />
                    Finished (step skipped)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                    <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                    Completed
                  </span>
                )
              )}
              {runError && <span className="text-xs text-red-500 truncate max-w-[150px]">{runError}</span>}
              {agentId && <span className="text-xs text-slate-400 font-mono">#{agentId.slice(0, 8)}</span>}
              <button
                type="button"
                onClick={() => setUpdateModalOpen(true)}
                disabled={blockedByDisambiguation || isRunning || planning}
                className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/10 dark:hover:bg-white/15 text-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-200 dark:border-white/10 transition-colors shadow-2xs active:scale-95 cursor-pointer"
                title="Open popup to update workflow with text or voice"
              >
                <Sparkles size={14} className="text-brand-500" />
                <span>{t("studio.updateWorkflow", "Update Steps")}</span>
              </button>
              <button
                onClick={handleSaveAndRun}
                disabled={blockedByDisambiguation || blockedByRequiredApps || isRunning}
                className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-500 hover:shadow-lg hover:shadow-brand-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 transition-all active:scale-95 shadow-md"
              >
                {isRunning ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
                <span>{runButtonLabel}</span>
              </button>
            </div>
          </div>
        )}

        {/* Dual-column grid on desktop */}
        <div className="grid grid-cols-5 gap-5">
          <div className="col-span-3 glass-panel p-5 min-h-[420px] flex flex-col">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300 mb-4">
              <Workflow size={16} className="text-brand-500" />
              {t("studio.visualBlueprint")}
            </div>
            {planning ? (
              <div className="flex-1 space-y-3 animate-pulse">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-4">
                    <div className="w-10 h-10 rounded-full bg-slate-300/50 dark:bg-white/10 shrink-0" />
                    <div className="flex-1 h-20 rounded-xl bg-slate-300/40 dark:bg-white/5" />
                  </div>
                ))}
              </div>
            ) : (
              <BlueprintFlow
                blueprint={blueprint}
                stepStatuses={stepStatuses}
                stepSkipReasons={stepSkipReasons}
                onOpenUpdateModal={() => setUpdateModalOpen(true)}
                planning={planning}
              />
            )}
          </div>

          <div className="col-span-2 glass-panel p-5 min-h-[420px] flex flex-col">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300 mb-4">
              <Radio size={16} className="text-brand-500" />
              {t("studio.liveTelemetry")}
            </div>
            <TelemetryPanel runStatus={runStatus} logs={logs} />
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          3. BLUR LOADING SCREEN FOR WORKFLOW UPDATES & GENERATION
          Full-viewport backdrop blur modal with pulsing AI indicator
          indicating workflow is being updated until the new one appears.
          ───────────────────────────────────────────────────────────── */}
      {planning && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/60 dark:bg-black/75 backdrop-blur-md p-4 animate-fade-in">
          <div className="relative max-w-sm w-full mx-auto p-6 rounded-3xl bg-white/95 dark:bg-slate-900/95 border border-slate-200/80 dark:border-white/15 shadow-2xl flex flex-col items-center text-center">
            {/* Glowing Pulsing Icon Ring */}
            <div className="relative mb-4 flex items-center justify-center">
              <div className="absolute w-16 h-16 rounded-full bg-brand-500/20 animate-ping opacity-75" />
              <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-tr from-brand-600 to-indigo-500 flex items-center justify-center text-white shadow-lg shadow-brand-500/30">
                <Sparkles size={26} className="animate-pulse" />
              </div>
            </div>

            <h3 className="text-lg font-bold text-slate-900 dark:text-white">
              {blueprint
                ? t("studio.updatingWorkflowTitle", "Updating Workflow...")
                : t("studio.generatingWorkflowTitle", "Generating Workflow...")}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {blueprint
                ? t(
                    "studio.updatingWorkflowDesc",
                    "Analyzing your amendment, synthesizing new steps, and regenerating execution flow with AI..."
                  )
                : t(
                    "studio.generatingWorkflowDesc",
                    "Formulating automation blueprint, connecting tools, and setting up parameters..."
                  )}
            </p>

            {/* Pulsing Step Synthesis Badge */}
            <div className="mt-5 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-100 dark:bg-white/5 border border-slate-200/70 dark:border-white/10 text-[11px] font-medium text-slate-600 dark:text-slate-300">
              <Loader2 size={13} className="animate-spin text-brand-500" />
              <span>{t("studio.synthesizingSteps", "Synthesizing step dependencies & params")}</span>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          4. WORKFLOW UPDATE & AMENDMENT POPUP MODAL
          Accessible modal dialog to add new steps or modify the plan
          via text and Gnani Prisma v3.0 voice transcription.
          ───────────────────────────────────────────────────────────── */}
      <WorkflowUpdateModal
        isOpen={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        onUpdateWorkflow={(amendmentText) => handleGenerate(amendmentText, true)}
        planning={planning}
        voiceLanguage={voiceLanguage}
        currentBlueprint={blueprint}
      />
    </div>
  );
}
