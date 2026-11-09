import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Globe2,
  Loader2,
  Mic,
  Moon,
  Radio,
  Sparkles,
  Sun,
  Zap,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import useSpeechRecognition from "../hooks/useSpeechRecognition";

const QUICK_PROMPTS = [
  "Email me daily sheets report",
  "Send Telegram alert when form submitted",
  "Summarize unread Gmails in Notion",
];

export default function Landing() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const navigate = useNavigate();
  const { startGuestSession } = useAuth();
  const { theme, toggleTheme } = useTheme();

  // Voice dictation on Landing Page
  const {
    isRecording,
    isProcessing,
    interimTranscript,
    toggle: toggleRecording,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      const clean = (text || "").trim();
      if (!clean) return;
      setPrompt(clean);
      // Auto-navigate to studio with the spoken prompt
      startGuestSession();
      navigate("/studio", { state: { initialPrompt: clean } });
    },
  });

  const FEATURES = [
    {
      icon: Zap,
      title: t("landing.features.automationTitle"),
      description: t("landing.features.automationDesc"),
    },
    {
      icon: Sparkles,
      title: t("landing.features.blueprintTitle"),
      description: t("landing.features.blueprintDesc"),
    },
    {
      icon: Mic,
      title: t("landing.features.voiceTitle"),
      description: t("landing.features.voiceDesc"),
    },
  ];

  const handleTryGuest = () => {
    startGuestSession();
    navigate("/studio");
  };

  const handleQuickPrompt = (e) => {
    e.preventDefault();
    if (!prompt.trim()) {
      handleTryGuest();
      return;
    }
    startGuestSession();
    navigate("/studio", { state: { initialPrompt: prompt.trim() } });
  };

  const handleChipClick = (suggestion) => {
    startGuestSession();
    navigate("/studio", { state: { initialPrompt: suggestion } });
  };

  return (
    <div className="min-h-[100dvh] relative overflow-x-hidden flex flex-col justify-between selection:bg-brand-500/20">
      {/* Background ambient glowing orbs */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-32 w-80 sm:w-[36rem] h-80 sm:h-[36rem] rounded-full bg-brand-500/20 blur-[90px]" />
        <div className="absolute top-1/3 -right-32 w-72 sm:w-[32rem] h-72 sm:h-[32rem] rounded-full bg-fuchsia-500/20 blur-[90px]" />
        <div className="absolute -bottom-32 left-1/3 w-80 sm:w-[34rem] h-80 sm:h-[34rem] rounded-full bg-indigo-500/15 blur-[90px]" />
      </div>

      {/* Mobile-Native App Bar Header */}
      <header className="flex items-center justify-between px-4 sm:px-8 h-16 sm:h-20 shrink-0 pt-[env(safe-area-inset-top,0px)]">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-sm shadow-brand-500/30">
            <Sparkles size={19} />
          </div>
          <span className="font-bold text-base sm:text-lg tracking-tight">
            VoxAgent<span className="text-brand-500">.</span>
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={toggleTheme}
            aria-label={t("header.toggleTheme")}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            onClick={() => navigate("/auth")}
            className="rounded-xl border border-slate-300/70 dark:border-white/15 px-4 py-2 text-xs sm:text-sm font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation min-h-[38px]"
          >
            {t("landing.signIn")}
          </button>
        </div>
      </header>

      {/* Main Hero Container */}
      <main className="flex-1 px-4 sm:px-8 pt-8 sm:pt-16 pb-12 flex flex-col items-center text-center max-w-4xl mx-auto w-full">
        {/* Live Status Pill */}
        <div className="inline-flex items-center gap-2 rounded-full glass px-3.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 mb-6 shadow-xs border border-brand-500/20">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{t("landing.noSignup")}</span>
        </div>

        {/* Hero Title */}
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold tracking-tight max-w-3xl leading-[1.15]">
          {t("landing.heroTitlePrefix")}{" "}
          <span className="bg-gradient-to-r from-brand-500 via-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">
            {t("landing.heroTitleHighlight")}
          </span>
        </h1>

        {/* Hero Subtitle */}
        <p className="mt-4 sm:mt-5 max-w-xl text-sm sm:text-base md:text-lg text-slate-600 dark:text-slate-400 leading-relaxed">
          {t("landing.heroSubtitle")}
        </p>

        {/* Voice-First Quick Prompt Box */}
        <form onSubmit={handleQuickPrompt} className="mt-8 sm:mt-10 w-full max-w-xl">
          <div
            className={`glass-panel rounded-2xl flex items-center gap-2 p-2 pl-4 transition-all shadow-md border ${
              isRecording
                ? "border-emerald-500 ring-2 ring-emerald-500/30"
                : "border-slate-200/80 dark:border-white/15 focus-within:ring-2 focus-within:ring-brand-400/50"
            }`}
          >
            <input
              value={isRecording ? interimTranscript || "Listening to your prompt..." : prompt}
              onChange={(e) => setPrompt(e.target.value)}
              type="text"
              placeholder={t("landing.promptPlaceholder")}
              className={`flex-1 bg-transparent outline-none text-base placeholder:text-slate-400 dark:placeholder:text-slate-500 ${
                isRecording ? "text-emerald-600 dark:text-emerald-400 font-medium" : ""
              }`}
            />

            {/* Voice Mic Button */}
            <button
              type="button"
              onClick={() => toggleRecording()}
              className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all active:scale-95 touch-manipulation shrink-0 ${
                isRecording
                  ? "bg-emerald-500 text-white animate-pulse shadow-md shadow-emerald-500/40"
                  : isProcessing
                  ? "bg-brand-500/20 text-brand-500"
                  : "bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300 hover:text-brand-500"
              }`}
              title="Speak your workflow with Gnani Prisma"
              aria-label="Speak workflow"
            >
              {isProcessing ? (
                <Loader2 size={18} className="animate-spin text-brand-500" />
              ) : (
                <Mic size={18} className={isRecording ? "animate-bounce" : ""} />
              )}
            </button>

            {/* Submit Arrow CTA */}
            <button
              type="submit"
              className="flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 active:scale-95 text-white text-xs sm:text-sm font-semibold px-4 py-2.5 transition-all shrink-0 min-h-[40px] shadow-sm shadow-brand-500/25 touch-manipulation"
            >
              <span className="hidden sm:inline">{t("landing.runIt")}</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </form>

        {/* Quick prompt suggestion chips */}
        <div className="flex items-center justify-center gap-1.5 flex-wrap mt-3 max-w-xl">
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mr-1">
            Try:
          </span>
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handleChipClick(p)}
              className="px-2.5 py-1 rounded-full text-xs bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:border-brand-500/30 hover:text-brand-500 border border-transparent transition-all touch-manipulation active:scale-95 truncate max-w-[260px]"
            >
              "{p}"
            </button>
          ))}
        </div>

        {/* Prominent Instant Guest CTA */}
        <button
          onClick={handleTryGuest}
          className="mt-7 inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-brand-500 via-indigo-600 to-fuchsia-600 text-white font-bold text-sm sm:text-base px-8 py-3.5 shadow-lg shadow-brand-500/30 hover:shadow-brand-500/40 active:scale-[0.98] transition-all touch-manipulation min-h-[48px] w-full sm:w-auto"
        >
          <Zap size={18} />
          <span>{t("landing.tryGuestMode")}</span>
        </button>

        {/* Feature Cards Grid */}
        <div className="mt-14 sm:mt-20 grid grid-cols-1 sm:grid-cols-3 gap-3.5 sm:gap-5 w-full max-w-4xl text-left">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-200/70 dark:border-white/10 shadow-xs hover:border-brand-400/30 transition-all"
            >
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500/10 text-brand-500 mb-3 sm:mb-4">
                <Icon size={20} />
              </div>
              <h3 className="font-bold text-sm sm:text-base mb-1.5">{title}</h3>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                {description}
              </p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 text-center text-xs text-slate-400 border-t border-slate-200/50 dark:border-white/5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
        <p>VoxAgent © {new Date().getFullYear()} · Voice-Directed Autonomous AI Workforce</p>
      </footer>
    </div>
  );
}
