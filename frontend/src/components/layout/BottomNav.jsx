import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NAV_ITEMS } from "../../config/nav";

export default function BottomNav() {
  const { t } = useTranslation();
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 glass border-t border-slate-200/70 dark:border-white/10 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch justify-between">
        {NAV_ITEMS.map(({ to, shortLabelKey, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
                isActive ? "text-brand-500" : "text-slate-500 dark:text-slate-400"
              }`
            }
          >
            <Icon size={20} />
            <span className="truncate">{t(shortLabelKey)}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
