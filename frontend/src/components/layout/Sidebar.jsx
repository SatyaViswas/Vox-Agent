import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsLeft, ChevronsRight, Sparkles, LogOut, LogIn } from "lucide-react";
import { NAV_ITEMS } from "../../config/nav";
import { useAuth } from "../../context/AuthContext";

export default function Sidebar({ collapsed, onToggle }) {
  const { isGuest, signOut } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleAuthAction = async () => {
    if (isGuest) {
      navigate("/auth");
    } else {
      await signOut();
      navigate("/");
    }
  };
  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 h-screen sticky top-0 glass border-r border-slate-200/70 dark:border-white/10 transition-[width] duration-200 ${
        collapsed ? "w-[76px]" : "w-64"
      }`}
    >
      <div className="flex items-center gap-2 px-4 h-16 border-b border-slate-200/70 dark:border-white/10">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white shrink-0">
          <Sparkles size={18} />
        </div>
        {!collapsed && (
          <span className="font-semibold text-lg tracking-tight whitespace-nowrap overflow-hidden">
            VoxAgent<span className="text-brand-500">.</span>
          </span>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-none">
        {NAV_ITEMS.map(({ to, labelKey, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? t(labelKey) : undefined}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-brand-500/10 text-brand-600 dark:text-brand-300"
                  : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
              }`
            }
          >
            <Icon size={19} className="shrink-0" />
            {!collapsed && <span className="truncate">{t(labelKey)}</span>}
          </NavLink>
        ))}
      </nav>

      <button
        onClick={handleAuthAction}
        className="flex items-center gap-2 px-4 h-12 border-t border-slate-200/70 dark:border-white/10 text-slate-500 hover:text-brand-500 text-sm transition-colors shrink-0"
        title={collapsed ? (isGuest ? t("nav.signIn") : t("nav.logOut")) : undefined}
      >
        {isGuest ? <LogIn size={18} /> : <LogOut size={18} />}
        {!collapsed && <span>{isGuest ? t("nav.signIn") : t("nav.logOut")}</span>}
      </button>

      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-4 h-12 border-t border-slate-200/70 dark:border-white/10 text-slate-500 hover:text-brand-500 text-sm transition-colors"
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
        {!collapsed && <span>{t("nav.collapse")}</span>}
      </button>
    </aside>
  );
}
