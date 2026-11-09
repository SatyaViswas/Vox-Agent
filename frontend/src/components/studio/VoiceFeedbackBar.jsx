import React from "react";
import { Loader2, Sparkles, Square, Volume2, VolumeX } from "lucide-react";
import { TIMBRE_VOICE_OPTIONS } from "../../hooks/useVoiceFeedback";
import { useSettings } from "../../context/SettingsContext";

export default function VoiceFeedbackBar({
  enabled,
  onToggleEnabled,
  voice,
  onVoiceChange,
  isPlaying,
  isLoading,
  onStop,
}) {
  const { clonedVoice } = useSettings();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-xl bg-slate-900/5 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs text-slate-600 dark:text-slate-300">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggleEnabled(!enabled)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-colors ${
            enabled
              ? "bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/30"
              : "bg-slate-200/60 dark:bg-white/10 text-slate-400"
          }`}
          title={enabled ? "Mute automatic spoken voice responses" : "Enable automatic spoken responses via Gnani Timbre"}
        >
          {enabled ? <Volume2 size={14} className="text-brand-500" /> : <VolumeX size={14} />}
          <span>{enabled ? "Voice Feedback Active" : "Voice Feedback Muted"}</span>
        </button>

        <span className="hidden sm:inline-block text-slate-300 dark:text-white/20">|</span>

        <div className="flex items-center gap-1.5">
          <span className="text-slate-400 dark:text-slate-500">Timbre Voice:</span>
          <select
            value={voice}
            onChange={(e) => onVoiceChange(e.target.value)}
            disabled={!enabled}
            className="bg-transparent font-medium outline-none text-slate-700 dark:text-slate-200 cursor-pointer disabled:opacity-50"
          >
            {clonedVoice && (
              <option value="custom-clone" className="dark:bg-slate-900 font-bold text-fuchsia-600 dark:text-fuchsia-400">
                ✨ My Cloned Voice (Gnani VC)
              </option>
            )}
            {TIMBRE_VOICE_OPTIONS.map((opt) => (
              <option key={opt.name} value={opt.name} className="dark:bg-slate-900">
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isLoading && (
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
            <Loader2 size={12} className="animate-spin" />
            <span>Generating speech...</span>
          </div>
        )}

        {isPlaying && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-brand-600 dark:text-brand-400 font-medium">
              <span className="inline-block w-1.5 h-3 bg-brand-500 rounded-full animate-pulse" />
              <span className="inline-block w-1.5 h-4 bg-brand-500 rounded-full animate-pulse delay-75" />
              <span className="inline-block w-1.5 h-2 bg-brand-500 rounded-full animate-pulse delay-150" />
              <span className="ml-1">Speaking</span>
            </span>
            <button
              type="button"
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 font-medium text-[11px] transition-colors"
              title="Stop speaking"
            >
              <Square size={10} className="fill-current" />
              Stop
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 ml-1">
          <Sparkles size={11} className="text-brand-500" />
          <span>Gnani Timbre v3.0</span>
        </div>
      </div>
    </div>
  );
}

