import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AlertCircle, Loader2, Mic, PlayCircle, Radio, SendHorizontal, Sparkles, Workflow } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { createAgent, executeAgent, getAgentLogs, planWorkflow, resumeAgent, telemetrySocketUrl } from "../api/agents";
import BlueprintFlow from "../components/studio/BlueprintFlow";
import DisambiguationPanel, { paramKey } from "../components/studio/DisambiguationPanel";
import LiveClarificationPanel from "../components/studio/LiveClarificationPanel";
import RequiredAppsGate from "../components/studio/RequiredAppsGate";
import TelemetryPanel from "../components/studio/TelemetryPanel";

const POLL_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

function cloneBlueprint(blueprint) {
  return typeof structuredClone === "function" ? structuredClone(blueprint) : JSON.parse(JSON.stringify(blueprint));
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

export default function AgentStudio() {
  const location = useLocation();
  const { userId } = useAuth();

  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [blueprint, setBlueprint] = useState(null);

  const [disambigValues, setDisambigValues] = useState({});
  const [approved, setApproved] = useState(false);
  const [disambigResolved, setDisambigResolved] = useState(false);
  // null while checking, true/false once known — gates "Save & Run" so an
  // agent never gets created with an app it actually needs disconnected
  // (see RequiredAppsGate).
  const [requiredAppsConnected, setRequiredAppsConnected] = useState(null);

  const [agentId, setAgentId] = useState(null);
  const [runStatus, setRunStatus] = useState("idle");
  const [runError, setRunError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [stepStatuses, setStepStatuses] = useState({});

  const [liveClarification, setLiveClarification] = useState(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState(null);
  const [requireApproval, setRequireApproval] = useState(true);

  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const lastLogIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const activeAgentIdRef = useRef(null);

  const appendLog = useCallback((entry) => {
    setLogs((prev) => [...prev, { ...entry, timestamp: new Date().toLocaleTimeString() }]);
  }, []);

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
        stopPolling();
        closeSocket();
      } else if (message === "Workflow execution failed.") {
        setRunStatus("failed");
        stopPolling();
        closeSocket();
      }
    },
    [stopPolling, closeSocket]
  );

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
            if (data.data?.type === "clarification_needed") {
              setResumeError(null);
              setLiveClarification({ step: data.data.step, question: data.data.question, reconnectApp: data.data.reconnect_app });
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
    [appendLog, applyStatusFromMessage]
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
            // The WS clarification_needed event already surfaces this — polling
            // just needs to stop hammering the run so it doesn't get overwritten
            // as "failed" while we're waiting on the user's answer.
            const pausedEntry = (latest.log_messages || []).find((e) => e.result?.status === "needs_input");
            setRunStatus("needs_input");
            setLiveClarification((prev) => prev || { step: pausedEntry?.step, question: pausedEntry?.result?.question });
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
    [appendLog, stopPolling, closeSocket]
  );

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
        const data = await planWorkflow(text, userId);
        setBlueprint(data);
        setStepStatuses(Object.fromEntries((data.steps || []).map((s) => [s.step_number, "pending"])));
      } catch (err) {
        setPlanError(err.message || "Failed to generate a blueprint.");
      } finally {
        setPlanning(false);
      }
    },
    [planning, userId, stopPolling, closeSocket]
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
    interimTranscript,
    toggle: toggleRecording,
  } = useSpeechRecognition({
    onFinalTranscript: (finalText) => {
      setPrompt(finalText);
      handleGenerate(finalText);
    },
  });

  useEffect(() => {
    if (isRecording && interimTranscript) setPrompt(interimTranscript);
  }, [isRecording, interimTranscript]);

  const handleTextSubmit = (e) => {
    e.preventDefault();
    handleGenerate(prompt);
  };

  const handleDisambigChange = (key, value) => {
    setDisambigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleUpdateBlueprint = () => {
    if (!blueprint) return;
    const updated = cloneBlueprint(blueprint);
    (updated.missing_parameters || []).forEach((param) => {
      const value = disambigValues[paramKey(param)];
      const stepIndex = updated.steps.findIndex((s) => s.step_number === param.step_number);
      if (stepIndex !== -1 && value !== undefined) {
        updated.steps[stepIndex].parameters = {
          ...updated.steps[stepIndex].parameters,
          [param.parameter_key]: value,
        };
      }
    });
    updated.needs_clarification = false;
    setBlueprint(updated);
    setDisambigResolved(true);
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
      const payloadBlueprint = { ...blueprint, require_approval: requireApproval };
      const { agent_id: newAgentId } = await createAgent({
        title: blueprint.title || "Untitled Agent",
        original_prompt: prompt,
        json_blueprint: payloadBlueprint,
        trigger_type: blueprint.trigger ? "event_trigger" : blueprint.schedule ? "scheduled" : "manual",
        cron_schedule: blueprint.schedule?.cron || null,
        user_id: userId,
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

  const isRunning =
    runStatus === "saving" || runStatus === "starting" || runStatus === "running" || runStatus === "needs_input";
  const runButtonLabel =
    runStatus === "saving"
      ? "Saving Agent…"
      : runStatus === "starting"
      ? "Starting…"
      : runStatus === "running"
      ? "Running…"
      : runStatus === "needs_input"
      ? "Waiting on your answer…"
      : runStatus === "listening"
      ? "Listening for events…"
      : blockedByRequiredApps
      ? "Connect required apps first"
      : "Save & Run Agent";

  return (
    <div className="flex flex-col gap-5 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent Studio</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Describe a task in plain English and watch VoxAgent plan and execute it live.
        </p>
      </div>

      <form onSubmit={handleTextSubmit} className="glass-panel flex items-center gap-2 p-2 pl-4">
        <SendHorizontal size={18} className="text-slate-400 shrink-0" />
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          type="text"
          placeholder="Tell VoxAgent what to do..."
          disabled={isRecording}
          className="flex-1 bg-transparent outline-none text-sm md:text-base placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={toggleRecording}
          disabled={!speechSupported}
          aria-pressed={isRecording}
          aria-label="Toggle voice recording"
          title={speechSupported ? "Speak your prompt" : "Voice input isn't supported in this browser"}
          className={`flex items-center justify-center w-10 h-10 rounded-xl transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
            isRecording
              ? "bg-red-500 text-white animate-pulse"
              : "bg-slate-900/5 dark:bg-white/5 text-slate-500 hover:text-brand-500"
          }`}
        >
          <Mic size={18} />
        </button>
        <button
          type="submit"
          disabled={planning || !prompt.trim()}
          className="flex items-center gap-2 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 transition-colors shrink-0"
        >
          {planning && <Loader2 size={15} className="animate-spin" />}
          {planning ? "Generating…" : "Generate Agent"}
        </button>
      </form>

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
        />
      )}

      {blueprint && !agentId && (
        <RequiredAppsGate
          requiredApps={blueprint.required_apps}
          userId={userId}
          onStatusChange={setRequiredAppsConnected}
        />
      )}

      {liveClarification && (
        <LiveClarificationPanel
          question={liveClarification.question}
          step={liveClarification.step}
          reconnectApp={liveClarification.reconnectApp}
          onResume={handleResume}
          resuming={resuming}
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
              Require approval for sensitive actions
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
            Visual Blueprint
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
            Live Telemetry
          </div>
          <TelemetryPanel runStatus={runStatus} logs={logs} />
        </div>
      </div>
    </div>
  );
}
