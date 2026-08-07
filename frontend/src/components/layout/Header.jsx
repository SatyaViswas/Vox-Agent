import { Menu, Moon, Settings, Sun, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { useLanguage } from "../../context/LanguageContext";
import LanguageDropdown from "../shared/LanguageDropdown";
import NotificationsDropdown from "./NotificationsDropdown";

export default function Header({ onMenuClick }) {
  const { isGuest, isAuthenticated } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { siteLanguage, setSiteLanguage } = useLanguage();
  const { t } = useTranslation();

  return (
    <header className="sticky top-0 z-30 h-16 flex items-center gap-3 px-4 md:px-6 glass border-b border-slate-200/70 dark:border-white/10">
      <button
        onClick={onMenuClick}
        className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
        aria-label={t("header.openMenu")}
      >
        <Menu size={20} />
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium glass">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isAuthenticated ? "bg-emerald-500" : "bg-emerald-500 animate-pulse"
          }`}
        />
        <span className="text-slate-600 dark:text-slate-300 hidden sm:inline">
          {isAuthenticated ? t("header.loggedIn") : t("header.guestSession")}
        </span>
      </div>

      <button
        onClick={toggleTheme}
        aria-label={t("header.toggleTheme")}
        className="flex items-center justify-center w-9 h-9 rounded-full text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <LanguageDropdown
        value={siteLanguage}
        onChange={setSiteLanguage}
        trigger={<Settings size={18} aria-label={t("header.settings")} />}
      />

      <NotificationsDropdown />

      {isGuest ? (
        <button className="flex items-center gap-1.5 rounded-full bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2 transition-colors">
          <User size={15} />
          <span>{t("header.signIn")}</span>
        </button>
      ) : (
        <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white text-sm font-semibold">
          U
        </div>
      )}
    </header>
  );
}
