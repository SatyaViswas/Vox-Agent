import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Globe,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  Mic,
  Moon,
  Play,
  Radio,
  Settings,
  Shield,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Square,
  Sun,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { useSettings } from "../../context/SettingsContext";
import { useTheme } from "../../context/ThemeContext";
import { useLanguage } from "../../context/LanguageContext";
import { useAuth } from "../../context/AuthContext";
import { LANGUAGES } from "../../i18n/languages";
import { TIMBRE_VOICE_OPTIONS } from "../../hooks/useVoiceFeedback";
import { synthesizeSpeech, synthesizeClonedVoice, getStreamingSpeechUrl } from "../../api/voice";
import VoiceCloneModal from "./VoiceCloneModal";

const TABS = [
  { id: "general", label: "Appearance & Language", icon: Globe },
  { id: "voice", label: "Voice & Persona", icon: Mic },
  { id: "account", label: "Account & Profile", icon: User },
  { id: "safety", label: "AI & Safety", icon: ShieldCheck },
];

export default function SettingsModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const {
    isOpen,
    closeSettings,
    activeTab,
    setActiveTab,
    ttsVoice,
    setTtsVoice,
    ttsEnabled,
    setTtsEnabled,
    clonedVoice,
    deleteClonedVoice,
    hapticsEnabled,
    setHapticsEnabled,
    autoHeal,
    setAutoHeal,
    confirmHighRisk,
    setConfirmHighRisk,
  } = useSettings();

  const { theme, toggleTheme } = useTheme();
  const { siteLanguage, setSiteLanguage } = useLanguage();
  const { isGuest, isAuthenticated, userId, signOut } = useAuth();

  const [isVoiceCloneOpen, setIsVoiceCloneOpen] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const audioRef = useRef(null);

  // Stop any playing preview when modal closes
  useEffect(() => {
    if (!isOpen && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPreviewingVoice(null);
      setPreviewLoading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePreviewVoice = async (voiceName) => {
    if (previewingVoice === voiceName) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPreviewingVoice(null);
      setPreviewLoading(false);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    setPreviewingVoice(voiceName);
    setPreviewLoading(true);

    try {
      let res;
      const activeSpeechLang =
        currentLanguage?.speechCode && currentLanguage.speechCode !== "indic-auto"
          ? currentLanguage.speechCode === "en-US"
            ? "en-IN"
            : currentLanguage.speechCode
          : "hi-IN";

      if (voiceName === "custom-clone" && clonedVoice?.embedding) {
        const sampleText = t(
          "spoken.samplePreviewClone",
          "Hello! This is your cloned voice on VoxAgent. I will confirm blueprints, guide executions, and speak updates clearly."
        );
        res = await synthesizeClonedVoice({
          text: sampleText,
          speaker_embedding: clonedVoice.embedding,
          language: activeSpeechLang,
        });
      } else {
        const sampleText = t("spoken.samplePreview", {
          voice: voiceName,
          defaultValue: `Hello! I am ${voiceName}, your voice assistant for VoxAgent. I will confirm blueprints, guide executions, and speak updates clearly.`,
        });
        res = {
          audioUrl: getStreamingSpeechUrl({
            text: sampleText,
            voice: voiceName,
            language: activeSpeechLang,
            model: "timbre-v3.0",
            container: "mp3",
          }),
        };
      }

      if (res?.audioUrl) {
        const audio = new Audio(res.audioUrl);
        audioRef.current = audio;
        audio.onended = () => {
          setPreviewingVoice(null);
          setPreviewLoading(false);
          audioRef.current = null;
        };
        audio.onerror = () => {
          setPreviewingVoice(null);
          setPreviewLoading(false);
          audioRef.current = null;
        };
        await audio.play();
      }
    } catch (err) {
      console.error("Preview voice failed:", err);
      setPreviewingVoice(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCopyUserId = async () => {
    if (userId) {
      await navigator.clipboard.writeText(userId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  };

  const handleClearCache = () => {
    try {
      localStorage.removeItem("voxagent_disambiguation_history");
      localStorage.removeItem("voxagent_telemetry_cache");
      setResetSuccess(true);
      setTimeout(() => setResetSuccess(false), 2500);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={closeSettings}
      />

      {/* Modal / Sheet Container */}
      <div className="relative w-full sm:max-w-3xl rounded-t-[2rem] sm:rounded-3xl bg-white dark:bg-slate-900 border-t sm:border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col max-h-[92vh] sm:max-h-[85vh] overflow-hidden pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-0 animate-slide-up">
        {/* Mobile Pull Handle */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center cursor-pointer" onClick={closeSettings}>
          <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20" />
        </div>

        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
              <Settings size={18} />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">{t("settings.title") || "App Settings"}</h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {t("settings.subtitle") || "Personalize your voice, interface, and execution preferences"}
              </p>
            </div>
          </div>

          <button
            onClick={closeSettings}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>

        {/* Horizontal Tabs for Mobile & Desktop */}
        <div className="flex items-center gap-1.5 px-4 sm:px-5 py-2.5 border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/20 overflow-x-auto no-scrollbar shrink-0">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            const tabKey = `settings.tab${tab.id.charAt(0).toUpperCase() + tab.id.slice(1)}`;
            const label = t(tabKey) || tab.label;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all active:scale-95 ${
                  active
                    ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Body Content Area */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* ───────────────── 1. APPEARANCE & LANGUAGE TAB ───────────────── */}
          {activeTab === "general" && (
            <div className="space-y-6 animate-fade-in">
              {/* Theme Picker */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  {t("settings.themeTitle") || "Appearance Theme"}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (theme !== "light") toggleTheme();
                    }}
                    className={`p-4 rounded-2xl border text-left flex items-start gap-3 transition-all active:scale-98 ${
                      theme === "light"
                        ? "border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/25"
                        : "border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 hover:border-slate-300"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
                      <Sun size={20} />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs text-slate-900 dark:text-white">{t("settings.lightMode") || "Light Mode"}</h4>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {t("settings.lightModeDesc") || "High-contrast, crisp daytime interface"}
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (theme !== "dark") toggleTheme();
                    }}
                    className={`p-4 rounded-2xl border text-left flex items-start gap-3 transition-all active:scale-98 ${
                      theme === "dark"
                        ? "border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/25"
                        : "border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 hover:border-slate-300"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center shrink-0">
                      <Moon size={20} />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs text-slate-900 dark:text-white">{t("settings.darkMode") || "Dark Mode"}</h4>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {t("settings.darkModeDesc") || "Deep OLED palette optimized for focus"}
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Language Picker */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  {t("settings.langTitle") || "Application UI Language"}
                </label>
                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-brand-500/10 text-brand-500 flex items-center justify-center">
                      <Globe size={16} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-xs text-slate-900 dark:text-white">{t("settings.activeLang") || "Active Language"}</h4>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                        {t("settings.langDesc") || "Translates navigation, buttons, and system dialogs"}
                      </p>
                    </div>
                  </div>

                  <select
                    value={siteLanguage}
                    onChange={(e) => setSiteLanguage(e.target.value)}
                    className="rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-brand-500 cursor-pointer shadow-xs"
                  >
                    {LANGUAGES.map((lang) => (
                      <option key={lang.uiCode} value={lang.uiCode} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
                        {lang.nativeLabel} ({lang.label})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Haptic Feedback Toggle */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  {t("settings.hapticsTitle") || "Touch & Haptics"}
                </label>
                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-fuchsia-500/10 text-fuchsia-500 flex items-center justify-center">
                      <Smartphone size={16} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-xs text-slate-900 dark:text-white">{t("settings.hapticsLabel") || "Mobile Haptic Vibrations"}</h4>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                        {t("settings.hapticsDesc") || "Gentle tactile feedback when tapping buttons and tabs"}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setHapticsEnabled(!hapticsEnabled)}
                    className={`w-12 h-6.5 rounded-full transition-colors relative p-0.5 ${
                      hapticsEnabled ? "bg-brand-500" : "bg-slate-300 dark:bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-5.5 h-5.5 rounded-full bg-white shadow-sm transition-transform ${
                        hapticsEnabled ? "translate-x-5.5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ───────────────── 2. VOICE & PERSONA TAB ───────────────── */}
          {activeTab === "voice" && (
            <div className="space-y-6 animate-fade-in">
              {/* Spoken Feedback Master Switch */}
              <div className="p-4 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-brand-500 text-white flex items-center justify-center shadow-sm">
                    {ttsEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                      {t("settings.voiceFeedbackTitle")}
                    </h4>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400">
                      {t("settings.voiceFeedbackDesc")}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setTtsEnabled(!ttsEnabled)}
                  className={`w-12 h-6.5 rounded-full transition-colors relative p-0.5 ${
                    ttsEnabled ? "bg-brand-500" : "bg-slate-300 dark:bg-white/20"
                  }`}
                >
                  <div
                    className={`w-5.5 h-5.5 rounded-full bg-white shadow-sm transition-transform ${
                      ttsEnabled ? "translate-x-5.5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Sovereign Voice Cloning Section (Gnani VC) */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {t("settings.voiceCloneTitle")}
                  </label>
                  <span className="text-[10px] text-fuchsia-500 font-semibold flex items-center gap-1">
                    <Sparkles size={11} /> Gnani Vachana VC v1
                  </span>
                </div>

                {clonedVoice ? (
                  <div
                    className={`p-4 rounded-2xl border transition-all ${
                      ttsVoice === "custom-clone"
                        ? "border-fuchsia-500 bg-gradient-to-br from-fuchsia-500/10 via-brand-500/5 to-transparent ring-2 ring-fuchsia-500/30"
                        : "border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-fuchsia-500 to-brand-500 text-white flex items-center justify-center shrink-0 shadow-md shadow-fuchsia-500/20">
                          <Mic size={20} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                              {clonedVoice.name || t("settings.myClonedVoice")}
                            </h4>
                            <span className="px-2 py-0.5 rounded-full bg-fuchsia-500 text-white text-[9px] font-bold">
                              {t("settings.tensorBadge")}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {t("settings.calibrationSample", { seconds: clonedVoice.sampleDuration || 10 })}
                          </p>
                        </div>
                      </div>

                      {/* Preview Button */}
                      <button
                        type="button"
                        onClick={() => handlePreviewVoice("custom-clone")}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all active:scale-90 ${
                          previewingVoice === "custom-clone"
                            ? "bg-fuchsia-500 text-white animate-pulse shadow-sm"
                            : "bg-slate-200/70 dark:bg-white/10 text-slate-600 dark:text-slate-300 hover:text-fuchsia-500 hover:bg-fuchsia-500/10"
                        }`}
                        title="Listen to sample of your cloned voice"
                      >
                        {previewingVoice === "custom-clone" ? (
                          previewLoading ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <Square size={13} className="fill-current" />
                          )
                        ) : (
                          <Play size={14} className="fill-current ml-0.5" />
                        )}
                      </button>
                    </div>

                    {/* Actions Row */}
                    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/10 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setTtsVoice("custom-clone")}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all active:scale-95 ${
                          ttsVoice === "custom-clone"
                            ? "bg-fuchsia-500 text-white shadow-sm shadow-fuchsia-500/25"
                            : "bg-slate-200 dark:bg-white/10 text-slate-700 dark:text-slate-200 hover:bg-fuchsia-500/10 hover:text-fuchsia-500"
                        }`}
                      >
                        {ttsVoice === "custom-clone" ? `✓ ${t("settings.activePersona")}` : t("settings.useAsActiveVoice")}
                      </button>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setIsVoiceCloneOpen(true)}
                          className="px-2.5 py-1.5 rounded-xl text-[11px] font-semibold text-slate-600 dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 active:scale-95 transition-all"
                        >
                          {t("settings.rerecord")}
                        </button>
                        <button
                          type="button"
                          onClick={deleteClonedVoice}
                          className="px-2.5 py-1.5 rounded-xl text-[11px] font-semibold text-rose-500 hover:bg-rose-500/10 active:scale-95 transition-all"
                        >
                          {t("settings.deleteVoice") || t("common.delete")}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-2xl border border-dashed border-slate-300 dark:border-white/15 bg-gradient-to-br from-fuchsia-500/5 via-brand-500/5 to-transparent flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-fuchsia-500/15 to-brand-500/15 text-fuchsia-500 flex items-center justify-center shrink-0">
                        <Sparkles size={20} />
                      </div>
                      <div>
                        <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                          {t("settings.voiceCloneTitle")}
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                          {t("settings.voiceCloneSubtitle")}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setIsVoiceCloneOpen(true)}
                      className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-brand-500 text-white font-bold text-xs shadow-md shadow-fuchsia-500/20 hover:opacity-95 active:scale-95 transition-all whitespace-nowrap self-start sm:self-auto shrink-0"
                    >
                      {t("settings.recordSampleBtn")}
                    </button>
                  </div>
                )}
              </div>

              {/* Persona Voice Grid with Audio Preview Buttons */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {t("settings.timbreCatalog")} ({TIMBRE_VOICE_OPTIONS.length})
                  </label>
                  <span className="text-[10px] text-brand-500 font-semibold flex items-center gap-1">
                    <Sparkles size={11} /> {t("settings.sovereignBadge")}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {TIMBRE_VOICE_OPTIONS.map((opt) => {
                    const isSelected = ttsVoice === opt.name;
                    const isPlayingThis = previewingVoice === opt.name;

                    return (
                      <div
                        key={opt.name}
                        onClick={() => setTtsVoice(opt.name)}
                        className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                          isSelected
                            ? "border-brand-500 bg-brand-500/10 ring-2 ring-brand-500/25"
                            : "border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 hover:border-slate-300"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs text-slate-900 dark:text-white truncate">
                              {opt.name}
                            </span>
                            {isSelected && (
                              <span className="px-1.5 py-0.2 rounded-full bg-brand-500 text-white text-[9px] font-bold">
                                {t("settings.activeBadge")}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            {opt.label.replace(`${opt.name} `, "")}
                          </p>
                        </div>

                        {/* Preview Audio Play Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePreviewVoice(opt.name);
                          }}
                          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all active:scale-90 ${
                            isPlayingThis
                              ? "bg-brand-500 text-white animate-pulse shadow-sm"
                              : "bg-slate-200/70 dark:bg-white/10 text-slate-600 dark:text-slate-300 hover:text-brand-500 hover:bg-brand-500/10"
                          }`}
                          aria-label={`Preview voice for ${opt.name}`}
                          title={`Listen to sample audio of ${opt.name}`}
                        >
                          {isPlayingThis ? (
                            previewLoading ? (
                              <Loader2 size={15} className="animate-spin" />
                            ) : (
                              <Square size={13} className="fill-current" />
                            )
                          ) : (
                            <Play size={14} className="fill-current ml-0.5" />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Speech Recognition Engine Details */}
              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between">
                <div>
                  <h4 className="font-semibold text-xs text-slate-900 dark:text-white">
                    Gnani Prisma v3.0 Automatic Language Identification
                  </h4>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Real-time Indic code-mix detection (Hindi, English, Hinglish, Tamil, Telugu)
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Auto-LID Active
                </span>
              </div>
            </div>
          )}

          {/* ───────────────── 3. ACCOUNT & PROFILE TAB ───────────────── */}
          {activeTab === "account" && (
            <div className="space-y-6 animate-fade-in">
              {/* User Identity Card */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white font-bold text-lg flex items-center justify-center shadow-md">
                  {isAuthenticated ? "U" : "G"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                      {isAuthenticated ? t("settings.registeredAccount") : t("settings.guestMode")}
                    </h3>
                    <span
                      className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${
                        isAuthenticated
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {isAuthenticated ? t("settings.activeSession") : t("settings.guestSandbox")}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {isAuthenticated ? t("settings.fullCloudNotice") : t("settings.guestSessionNotice")}
                  </p>
                </div>
              </div>

              {/* User ID / Session ID Card */}
              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    {t("settings.sessionId")}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyUserId}
                    className="text-[11px] text-brand-500 font-semibold hover:underline flex items-center gap-1"
                  >
                    {copiedId ? (
                      <>
                        <Check size={12} className="text-emerald-500" />
                        <span>{t("common.copied")}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        <span>{t("common.copy")}</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="font-mono text-xs text-slate-700 dark:text-slate-300 break-all select-all">
                  {userId || "00000000-0000-0000-0000-000000000000"}
                </p>
              </div>

              {/* Account Action Buttons */}
              <div className="pt-2">
                {isGuest ? (
                  <button
                    type="button"
                    onClick={() => {
                      closeSettings();
                      navigate("/auth");
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-brand-500 text-white font-bold text-xs shadow-md shadow-brand-500/25 active:scale-98 transition-all"
                  >
                    <LogIn size={16} />
                    <span>{t("settings.signInOrCreate")}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      await signOut();
                      closeSettings();
                      navigate("/");
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/15 font-bold text-xs active:scale-98 transition-all"
                  >
                    <LogOut size={16} />
                    <span>{t("settings.signOut")}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ───────────────── 4. AI & SOVEREIGN SAFETY TAB ───────────────── */}
          {activeTab === "safety" && (
            <div className="space-y-6 animate-fade-in">
              {/* High-Risk Confirmation Toggle */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
                    <Shield size={20} />
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                      {t("settings.highRiskTitle")}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {t("settings.highRiskDesc")}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmHighRisk(!confirmHighRisk)}
                  className={`w-12 h-6.5 rounded-full transition-colors relative p-0.5 shrink-0 ${
                    confirmHighRisk ? "bg-brand-500" : "bg-slate-300 dark:bg-white/20"
                  }`}
                >
                  <div
                    className={`w-5.5 h-5.5 rounded-full bg-white shadow-sm transition-transform ${
                      confirmHighRisk ? "translate-x-5.5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Auto-Heal Workflows Toggle */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-fuchsia-500/15 text-fuchsia-500 flex items-center justify-center shrink-0">
                    <Zap size={20} />
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                      {t("settings.autoHealTitle")}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {t("settings.autoHealDesc")}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setAutoHeal(!autoHeal)}
                  className={`w-12 h-6.5 rounded-full transition-colors relative p-0.5 shrink-0 ${
                    autoHeal ? "bg-brand-500" : "bg-slate-300 dark:bg-white/20"
                  }`}
                >
                  <div
                    className={`w-5.5 h-5.5 rounded-full bg-white shadow-sm transition-transform ${
                      autoHeal ? "translate-x-5.5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Clear App Cache */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-bold text-xs text-slate-900 dark:text-white">
                    {t("settings.clearCacheTitle")}
                  </h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {t("settings.clearCacheDesc")}
                  </p>
                  {resetSuccess && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1">
                      <CheckCircle2 size={13} /> {t("settings.cacheCleared")}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleClearCache}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 hover:border-red-300 active:scale-95 transition-all shrink-0"
                >
                  <Trash2 size={14} className="inline mr-1" />
                  {t("settings.resetCacheBtn")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Voice Clone Calibration Modal */}
      <VoiceCloneModal
        isOpen={isVoiceCloneOpen}
        onClose={() => setIsVoiceCloneOpen(false)}
      />
    </div>
  );
}

