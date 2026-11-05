import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, Mic, PlayCircle, Radio, SendHorizontal, Sparkles, Workflow } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useVoiceFeedback } from "../hooks/useVoiceFeedback";
import { useVoiceLanguage } from "../hooks/useVoiceLanguage";
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
import BlueprintFlow from "../components/studio/BlueprintFlow";
import DisambiguationPanel, { paramKey } from "../components/studio/DisambiguationPanel";
import PendingActionCard from "../components/studio/PendingActionCard";
import RequiredAppsGate from "../components/studio/RequiredAppsGate";
import TelemetryPanel from "../components/studio/TelemetryPanel";

const POLL_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

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
  return failed > 0 ? `${failed} of ${entries.length} step(s) failed` : `${entries.length} step(s) executed successfully`;
}

import { useStudioStore } from "../store/studioStore";

export default function AgentStudio() {
  const location = useLocation();
  const { userId } = useAuth();
  const { t } = useTranslation();
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();

  const {
    enabled: ttsEnabled,
    setEnabled: setTtsEnabled,
    voice: ttsVoice,
    setVoice: setTtsVoice,
    isPlaying: ttsPlaying,
    isLoading: ttsLoading,
    speak,
    stop: stopSpeaking,
  } = useVoiceFeedback({ defaultLanguage: voiceLanguage.speechCode });

  const {
    prompt, setPrompt,
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
    liveClarification, setLiveClarification,
    resuming, setResuming,
    resumeError, setResumeError,
    requireApproval, setRequireApproval,
    clearStudio
  } = useStudioStore();

  const [isListeningForDisambig, setIsListeningForDisambig] = useState(false);
  const [activeParamListening, setActiveParamListening] = useState(null);
  const [disambigResolving, setDisambigResolving] = useState(false);

  const isListeningForDisambigRef = useRef(false);
  const activeParamListeningRef = useRef(null);
  const disambigValuesRef = useRef(disambigValues);
  disambigValuesRef.current = disambigValues;
  const blueprintRef = useRef(blueprint);
  blueprintRef.current = blueprint;
  const startVoiceClarificationRef = useRef(null);
  const startRecordingRef = useRef(null);
  const handleVoiceDisambigResponseRef = useRef(null);

  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const lastLogIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const activeAgentIdRef = useRef(null);

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
      const needsInputMatch = message.match(/^Step (\d+) needs clarification/);
      if (executingMatch) {
        setStepStatuses((prev) => ({ ...prev, [Number(executingMatch[1])]: "executing" }));
      } else if (completedMatch) {
        setStepStatuses((prev) => ({ ...prev, [Number(completedMatch[1])]: "success" }));
      } else if (failedMatch) {
        setStepStatuses((prev) => ({ ...prev, [Number(failedMatch[1])]: "failed" }));
      } else if (needsInputMatch) {
        setStepStatuses((prev) => ({ ...prev, [Number(needsInputMatch[1])]: "needs_input" }));
        setRunStatus("needs_input");
        stopPolling();
      } else if (message === "Workflow execution completed.") {
        setRunStatus("success");
        speak("Workflow execution completed successfully! <excited> All actions were carried out.");
        stopPolling();
        closeSocket();
      } else if (message === "Workflow execution failed.") {
        setRunStatus("failed");
        speak("<sigh> The workflow encountered an error during execution.");
        stopPolling();
        closeSocket();
      }
    },
    [stopPolling, closeSocket, speak]
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
        });
        if (entry.question) {
          const cleanQ = entry.question.replace(/```json[\s\S]*?```/g, "").trim();
          speak(`<curious> The agent paused and needs your input. </curious> ${cleanQ}`);
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
            if (eventType === "clarification_needed") {
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

          (latest.log_messages || []).forEach((entry) => {
            const entryStatus = entry.result?.status;
            setStepStatuses((prev) => ({
              ...prev,
              [entry.step]: entryStatus === "error" ? "failed" : entryStatus === "needs_input" ? "needs_input" : "success",
            }));
          });

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
          stopPolling();
          closeSocket();
        } catch {
          // transient network/poll error — keep trying on next tick
        }
      }, POLL_INTERVAL_MS);
    },
    [appendLog, stopPolling, closeSocket, fetchAndSetLiveClarification]
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
    async (rawPrompt) => {
      const text = (rawPrompt ?? "").trim();
      if (!text || planning) return;

      stopPolling();
      closeSocket();
      setPlanning(true);
      setPlanError(null);
      setBlueprint(null);
      setDisambigValues({});
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
        // right before the existing (unmodified) planner call. planWorkflow
        // itself never knows a non-English string was involved. Detection is
        // based on the text itself (not just the language picker) so a
        // mismatched or forgotten selection still translates correctly.
        const englishText = needsTranslation(text, voiceLanguage.uiCode)
          ? await translateText(text, "auto")
          : text;
        const data = await planWorkflow(englishText, userId);
        setBlueprint(data);
        setStepStatuses(Object.fromEntries((data.steps || []).map((s) => [s.step_number, "pending"])));

        if (data.needs_clarification) {
          const q = data.clarification_question || "Please specify the missing parameters to proceed.";
          speak(`I have mapped out the workflow, but I need one detail. <pauses> ${q}`, {
            onEnd: () => {
              startVoiceClarificationRef.current?.(null);
            },
          });
        } else {
          const stepCount = (data.steps || []).length;
          speak(`Great! <excited> I generated your workflow blueprint with ${stepCount} steps. Ready to run.`);
        }
      } catch (err) {
        setPlanError(err.message || "Failed to generate a blueprint.");
      } finally {
        setPlanning(false);
      }
    },
    [planning, userId, stopPolling, closeSocket, voiceLanguage, speak]
  );

  useEffect(() => {
    if (location.state?.initialPrompt) {
      setPrompt(location.state.initialPrompt);
      handleGenerate(location.state.initialPrompt);
    }
    // Only ever runs once, off the initial navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      } else {
        setPrompt((prev) => (prev ? prev + " " + finalText : finalText).trim());
      }
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
        let targetParams = currentBlueprint.missing_parameters;
        if (targetedParamKey) {
          const matched = currentBlueprint.missing_parameters.filter(
            (p) => paramKey(p) === targetedParamKey
          );
          if (matched.length > 0) {
            targetParams = matched;
          }
        }

        // Full hands-free disambiguation extraction + validation + normalization
        const res = await resolveDisambiguation({
          clarificationQuestion: currentBlueprint.clarification_question,
          missingParameters: targetParams,
          spokenAnswer: spokenText,
          existingValues: disambigValuesRef.current,
        });

        if (res?.is_valid === false) {
          speak(
            res.spoken_acknowledgement ||
              "I didn't quite catch the specific detail for that. Could you please state it again?",
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

          const allFilled = currentBlueprint.missing_parameters.every(
            (p) => (merged[paramKey(p)] || "").trim().length > 0
          );

          if (allFilled) {
            const updated = applyValuesToBlueprint(currentBlueprint, merged);
            setBlueprint(updated);
            setDisambigResolved(true);
            speak(
              `${res.spoken_acknowledgement || "<excited> Perfect!"} Workflow blueprint updated and ready to run.`
            );
          } else {
            const remainingParams = currentBlueprint.missing_parameters.filter(
              (p) => !(merged[paramKey(p)] || "").trim()
            );
            const nextParam = remainingParams[0];
            const nextPrompt = nextParam
              ? ` Please specify ${nextParam.label || nextParam.parameter_key}.`
              : " Please provide the remaining details.";

            speak(`${res.spoken_acknowledgement || "<happy> Got it."}${nextPrompt}`, {
              onEnd: () => {
                startVoiceClarificationRef.current?.(nextParam ? paramKey(nextParam) : null);
              },
            });
          }
        } else {
          speak("I could not extract that parameter. Could you please state it again?", {
            onEnd: () => {
              startVoiceClarificationRef.current?.(targetedParamKey || null);
            },
          });
        }
      } catch (err) {
        console.error("Failed to resolve voice disambiguation:", err);
        speak("I had trouble understanding that. You can also type the value directly into the form.");
      } finally {
        setDisambigResolving(false);
        setIsListeningForDisambig(false);
        isListeningForDisambigRef.current = false;
        setActiveParamListening(null);
        activeParamListeningRef.current = null;
      }
    },
    [applyValuesToBlueprint, speak, setDisambigValues, setBlueprint, setDisambigResolved]
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
    speak("<happy> Workflow details saved. Ready to run. </happy>");
  };

  const blockedByDisambiguation = needsAttention(blueprint) && !disambigResolved;
  const blockedByRequiredApps = Boolean(blueprint) && requiredAppsConnected !== true;

  const handleSaveAndRun = async () => {
    if (!blueprint || blockedByDisambiguation || blockedByRequiredApps) return;
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
      const payloadBlueprint = { ...latestBlueprint, require_approval: requireApproval };
      const { agent_id: newAgentId } = await createAgent({
        title: latestBlueprint.title || "Untitled Agent",
        originalPrompt: prompt,
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

  const handleResume = async (answer) => {
    if (!agentId) return;
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
    <div className="flex flex-col gap-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("studio.title")}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t("studio.subtitle")}</p>
        </div>
        {(blueprint || prompt || logs.length > 0) && (
          <button
            onClick={clearStudio}
            className="text-sm font-medium text-slate-500 hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            {t("studio.clear")}
          </button>
        )}
      </div>

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
          className="flex-1 bg-transparent outline-none text-sm md:text-base placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-60"
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
          {planning ? t("studio.generating") : t("studio.generate")}
        </button>
      </form>

      {speechDetectedLanguage && !isRecording && (
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium px-2 -mt-2">
          <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400">
            <Sparkles size={12} className="text-brand-500 shrink-0" />
            <span>Gnani Prisma v3.0: <span className="font-semibold uppercase tracking-wider">{speechDetectedLanguage}</span> (Code-Mix)</span>
          </span>
          {speechBoostInfo?.userEntitiesBoosted > 0 ? (
            <span
              className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shadow-sm"
              title={`Context boosted with vault entities: ${speechBoostInfo.keytermsApplied?.join(", ")}`}
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Context Boosted ({speechBoostInfo.userEntitiesBoosted} Vault Entities{speechBoostInfo.keytermsApplied?.length ? `: ${speechBoostInfo.keytermsApplied.slice(0, 3).join(", ")}...` : ""})</span>
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
          onStatusChange={setRequiredAppsConnected}
        />
      )}

      {liveClarification && (
        <PendingActionCard
          question={liveClarification.question}
          inputType={liveClarification.inputType}
          reconnectApp={liveClarification.reconnectApp}
          reconnectRoute={liveClarification.reconnectRoute}
          userId={userId}
          onResume={handleResume}
          onApprove={handleApprove}
          onReject={handleReject}
          onSpeak={speak}
          busy={resuming}
          error={resumeError}
        />
      )}

      {blueprint && (
        <div className="glass-panel flex flex-col md:flex-row items-center justify-between gap-4 p-4">
          <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 w-full md:w-auto">
            <Sparkles size={16} className="text-brand-500 shrink-0" />
            <span className="font-medium truncate max-w-[250px]">{blueprint.title}</span>
            <div className="hidden md:block w-px h-4 bg-slate-200 dark:bg-white/10 mx-2" />
            <label className="flex items-center gap-2 cursor-pointer hover:text-brand-600 transition-colors whitespace-nowrap">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                className="w-4 h-4 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 dark:bg-slate-700 focus:ring-brand-500 focus:ring-2 cursor-pointer"
              />
              {t("studio.requireApproval")}
            </label>
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto justify-end">
            {runError && <span className="text-xs text-red-500">{runError}</span>}
            {agentId && <span className="text-xs text-slate-400 font-mono">#{agentId.slice(0, 8)}</span>}
            <button
              onClick={handleSaveAndRun}
              disabled={blockedByDisambiguation || blockedByRequiredApps || isRunning}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-500 hover:shadow-lg hover:shadow-brand-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2.5 transition-all"
            >
              {isRunning ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
              {runButtonLabel}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 glass-panel p-5 min-h-[420px] flex flex-col">
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
            <BlueprintFlow blueprint={blueprint} stepStatuses={stepStatuses} />
          )}
        </div>

        <div className="lg:col-span-2 glass-panel p-5 min-h-[420px] flex flex-col">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300 mb-4">
            <Radio size={16} className="text-brand-500" />
            {t("studio.liveTelemetry")}
          </div>
          <TelemetryPanel runStatus={runStatus} logs={logs} />
        </div>
      </div>
    </div>
  );
}
