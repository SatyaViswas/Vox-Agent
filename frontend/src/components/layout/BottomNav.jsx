import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, KeyRound, Mic, MoreHorizontal, Zap } from "lucide-react";

export default function BottomNav({ onVoiceClick, onMoreClick }) {
  const { t } = useTranslation();

  const handleNavClick = () => {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(20);
    }
  };

  const handleVoice = () => {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate([30, 20, 30]);
    }
    onVoiceClick?.();
  };

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/90 dark:bg-[#0e0e18]/95 backdrop-blur-2xl border-t border-slate-200/80 dark:border-white/10 pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_25px_rgba(0,0,0,0.06)]">
      <div className="relative flex items-center justify-around px-2 pt-1.5 pb-2">
        {/* 1. Studio */}
        <NavLink
          to="/studio"
          onClick={handleNavClick}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium transition-all active:scale-90 ${
              isActive
                ? "text-brand-500 font-bold"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Zap size={20} className="shrink-0" />
              <span className="truncate">{t("nav.studioShort") || "Studio"}</span>
              <span className={`w-1 h-1 rounded-full bg-brand-500 transition-opacity ${isActive ? "opacity-100" : "opacity-0"}`} />
            </>
          )}
        </NavLink>

        {/* 2. Agents */}
        <NavLink
          to="/agents"
          onClick={handleNavClick}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium transition-all active:scale-90 ${
              isActive
                ? "text-brand-500 font-bold"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Bot size={20} className="shrink-0" />
              <span className="truncate">{t("nav.agentsShort") || "Agents"}</span>
              <span className={`w-1 h-1 rounded-full bg-brand-500 transition-opacity ${isActive ? "opacity-100" : "opacity-0"}`} />
            </>
          )}
        </NavLink>

        {/* 3. Center Elevated Voice Orb FAB */}
        <div className="flex-1 flex flex-col items-center justify-center relative -top-3">
          <button
            type="button"
            onClick={handleVoice}
            aria-label="Activate Voice Assistant"
            className="flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-tr from-brand-600 via-brand-500 to-fuchsia-500 text-white shadow-[0_6px_20px_rgba(109,84,255,0.45)] ring-4 ring-white dark:ring-[#0e0e18] transition-transform active:scale-90 animate-voice-glow"
          >
            <Mic size={24} className="animate-pulse" />
          </button>
          <span className="text-[9px] font-semibold tracking-wider text-brand-600 dark:text-brand-400 uppercase mt-0.5">
            Voice
          </span>
        </div>

        {/* 4. Vault */}
        <NavLink
          to="/vault"
          onClick={handleNavClick}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium transition-all active:scale-90 ${
              isActive
                ? "text-brand-500 font-bold"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <KeyRound size={20} className="shrink-0" />
              <span className="truncate">{t("nav.vaultShort") || "Vault"}</span>
              <span className={`w-1 h-1 rounded-full bg-brand-500 transition-opacity ${isActive ? "opacity-100" : "opacity-0"}`} />
            </>
          )}
        </NavLink>

        {/* 5. More (Drawer / Sheets) */}
        <button
          type="button"
          onClick={() => {
            handleNavClick();
            onMoreClick?.();
          }}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-all active:scale-90"
        >
          <MoreHorizontal size={20} className="shrink-0" />
          <span className="truncate">{t("common.more") || "More"}</span>
          <span className="w-1 h-1 opacity-0" />
        </button>
      </div>
    </nav>
  );
}
