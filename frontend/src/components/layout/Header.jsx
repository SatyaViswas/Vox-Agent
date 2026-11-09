import { useLocation } from "react-router-dom";
import { Menu, Settings, Sparkles, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { useSettings } from "../../context/SettingsContext";
import NotificationsDropdown from "./NotificationsDropdown";

export default function Header({ onMenuClick }) {
  const { isGuest, isAuthenticated } = useAuth();
  const { openSettings } = useSettings();
  const { t } = useTranslation();
  const location = useLocation();

  const getPageTitle = (pathname) => {
    if (pathname.startsWith("/studio")) return "Agent Studio";
    if (pathname.startsWith("/agents")) return "My Agents";
    if (pathname.startsWith("/vault")) return "App Vault";
    if (pathname.startsWith("/knowledge")) return "Knowledge Hub";
    if (pathname.startsWith("/notes")) return "Vault Notes";
    return "VoxAgent";
  };
  const pageTitle = getPageTitle(location.pathname);

  return (
    <header className="sticky top-0 z-30 flex items-center px-4 md:px-6 glass border-b border-slate-200/70 dark:border-white/10 pt-[env(safe-area-inset-top,0px)] h-[calc(3.5rem+env(safe-area-inset-top,0px))] md:h-16 transition-all">
      {/* Mobile-Native App Bar (< md) */}
      <div className="md:hidden flex items-center justify-between w-full">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onMenuClick}
            className="flex items-center justify-center w-9 h-9 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/10 active:scale-90 transition-transform"
            aria-label="Open navigation menu"
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-fuchsia-500 flex items-center justify-center text-white shadow-xs">
              <Sparkles size={14} />
            </div>
            <span className="font-bold text-base tracking-tight text-slate-900 dark:text-white">
              VoxAgent
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <NotificationsDropdown />

          <button
            type="button"
            onClick={() => openSettings("account")}
            className="flex items-center justify-center active:scale-90 transition-transform cursor-pointer"
            aria-label="Open account settings"
            title="Account & Settings"
          >
            {isGuest ? (
              <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-white/10 flex items-center justify-center text-slate-600 dark:text-slate-300 text-xs font-semibold hover:ring-2 hover:ring-brand-500/40">
                <User size={15} />
              </div>
            ) : (
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white text-xs font-semibold shadow-sm hover:ring-2 hover:ring-brand-500/40">
                U
              </div>
            )}
          </button>
        </div>
      </div>

      {/* Desktop App Bar (>= md) */}
      <div className="hidden md:flex items-center gap-3 w-full">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-lg tracking-tight text-slate-800 dark:text-slate-100">
            {pageTitle}
          </h1>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium glass">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isAuthenticated ? "bg-emerald-500" : "bg-emerald-500 animate-pulse"
            }`}
          />
          <span className="text-slate-600 dark:text-slate-300">
            {isAuthenticated ? t("header.loggedIn") : t("header.guestSession")}
          </span>
        </div>

        {/* Settings Shortcut Button */}
        <button
          type="button"
          onClick={() => openSettings("general")}
          aria-label="Open settings"
          title="App Settings (Theme, Language, Voice)"
          className="flex items-center justify-center w-9 h-9 rounded-full text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
        >
          <Settings size={18} />
        </button>

        <NotificationsDropdown />

        {/* Clickable Account Profile */}
        <button
          type="button"
          onClick={() => openSettings("account")}
          className="flex items-center gap-2 rounded-full p-0.5 hover:ring-2 hover:ring-brand-500/40 transition-all cursor-pointer"
          title="Account Profile & Settings"
        >
          {isGuest ? (
            <div className="flex items-center gap-1.5 rounded-full bg-brand-500/10 hover:bg-brand-500/20 text-brand-600 dark:text-brand-400 text-xs font-medium px-3 py-1.5 transition-colors">
              <User size={14} />
              <span>{t("header.guestSession")}</span>
            </div>
          ) : (
            <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white text-sm font-semibold shadow-sm">
              U
            </div>
          )}
        </button>
      </div>
    </header>
  );
}
