import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Globe,
  Loader2,
  Mic,
  MicOff,
  SendHorizontal,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import VoiceLanguagePicker from "../shared/VoiceLanguagePicker";

const STUDIO_QUICK_PROMPTS = [
  {
    icon: "📧",
    title: "Email Summary",
    text: "Send an email with a project summary to mvsviswas@gmail.com",
    tag: "Gmail",
  },
  {
    icon: "📊",
    title: "Sheets to Docs",
    text: "Extract full sheet from Google Sheets and create a summary in Google Docs",
    tag: "Sheets + Docs",
  },
  {
    icon: "⚡",
    title: "Telegram Alert",
    text: "Send a message on Telegram personal account with today's status",
    tag: "Telegram",
  },
  {
    icon: "📝",
    title: "Notion to Slack",
    text: "Read recent items from Notion and post an update to Slack",
    tag: "Notion + Slack",
  },
];

export default function MobileStudioHero({
  prompt,
  setPrompt,
  isRecording,
  speechProcessing,
  speechDetectedLanguage,
  speechBoostInfo,
  interimTranscript,
  speechError,
  toggleRecording,
  speechSupported,
  planning,
  planError,
  voiceLanguage,
  setVoiceLanguage,
  handleGenerate,
  ttsEnabled,
  setTtsEnabled,
  ttsVoice,
  ttsPlaying,
}) {
  const { t } = useTranslation();
  const [showTextKeyboard, setShowTextKeyboard] = useState(false);

  const activeTranscript = isRecording || speechProcessing
    ? (interimTranscript ? `${prompt ? prompt + " " : ""}${interimTranscript}` : prompt)
    : prompt;

  return (
    <div className="flex flex-col items-center w-full max-w-md mx-auto pt-2 pb-6 animate-fade-in">
      {/* Sovereign Engine Pill */}
      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-600 dark:text-brand-300 text-[11px] font-medium mb-4 shadow-sm">
        <Sparkles size={12} className="text-brand-500" />
        <span>Gnani Prisma v3.0 • Voice-First Studio</span>
      </div>

      {/* Main Title & Tagline */}
      <div className="text-center mb-6 px-4">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t("mobileStudio.titlePrefix")} <br />
          <span className="bg-gradient-to-r from-brand-500 via-fuchsia-500 to-indigo-500 bg-clip-text text-transparent">
            {t("mobileStudio.titleHighlight")}
          </span>
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-xs mx-auto">
          {t("mobileStudio.subtitle")}
        </p>
      </div>

      {/* Hero Voice Orb Interaction */}
      <div className="relative flex flex-col items-center justify-center my-3 w-full">
        {/* Animated Radiant Rings while recording */}
        {isRecording && (
          <>
            <div className="absolute w-40 h-40 rounded-full border border-brand-500/40 animate-wave-ring" />
            <div className="absolute w-52 h-52 rounded-full border border-fuchsia-500/25 animate-wave-ring [animation-delay:0.5s]" />
            <div className="absolute w-64 h-64 rounded-full border border-brand-400/15 animate-wave-ring [animation-delay:1.0s]" />
          </>
        )}

        <button
          type="button"
          onClick={toggleRecording}
          disabled={!speechSupported || speechProcessing || planning}
          className={`relative z-10 flex items-center justify-center w-28 h-28 rounded-full bg-gradient-to-tr from-brand-600 via-brand-500 to-fuchsia-500 text-white shadow-[0_10px_35px_rgba(109,84,255,0.45)] transition-all active:scale-90 ${
            isRecording ? "animate-voice-glow ring-8 ring-brand-400/30 scale-105" : "hover:scale-102"
          }`}
          aria-label={isRecording ? "Stop recording" : "Speak workflow"}
        >
          {speechProcessing ? (
            <Loader2 size={42} className="animate-spin text-white" />
          ) : isRecording ? (
            <Mic size={42} className="animate-pulse" />
          ) : (
            <Mic size={40} className="text-white drop-shadow-sm" />
          )}
        </button>

        {/* Live Audio / Status Pill */}
        <div className="text-center mt-4 mb-2 max-w-xs px-2 min-h-[3rem] flex flex-col items-center justify-center">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
            {speechProcessing ? (
              <span className="text-amber-500 dark:text-amber-400 flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> {t("mobileStudio.transcribing")}
              </span>
            ) : isRecording ? (
              <span className="text-emerald-500 dark:text-emerald-400 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" /> {t("mobileStudio.listening")}
              </span>
            ) : planning ? (
              <span className="text-brand-500 flex items-center gap-1">
                <Sparkles size={12} className="animate-spin" /> {t("mobileStudio.planning")}
              </span>
            ) : (
              <span>{t("mobileStudio.tapToSpeak")}</span>
            )}
          </div>

          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 mt-1 line-clamp-2 px-1">
            {activeTranscript || (
              <span className="text-slate-400 dark:text-slate-500 italic text-xs">
                &ldquo;Extract leads from Google Sheets, summarize with AI, and send to my email...&rdquo;
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Language & Voice Feedback Toolbar */}
      <div className="flex items-center justify-between w-full px-2 py-1.5 mb-4">
        {/* Language selector */}
        <div className="flex items-center gap-1">
          <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} align="left" />
          {speechDetectedLanguage && !isRecording && (
            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-500 border border-brand-500/20">
              {speechDetectedLanguage}
            </span>
          )}
        </div>

        {/* Compact TTS Toggle */}
        <button
          type="button"
          onClick={() => setTtsEnabled(!ttsEnabled)}
          className={`flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full transition-colors ${
            ttsEnabled
              ? "bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/20"
              : "bg-black/5 dark:bg-white/5 text-slate-400"
          }`}
          title={ttsEnabled ? "Voice feedback enabled" : "Voice feedback muted"}
        >
          {ttsPlaying ? (
            <Volume2 size={13} className="text-brand-500 animate-pulse" />
          ) : ttsEnabled ? (
            <Volume2 size={13} />
          ) : (
            <VolumeX size={13} />
          )}
          <span>{ttsVoice}</span>
        </button>
      </div>

      {/* Prompt Text Input Card (Always accessible via one tap or when text exists) */}
      <div className="w-full glass-panel rounded-2xl p-3.5 shadow-sm border border-slate-200/80 dark:border-white/10 mb-4 transition-all">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {t("mobileStudio.promptLabel")}
          </span>
          {prompt && (
            <button
              type="button"
              onClick={() => setPrompt("")}
              className="text-[11px] text-slate-400 hover:text-red-500 transition-colors flex items-center gap-0.5"
            >
              <X size={12} /> {t("mobileStudio.clear")}
            </button>
          )}
        </div>

        <textarea
          rows={3}
          value={activeTranscript}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("mobileStudio.placeholder")}
          disabled={isRecording || speechProcessing || planning}
          className="w-full bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none resize-none leading-relaxed"
        />

        {/* Generate Button inside the card */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/5 mt-1">
          <span className="text-[10px] text-slate-400">
            {prompt ? t("mobileStudio.characters", { count: prompt.length }) : t("mobileStudio.voiceOrType")}
          </span>

          <button
            type="button"
            onClick={() => handleGenerate(prompt)}
            disabled={planning || !prompt?.trim() || isRecording || speechProcessing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-500 hover:from-brand-600 hover:to-fuchsia-600 disabled:opacity-40 text-white font-semibold text-xs shadow-md shadow-brand-500/20 active:scale-95 transition-all"
          >
            {planning ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>{t("mobileStudio.generating")}</span>
              </>
            ) : (
              <>
                <span>{t("mobileStudio.generate")}</span>
                <SendHorizontal size={13} />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Errors (Mic / Plan) */}
      {speechError && (
        <div className="w-full mb-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>{speechError}</span>
        </div>
      )}
      {planError && (
        <div className="w-full mb-3 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>{planError}</span>
        </div>
      )}

      {/* Fast Inspiration Cards Carousel */}
      <div className="w-full mt-2">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium mb-2 px-1">
          <span>Popular Voice Workflows</span>
          <span className="text-[10px] text-slate-400">Tap to load</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {STUDIO_QUICK_PROMPTS.map((item, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setPrompt(item.text);
                handleGenerate(item.text);
              }}
              className="text-left p-3 rounded-2xl bg-white/70 dark:bg-white/5 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/40 transition-all active:scale-95 flex flex-col justify-between group shadow-sm"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-lg">{item.icon}</span>
                <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300">
                  {item.tag}
                </span>
              </div>
              <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-200 group-hover:text-brand-500 transition-colors">
                {item.title}
              </h4>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-snug">
                {item.text}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

