import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Compass,
  FileQuestion,
  HelpCircle,
  Mic,
  MicOff,
  PlayCircle,
  Sparkles,
  Volume2,
  X,
  Zap,
} from "lucide-react";

import { approvePendingAction, getPausedRuns, rejectPendingAction, resumeAgent } from "../../api/agents";
import { resolveVoiceAssistantIntent } from "../../api/voice";
import useSpeechRecognition from "../../hooks/useSpeechRecognition";
import { useVoiceFeedback } from "../../hooks/useVoiceFeedback";
import { useStudioStore } from "../../store/studioStore";
import { useTheme } from "../../context/ThemeContext";
import { useSettings } from "../../context/SettingsContext";
import { useLanguage } from "../../context/LanguageContext";

const DEFAULT_QUICK_PROMPTS = [
  "Send an email with project updates to mvsviswas@gmail.com",
  "Extract full sheet from Google Sheets and create a Doc",
  "Send an alert on Telegram personal account",
  "Open App Vault to connect my tools",
];

export default function GlobalVoiceModal({ open, onClose }) {
  const { t } = useTranslation();
  const { currentLanguage } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { openSettings } = useSettings();

  const [activeIntentResult, setActiveIntentResult] = useState(null);
  const [analyzingIntent, setAnalyzingIntent] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [activePausedRun, setActivePausedRun] = useState(null);

  const { speak, stop: stopSpeaking, isPlaying: isSpeaking } = useVoiceFeedback();

  // Read current studio state
  const blueprint = useStudioStore((state) => state.blueprint);
  const disambigValues = useStudioStore((state) => state.disambigValues);
  const liveClarification = useStudioStore((state) => state.liveClarification);
  const agentId = useStudioStore((state) => state.agentId);

  // Check for paused runs across the workspace when modal opens
  useEffect(() => {
    if (!open) {
      setActiveIntentResult(null);
      setErrorMsg(null);
      setActivePausedRun(null);
      return;
    }

    // If we don't already have liveClarification in store, check backend /paused
    if (!liveClarification) {
      getPausedRuns()
        .then((res) => {
          const pausedMap = res?.paused_runs || {};
          const keys = Object.keys(pausedMap);
          if (keys.length > 0) {
            const first = pausedMap[keys[0]];
            setActivePausedRun(first);
          }
        })
        .catch(() => {});
    }
  }, [open, liveClarification]);

  // Handle intent execution
  const executeIntent = useCallback(
    async (intentResult) => {
      setActiveIntentResult(intentResult);
      setErrorMsg(null);

      // Trigger mobile haptic feedback if supported
      if (typeof window !== "undefined" && window.navigator?.vibrate) {
        try {
          window.navigator.vibrate([40, 30, 40]);
        } catch {
          // ignore
        }
      }

      // Spoken voice acknowledgement via Gnani Timbre
      if (intentResult.spoken_acknowledgement) {
        speak(intentResult.spoken_acknowledgement, {
          force: true,
        });
      }

      const delayClose = (ms = 1100) => {
        setTimeout(() => {
          onClose();
        }, ms);
      };

      try {
        switch (intentResult.intent) {
          case "resume_paused": {
            const targetAgentId = intentResult.agent_id || activePausedRun?.agent_id || agentId;
            const targetPendingId = activePausedRun?.id;

            if (intentResult.action === "approve" && targetPendingId) {
              await approvePendingAction(targetPendingId);
            } else if (intentResult.action === "reject" && targetPendingId) {
              await rejectPendingAction(targetPendingId, intentResult.answer || "Rejected by user voice command");
            } else if (targetAgentId) {
              await resumeAgent(targetAgentId, intentResult.answer || "Proceed");
            }

            // Update local Zustand store
            useStudioStore.setState({
              liveClarification: null,
              runStatus: "running",
            });

            // If not in studio, navigate there to see the resumed execution
            if (location.pathname !== "/studio") {
              navigate("/studio");
            }
            delayClose(1200);
            break;
          }

          case "update_blueprint": {
            if (intentResult.resolved_values) {
              useStudioStore.setState((prev) => ({
                disambigValues: {
                  ...prev.disambigValues,
                  ...intentResult.resolved_values,
                },
                disambigResolved:
                  intentResult.all_resolved !== null && intentResult.all_resolved !== undefined
                    ? intentResult.all_resolved
                    : prev.disambigResolved,
              }));
            }

            if (location.pathname !== "/studio") {
              navigate("/studio");
            }
            delayClose(1000);
            break;
          }

          case "run_agent": {
            navigate(intentResult.route || "/agents");
            delayClose(900);
            break;
          }

          case "navigate": {
            if (intentResult.route) {
              navigate(intentResult.route);
            }
            delayClose(800);
            break;
          }

          case "open_settings": {
            openSettings(intentResult.action || "general");
            delayClose(600);
            break;
          }

          case "change_theme": {
            if (intentResult.action === "dark" && theme !== "dark") {
              toggleTheme();
            } else if (intentResult.action === "light" && theme !== "light") {
              toggleTheme();
            } else if (!intentResult.action) {
              toggleTheme();
            }
            delayClose(1000);
            break;
          }

          case "general": {
            // General guidance - keep modal open so operator can speak next command
            break;
          }

          case "create_workflow":
          default: {
            const prompt = intentResult.prompt || "";
            navigate("/studio", {
              state: {
                initialPrompt: prompt,
                autoGenerate: true,
                timestamp: Date.now(),
              },
            });
            delayClose(900);
            break;
          }
        }
      } catch (err) {
        console.error("Intent execution error:", err);
        setErrorMsg(err.message || "Failed to execute voice command.");
      }
    },
    [activePausedRun, agentId, location.pathname, navigate, onClose, openSettings, speak, theme, toggleTheme]
  );

  // Process final transcribed speech
  const handleFinalSpeech = useCallback(
    async (spokenText) => {
      const clean = (spokenText || "").trim();
      if (!clean) return;

      setAnalyzingIntent(true);
      setErrorMsg(null);

      // Determine active context
      const effectiveClarification = liveClarification || (activePausedRun ? {
        question: activePausedRun.question,
        input_type: activePausedRun.input_type,
        agent_id: activePausedRun.agent_id,
        id: activePausedRun.id,
      } : null);

      const voiceContext = {
        has_live_clarification: Boolean(effectiveClarification),
        live_question: effectiveClarification?.question || null,
        live_agent_id: effectiveClarification?.agent_id || agentId || null,
        live_input_type: effectiveClarification?.input_type || null,
        live_pending_id: effectiveClarification?.id || null,

        has_blueprint: Boolean(blueprint),
        blueprint_title: blueprint?.title || null,
        missing_parameters: blueprint?.missing_parameters || null,
        existing_disambig_values: disambigValues || {},

        current_route: location.pathname,
      };

      try {
        const langCode =
          currentLanguage?.speechCode && currentLanguage.speechCode !== "indic-auto"
            ? currentLanguage.speechCode
            : currentLanguage?.uiCode || "en";
        const intentResult = await resolveVoiceAssistantIntent(clean, voiceContext, langCode);
        setAnalyzingIntent(false);
        await executeIntent(intentResult);
      } catch (err) {
        console.error("Failed to resolve voice intent:", err);
        setAnalyzingIntent(false);
        setErrorMsg(err.message || "Could not interpret voice command.");
      }
    },
    [activePausedRun, agentId, blueprint, currentLanguage, disambigValues, executeIntent, liveClarification, location.pathname]
  );

  const {
    isRecording,
    isProcessing,
    interimTranscript,
    start: startRecording,
    stop: stopRecording,
    error: micError,
  } = useSpeechRecognition({
    lang: "indic-auto",
    autoSilenceStop: true,
    onFinalTranscript: (finalText) => {
      handleFinalSpeech(finalText);
    },
  });

  // Auto-start recording on modal open
  useEffect(() => {
    if (open) {
      stopSpeaking();
      const t = setTimeout(() => {
        startRecording();
      }, 150);
      return () => clearTimeout(t);
    } else {
      stopRecording();
      stopSpeaking();
    }
  }, [open, startRecording, stopRecording, stopSpeaking]);

  if (!open) return null;

  const currentClarification = liveClarification || activePausedRun;
  const hasMissingParams =
    blueprint?.missing_parameters && blueprint.missing_parameters.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:justify-center items-center p-0 md:p-4 transition-all">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-md transition-opacity"
        onClick={() => {
          stopRecording();
          stopSpeaking();
          onClose();
        }}
      />

      {/* Mobile-Native Bottom Sheet / Desktop Modal Dialog */}
      <div className="relative w-full max-w-lg rounded-t-[2rem] md:rounded-3xl bg-white/95 dark:bg-slate-900/98 border border-slate-200/80 dark:border-white/10 p-6 md:p-8 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col items-center animate-fade-in pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] max-h-[92vh] overflow-y-auto">
        {/* Mobile Drag Indicator Bar */}
        <div className="md:hidden w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20 mb-3 shrink-0" />

        {/* Close Button */}
        <button
          onClick={() => {
            stopRecording();
            stopSpeaking();
            onClose();
          }}
          className="absolute top-4 right-4 p-2.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          aria-label="Close Assistant"
        >
          <X size={20} />
        </button>

        {/* Context Sensing Badge / Alert Banner */}
        {currentClarification ? (
          <div className="w-full flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-700 dark:text-amber-200 text-xs font-medium mb-4 animate-pulse">
            <AlertCircle size={16} className="text-amber-500 dark:text-amber-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold block text-[11px] uppercase tracking-wider text-amber-600 dark:text-amber-300">
                {t("globalVoice.workflowWaiting")}
              </span>
              <p className="truncate text-xs text-amber-800 dark:text-amber-100">{currentClarification.question}</p>
            </div>
          </div>
        ) : hasMissingParams ? (
          <div className="w-full flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-purple-500/15 border border-purple-500/30 text-purple-700 dark:text-purple-200 text-xs font-medium mb-4">
            <FileQuestion size={16} className="text-purple-500 dark:text-purple-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold block text-[11px] uppercase tracking-wider text-purple-600 dark:text-purple-300">
                {t("globalVoice.blueprintMissing")}
              </span>
              <p className="truncate text-xs text-purple-800 dark:text-purple-100">
                {blueprint.missing_parameters[0]?.description || "Provide required details"}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-brand-500/10 dark:bg-brand-500/20 border border-brand-500/20 dark:border-brand-500/30 text-brand-600 dark:text-brand-300 text-xs font-medium mb-4">
            <Sparkles size={13} className="text-brand-500 dark:text-brand-400" />
            <span>{t("globalVoice.sovereignAssistant")}</span>
          </div>
        )}

        {/* Central Voice Orb with Wave Animations */}
        <div className="relative flex items-center justify-center my-3 shrink-0">
          {/* Animated Glowing Wave Rings */}
          {isRecording && (
            <>
              <div className="absolute w-36 h-36 rounded-full border border-brand-500/35 animate-wave-ring" />
              <div className="absolute w-48 h-48 rounded-full border border-fuchsia-500/25 animate-wave-ring [animation-delay:0.5s]" />
              <div className="absolute w-60 h-60 rounded-full border border-brand-400/15 animate-wave-ring [animation-delay:1.0s]" />
            </>
          )}

          <button
            type="button"
            onClick={() => {
              if (isRecording) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
            className={`relative z-10 flex items-center justify-center w-24 h-24 rounded-full bg-gradient-to-tr from-brand-600 via-brand-500 to-fuchsia-500 text-white shadow-[0_8px_30px_rgba(109,84,255,0.4)] transition-all active:scale-95 ${
              isRecording ? "animate-voice-glow ring-4 ring-brand-400/40" : "opacity-85 hover:opacity-100"
            }`}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? (
              <Mic size={38} className="animate-pulse" />
            ) : (
              <MicOff size={34} className="text-white/80" />
            )}
          </button>
        </div>

        {/* Live Status & Audio Feedback Indicator */}
        <div className="text-center mt-2 mb-4 max-w-sm px-2 min-h-[4.75rem] flex flex-col items-center justify-center">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold mb-1 text-slate-500 dark:text-slate-400">
            {isSpeaking ? (
              <>
                <Volume2 size={14} className="text-brand-500 dark:text-brand-400 animate-pulse" />
                <span className="text-brand-600 dark:text-brand-300">{t("globalVoice.speakingFeedback")}</span>
              </>
            ) : analyzingIntent ? (
              <>
                <Sparkles size={14} className="text-fuchsia-500 dark:text-fuchsia-400 animate-spin" />
                <span className="text-fuchsia-600 dark:text-fuchsia-300">{t("globalVoice.understandingIntent")}</span>
              </>
            ) : isProcessing ? (
              <>
                <Zap size={14} className="text-amber-500 dark:text-amber-400 animate-pulse" />
                <span className="text-amber-600 dark:text-amber-300">{t("globalVoice.transcribing")}</span>
              </>
            ) : isRecording ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping inline-block mr-1" />
                <span className="text-emerald-600 dark:text-emerald-400">{t("globalVoice.listening")}</span>
              </>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">{t("globalVoice.tapToSpeak")}</span>
            )}
          </div>

          {/* Transcript / Result Display */}
          <p className="text-base font-medium text-slate-800 dark:text-slate-100 min-h-[1.75rem] transition-all line-clamp-2">
            {activeIntentResult ? (
              <span className="text-brand-600 dark:text-brand-300 font-semibold flex items-center justify-center gap-1.5">
                <CheckCircle2 size={16} className="text-emerald-500 dark:text-emerald-400" />
                {activeIntentResult.display_title}
              </span>
            ) : interimTranscript ? (
              interimTranscript
            ) : currentClarification ? (
              <span className="text-slate-500 dark:text-slate-400 italic text-sm">
                Say your answer, or &ldquo;proceed&rdquo; / &ldquo;extract full sheet&rdquo;
              </span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400 italic text-sm">
                &ldquo;Create an agent to email project summary every morning...&rdquo;
              </span>
            )}
          </p>

          {(micError || errorMsg) && (
            <p className="text-xs text-rose-500 dark:text-rose-400 mt-1.5 flex items-center justify-center gap-1 font-medium">
              <AlertCircle size={13} />
              {micError || errorMsg}
            </p>
          )}
        </div>

        {/* Action Result Pill if resolved */}
        {activeIntentResult && (
          <div className="w-full bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/15 rounded-2xl p-3.5 mb-4 animate-scale-in">
            <div className="flex items-center justify-between text-xs text-brand-600 dark:text-brand-300 font-medium mb-1">
              <span className="flex items-center gap-1.5">
                {activeIntentResult.intent === "resume_paused" && <PlayCircle size={14} className="text-emerald-500 dark:text-emerald-400" />}
                {activeIntentResult.intent === "update_blueprint" && <Zap size={14} className="text-purple-500 dark:text-purple-400" />}
                {activeIntentResult.intent === "navigate" && <Compass size={14} className="text-cyan-500 dark:text-cyan-400" />}
                {activeIntentResult.intent === "create_workflow" && <Sparkles size={14} className="text-brand-500 dark:text-brand-400" />}
                {activeIntentResult.display_title}
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 capitalize">{activeIntentResult.intent.replace("_", " ")}</span>
            </div>
            <p className="text-xs text-slate-700 dark:text-slate-300 truncate">{activeIntentResult.display_detail}</p>
          </div>
        )}

        {/* Contextual Quick Suggestion Chips */}
        <div className="w-full mt-1">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2 font-medium">
            <span>{currentClarification ? t("globalVoice.quickAnswers") : t("globalVoice.orTryAsking")}</span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">{t("globalVoice.autoStops")}</span>
          </div>

          <div className="flex flex-col gap-2">
            {currentClarification ? (
              <>
                <button
                  type="button"
                  onClick={() => handleFinalSpeech("Approve and proceed")}
                  className="text-left text-xs text-slate-800 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 rounded-xl px-3.5 py-2.5 transition-all flex items-center justify-between group active:scale-[0.98]"
                >
                  <span className="font-medium text-emerald-600 dark:text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 size={14} /> &ldquo;{t("globalVoice.approveAndProceed")}&rdquo;
                  </span>
                  <ArrowRight size={13} className="text-emerald-500 dark:text-emerald-400" />
                </button>
                <button
                  type="button"
                  onClick={() => handleFinalSpeech("Extract full sheet")}
                  className="text-left text-xs text-slate-800 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/25 rounded-xl px-3.5 py-2.5 transition-all flex items-center justify-between group active:scale-[0.98]"
                >
                  <span className="font-medium text-brand-600 dark:text-brand-300">&ldquo;{t("globalVoice.extractSheet")}&rdquo;</span>
                  <ArrowRight size={13} className="text-brand-500 dark:text-brand-400" />
                </button>
                <button
                  type="button"
                  onClick={() => handleFinalSpeech("Cancel action")}
                  className="text-left text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-xl px-3.5 py-2 transition-all flex items-center justify-between group active:scale-[0.98]"
                >
                  <span>&ldquo;{t("globalVoice.cancelExecution")}&rdquo;</span>
                  <X size={13} className="text-slate-400" />
                </button>
              </>
            ) : hasMissingParams ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const firstParam = blueprint.missing_parameters[0];
                    const hint = firstParam?.description || firstParam?.parameter_key;
                    handleFinalSpeech(`My ${hint}`);
                  }}
                  className="text-left text-xs text-purple-800 dark:text-purple-200 hover:text-purple-900 dark:hover:text-white bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/25 rounded-xl px-3.5 py-2.5 transition-all flex items-center justify-between group active:scale-[0.98]"
                >
                  <span className="truncate pr-2 font-medium">
                    &ldquo;Answer: {blueprint.missing_parameters[0]?.parameter_key}&rdquo;
                  </span>
                  <ArrowRight size={13} className="shrink-0 text-purple-500 dark:text-purple-400" />
                </button>
                {DEFAULT_QUICK_PROMPTS.slice(0, 2).map((prompt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleFinalSpeech(prompt)}
                    className="text-left text-xs text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100/80 dark:bg-white/5 hover:bg-slate-200/70 dark:hover:bg-white/10 border border-slate-200/60 dark:border-white/5 rounded-xl px-3.5 py-2.5 transition-all flex items-center justify-between group active:scale-[0.98]"
                  >
                    <span className="truncate pr-2">{prompt}</span>
                    <Volume2 size={13} className="shrink-0 text-slate-400 dark:text-slate-500 group-hover:text-brand-500 dark:group-hover:text-brand-400" />
                  </button>
                ))}
              </>
            ) : (
              DEFAULT_QUICK_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleFinalSpeech(prompt)}
                  className="text-left text-xs text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100/80 dark:bg-white/5 hover:bg-slate-200/70 dark:hover:bg-white/10 border border-slate-200/60 dark:border-white/5 rounded-xl px-3.5 py-2.5 transition-all flex items-center justify-between group active:scale-[0.98]"
                >
                  <span className="truncate pr-2">{prompt}</span>
                  <Volume2 size={13} className="shrink-0 text-slate-400 dark:text-slate-500 group-hover:text-brand-500 dark:group-hover:text-brand-400 transition-colors" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
