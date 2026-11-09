import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, Brain, Globe, KeyRound, Moon, Notebook, Settings, Sparkles, Sun, X, Zap } from "lucide-react";
import { useTheme } from "../../context/ThemeContext";
import { useLanguage } from "../../context/LanguageContext";
import { useAuth } from "../../context/AuthContext";
import { useSettings } from "../../context/SettingsContext";
import { LANGUAGES } from "../../i18n/languages";

const ALL_NAV_LINKS = [
  { to: "/studio", label: "Agent Studio", desc: "Voice workflow creation", icon: Zap },
  { to: "/agents", label: "My Agents", desc: "Scheduled & active workflows", icon: Bot },
  { to: "/vault", label: "App Vault", desc: "500+ connected SaaS integrations", icon: KeyRound },
  { to: "/knowledge", label: "Knowledge Hub", desc: "Sovereign RAG documents", icon: Brain },
  { to: "/notes", label: "Vault Notes", desc: "Encrypted notes & credentials", icon: Notebook },
];

export default function MobileDrawer({ open, onClose }) {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const { siteLanguage, setSiteLanguage } = useLanguage();
  const { isAuthenticated, isGuest } = useAuth();
  const { openSettings } = useSettings();

  return (
    <div
      className={`md:hidden fixed inset-0 z-50 transition-opacity duration-300 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Dimmed backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Slide-in native drawer */}
      <div
        className={`absolute top-0 right-0 h-full w-[85%] max-w-xs bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-white/10 p-5 text-slate-900 dark:text-white flex flex-col justify-between transition-transform duration-300 shadow-2xl pt-[max(env(safe-area-inset-top),1.25rem)] pb-[max(env(safe-area-inset-bottom),1.25rem)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-white/10">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white shadow-md">
                <Sparkles size={18} />
              </div>
              <div>
                <span className="font-semibold text-base tracking-tight block text-slate-900 dark:text-white">
                  VoxAgent<span className="text-brand-500">.</span>
                </span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 block -mt-0.5">
                  Voice-First SaaS Studio
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          </div>

          {/* Navigation Items */}
          <div className="mt-4 space-y-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500 px-3 block mb-2">
              Navigation
            </span>
            {ALL_NAV_LINKS.map(({ to, label, desc, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all active:scale-[0.98] ${
                    isActive
                      ? "bg-brand-500/10 dark:bg-brand-500/20 text-brand-600 dark:text-brand-300 border border-brand-500/30"
                      : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5"
                  }`
                }
              >
                <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-white/5 text-brand-500 dark:text-brand-400">
                  <Icon size={16} />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">{label}</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">{desc}</span>
                </div>
              </NavLink>
            ))}
          </div>
        </div>

        {/* Bottom Quick Settings */}
        <div className="pt-4 border-t border-slate-200 dark:border-white/10 space-y-2.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              openSettings("general");
            }}
            className="w-full flex items-center justify-between rounded-xl bg-brand-500/10 hover:bg-brand-500/15 border border-brand-500/20 p-2.5 px-3 text-xs font-semibold text-brand-600 dark:text-brand-300 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Settings size={16} className="text-brand-500" />
              <span>Settings (Voice, Language, Theme)</span>
            </div>
            <span className="text-[11px] text-brand-500 font-bold">Open →</span>
          </button>

          {/* Status Badge */}
          <div className="flex items-center justify-between px-2 text-[11px] text-slate-500 dark:text-slate-400 pt-1">
            <span>Session Status</span>
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse" />
              {isAuthenticated ? "Signed In" : "Guest Mode Active"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
