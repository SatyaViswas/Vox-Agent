import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  X,
  Mic,
  Loader2,
  Wand2,
  ArrowRight,
  PlusCircle,
  Volume2,
} from "lucide-react";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";

export default function WorkflowUpdateModal({
  isOpen,
  onClose,
  onUpdateWorkflow,
  planning = false,
  voiceLanguage,
  currentBlueprint,
}) {
  const { t } = useTranslation();
  const [promptText, setPromptText] = useState("");
  const textareaRef = useRef(null);

  const {
    isRecording,
    isProcessing,
    interimTranscript,
    start: startRecording,
    stop: stopRecording,
    toggle: toggleRecording,
    isSupported: speechSupported,
  } = useSpeechRecognition({
    lang: voiceLanguage?.speechCode || "indic-auto",
    onFinalTranscript: (transcript) => {
      const text = (transcript || "").trim();
      if (!text) return;
      setPromptText((prev) => (prev ? `${prev} ${text}` : text));
    },
  });

  // Focus textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
      }, 100);
    } else {
      setPromptText("");
    }
  }, [isOpen]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen && !planning) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, planning]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    if (e) e.preventDefault();
    const clean = promptText.trim();
    if (!clean || planning) return;
    onUpdateWorkflow(clean);
    onClose();
  };

  const displayText =
    isRecording || isProcessing
      ? interimTranscript
        ? `${promptText ? promptText + " " : ""}${interimTranscript}`
        : promptText
      : promptText;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
      {/* Backdrop Click Dismiss */}
      <div
        className="fixed inset-0"
        onClick={() => {
          if (!planning) onClose();
        }}
      />

      {/* Modal Dialog Card */}
      <div
        className="relative w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-white/10 shadow-2xl overflow-hidden z-10 transition-all transform animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-100 dark:border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-brand-500/20">
              <Sparkles size={17} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                {t("studio.updateWorkflowModalTitle", "Update Workflow & Add Steps")}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {currentBlueprint?.title ? `Amending "${currentBlueprint.title}"` : "Add or modify automation steps"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={planning}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div className="relative rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-black/30 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 transition-all p-3">
            <textarea
              ref={textareaRef}
              rows={4}
              value={displayText}
              onChange={(e) => setPromptText(e.target.value)}
              disabled={planning}
              placeholder={
                isRecording
                  ? "Listening to your voice... speak steps or amendments to add..."
                  : t(
                      "studio.updateWorkflowModalPlaceholder",
                      "Describe new steps to add or modify. e.g.:\n- 'Add a step to send a summary email to user@example.com'\n- 'Also send an alert to Telegram'\n- 'Save results into Google Sheets Daily Orders'"
                    )
              }
              className="w-full bg-transparent resize-none text-xs sm:text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none leading-relaxed"
            />

            {/* Voice & Live indicator footer inside textarea */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-200/50 dark:border-white/5 mt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleRecording}
                  disabled={!speechSupported || isProcessing || planning}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                    isRecording
                      ? "bg-red-500 text-white animate-pulse shadow-md"
                      : isProcessing
                      ? "bg-amber-500 text-white"
                      : "bg-brand-500/10 hover:bg-brand-500/20 text-brand-600 dark:text-brand-400 border border-brand-500/20"
                  }`}
                  title={speechSupported ? "Speak your update with Gnani Prisma voice" : "Microphone not supported"}
                >
                  {isProcessing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Mic size={13} className={isRecording ? "animate-bounce" : ""} />
                  )}
                  <span>{isRecording ? "Listening..." : isProcessing ? "Transcribing..." : "Speak Update"}</span>
                </button>

                {isRecording && (
                  <span className="text-[11px] text-red-500 dark:text-red-400 animate-pulse font-medium">
                    Gnani Prisma v3.0 Active
                  </span>
                )}
              </div>

              {promptText && !planning && (
                <button
                  type="button"
                  onClick={() => setPromptText("")}
                  className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Quick Idea Chips */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              Quick suggestions:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {[
                "Add step to send an email summary",
                "Add step to post alert on Telegram",
                "Save execution results to Google Sheets",
                "Add human approval gate before sending",
              ].map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => {
                    setPromptText((prev) => (prev ? `${prev}. ${sug}` : sug));
                    if (textareaRef.current) textareaRef.current.focus();
                  }}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/5 hover:bg-brand-500/10 hover:text-brand-600 dark:hover:text-brand-300 text-slate-600 dark:text-slate-300 border border-transparent hover:border-brand-500/20 transition-all text-left"
                >
                  + {sug}
                </button>
              ))}
            </div>
          </div>

          {/* Modal Action Buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-white/5">
            <button
              type="button"
              onClick={onClose}
              disabled={planning}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={!promptText.trim() || planning || isRecording}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-md shadow-brand-500/20 transition-all active:scale-95"
            >
              {planning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              <span>{t("studio.updateWorkflowSubmit", "Update Workflow")}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

