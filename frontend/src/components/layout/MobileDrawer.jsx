import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import { NAV_ITEMS } from "../../config/nav";

export default function MobileDrawer({ open, onClose }) {
  const { t } = useTranslation();
  return (
    <div
      className={`md:hidden fixed inset-0 z-50 transition-opacity ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`absolute top-0 left-0 h-full w-72 glass border-r border-slate-200/70 dark:border-white/10 transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between h-16 px-4 border-b border-slate-200/70 dark:border-white/10">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white">
              <Sparkles size={18} />
            </div>
            <span className="font-semibold text-lg tracking-tight">
              VoxAgent<span className="text-brand-500">.</span>
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("header.openMenu")}
          >
            <X size={20} />
          </button>
        </div>
        <nav className="p-3 space-y-1">
          {NAV_ITEMS.map(({ to, labelKey, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brand-500/10 text-brand-600 dark:text-brand-300"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`
              }
            >
              <Icon size={19} />
              <span>{t(labelKey)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
